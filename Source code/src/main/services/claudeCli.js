import fs from 'fs'
import os from 'os'
import path from 'path'
import { isShellSafeValue, isValidServerName } from '../../shared/mcp'
import { launchInTerminal } from './terminalLauncher'
import * as configFile from './configFile'
import { cliError, run } from './procRun'
import { launchSpecFor, sortVersionedDirs } from './cliDiscovery'
import { parseMcpGetOutput } from './mcpGetOutput'
import { createCliResolver } from './cliResolver'
import * as settings from './settings'
import * as log from './logger'

const isWindows = process.platform === 'win32'

// Budget for read-only CLI calls (`--version`, `mcp get`). Registration and
// removal keep the longer default in runRaw: they do real work, and a timeout
// there would leave the configuration half-written.
const READ_TIMEOUT_MS = 20000

/**
 * Why this service exists at all:
 *
 * Claude Code never stores an OAuth client secret in `~/.claude.json` — it keeps
 * it in the OS keychain (macOS) or an internal credentials file. The only
 * supported way to put a secret there is the CLI:
 *
 *   MCP_CLIENT_SECRET=<secret> claude mcp add-json <name> <json> --client-secret
 *
 * Writing the JSON ourselves registers the server but leaves the secret absent,
 * so the browser login succeeds and the token exchange then fails with
 * `invalid_client` — which surfaces as /mcp hanging on
 * "Completing authentication in browser...". Servers whose OAuth client is
 * confidential (no `none` in token_endpoint_auth_methods_supported, and no
 * dynamic client registration) therefore MUST be registered through the CLI.
 *
 * See https://code.claude.com/docs/en/mcp — "Use pre-configured OAuth credentials".
 */

const runRaw = run

// Colour codes would break the `Status:` / `OAuth:` line matching in getServer.
// The CLI has no reason to emit them when its stdout isn't a TTY, but say so
// explicitly rather than depending on that.
const READ_ENV = { NO_COLOR: '1', FORCE_COLOR: '0' }

/**
 * Run the resolved claude binary. A global npm install exposes `claude` as a
 * `.cmd` shim (and a `.ps1`, and an extensionless Bourne script), none of which
 * execFile can launch directly; launchSpecFor works out the right route.
 *
 * SECURITY: that route is not self-escaping. Node escapes `"` as `\"` for the
 * Windows C runtime, but cmd.exe reads the `"` as closing the quote and then
 * treats the rest as its own metacharacters — so an argument containing `"`
 * followed by `&` runs a second command. Every value that reaches here is
 * therefore validated first (safeName / safeEntry below); do not pass an
 * unvalidated string into this function.
 */
function runClaude(bin, args, opts) {
  const spec = launchSpecFor(bin, process.platform)
  // PowerShell's metacharacters aren't the set safeEntry screens for, so the
  // .ps1 route gets a stricter check. It should be unreachable in practice —
  // npm writes claude.cmd alongside claude.ps1 and the .cmd ranks higher — so
  // this only bites a manual override pointing straight at the .ps1.
  if (spec.kind === 'ps1') assertPowerShellSafe(args)
  return runRaw(spec.file, [...spec.prefix, ...args], opts)
}

const PS_SAFE = /^[\w.\-:/?=&%+~@ ]*$/

function assertPowerShellSafe(args) {
  for (const arg of args) {
    if (!PS_SAFE.test(String(arg))) {
      throw new Error(
        'This connection cannot be passed to the PowerShell version of the Claude Code CLI. ' +
          'Point the Claude CLI path setting at claude.exe or claude.cmd instead.'
      )
    }
  }
}

/**
 * Gate for the one value every CLI call puts on the command line. Names read
 * from a shared `.mcp.json` are third-party input, so this is a hard reject
 * rather than a best-effort escape — see isValidServerName in shared/mcp.js.
 */
function safeName(name) {
  if (!isValidServerName(name)) {
    throw new Error(
      `"${String(name).slice(0, 40)}" is not a usable MCP server name. Use letters, digits, ` +
        'spaces, dot, dash or underscore only, starting with a letter or digit (max 64 ' +
        'characters). Rename it in the configuration file to manage it here.'
    )
  }
  return name
}

/**
 * The entry JSON crosses cmd.exe too. Its structural quotes are balanced and
 * survive that trip, but a metacharacter inside a *value* would not, so check
 * each one rather than trusting the JSON shape.
 */
function safeEntry(entry) {
  const oauth = (entry && entry.oauth) || {}
  const values = [entry && entry.url, oauth.clientId, oauth.authServerMetadataUrl, oauth.scopes]
  for (const value of values) {
    if (!isShellSafeValue(String(value ?? ''))) {
      throw new Error(
        'This connection contains characters that cannot be passed to the Claude Code CLI ' +
          '(one of: " & | < > ^ or a line break). Check the URL, client ID and scopes.'
      )
    }
  }
  if (!Number.isInteger(oauth.callbackPort) || oauth.callbackPort < 1 || oauth.callbackPort > 65535) {
    throw new Error('The callback port must be a whole number between 1 and 65535.')
  }
  return entry
}

const VSCODE_EXTENSION_PREFIX = 'anthropic.claude-code-'

function vsCodeExtensionCandidates() {
  // The VS Code extension ships its own native binary; useful when the CLI was
  // never added to PATH. Insiders and the Remote/WSL server keep their
  // extensions in sibling directories, so check all of them.
  const home = os.homedir()
  const roots = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.vscode-server', 'extensions')
  ]
  const out = []
  for (const extRoot of roots) {
    let entries
    try {
      entries = fs.readdirSync(extRoot)
    } catch {
      continue // no such extensions directory
    }
    // readdirSync order would put "1.0.9" above "1.0.10", handing back an older
    // bundled binary than the one actually installed.
    for (const dir of sortVersionedDirs(entries, VSCODE_EXTENSION_PREFIX)) {
      out.push(
        path.join(extRoot, dir, 'resources', 'native-binary', isWindows ? 'claude.exe' : 'claude')
      )
    }
  }
  return out
}

function staticCandidates() {
  const home = os.homedir()
  const { LOCALAPPDATA = '', APPDATA = '' } = process.env
  if (isWindows) {
    return [
      // Native installer.
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'),
      // `claude migrate-installer` — present in the POSIX list from the start,
      // but it has a Windows layout too.
      path.join(home, '.claude', 'local', 'claude.exe'),
      path.join(home, '.claude', 'local', 'claude.cmd'),
      // Global installs, per package manager. Always name the runnable shim:
      // the extensionless sibling npm writes next to these cannot be launched.
      path.join(APPDATA, 'npm', 'claude.cmd'),
      path.join(LOCALAPPDATA, 'pnpm', 'claude.exe'),
      path.join(LOCALAPPDATA, 'pnpm', 'claude.cmd'),
      path.join(home, '.bun', 'bin', 'claude.exe'),
      path.join(LOCALAPPDATA, 'Volta', 'bin', 'claude.exe'),
      path.join(LOCALAPPDATA, 'Yarn', 'bin', 'claude.cmd')
    ]
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/home/linuxbrew/.linuxbrew/bin/claude',
    '/usr/bin/claude',
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.bun', 'bin', 'claude'),
    path.join(home, '.volta', 'bin', 'claude')
  ]
}

/**
 * The resolver owns locating the binary and proving it runs. Its filesystem and
 * subprocess access is injected so the ordering, shim-repair and caching rules
 * can be tested against a fake machine — see cliResolver.js.
 */
const resolver = createCliResolver({
  command: 'claude',
  displayName: 'The Claude Code CLI',
  staticCandidates,
  extraCandidates: vsCodeExtensionCandidates,
  // A path the user set by hand wins over anything we'd guess, and a wrong one
  // is reported rather than silently ignored.
  readOverride: () => settings.readSettings().claudeCliPath || null,
  // "Which CLI did it find, and what else did it try" is the first question
  // any report about this app raises, so it belongs in the log by default.
  onResolved: (r) => {
    if (r.healthy) {
      log.info('claudeCli', `using ${r.path} (v${r.version}, ${r.source}/${r.launchKind})`)
    } else {
      log.warn('claudeCli', `no usable CLI (${r.reason})`, r.detail)
    }
  },
  deps: {
    exists: (p) => fs.existsSync(p),
    run,
    platform: process.platform,
    env: process.env,
    homedir: () => os.homedir()
  }
})

/**
 * Drop the cached binary. Called when a run against it fails to spawn (the CLI
 * was uninstalled, upgraded or moved mid-session) and when the user changes the
 * path setting.
 */
export function invalidateResolution() {
  resolver.invalidate()
}

export async function resolveClaude({ refresh = false } = {}) {
  return resolver.resolve({ refresh })
}

/**
 * Find the CLI and prove it actually runs.
 *
 * `found` means a candidate exists on disk; `healthy` means `--version`
 * succeeded and produced a version. The two used to be conflated, so a global
 * npm install — whose PATH entry is a Bourne shim Windows cannot execute —
 * reported "Found" and then failed every subsequent operation with an empty
 * error message. Anything unhealthy now carries a `message` explaining why, and
 * `candidates` records everywhere we looked.
 */
export async function detect() {
  return resolver.detect({ refresh: true })
}

// We use the CLI's own scope names internally (`user` | `local` | `project`),
// so there's nothing to translate — this just guards against an unknown value
// reaching the command line. See SCOPES in src/shared/mcp.js for why we don't
// use the CLI's retired "global"/"project" wording.
const CLI_SCOPES = new Set(['user', 'local', 'project'])

function cliScopeFor(scope) {
  if (!CLI_SCOPES.has(scope)) {
    throw new Error(`Unknown install scope "${scope}".`)
  }
  return scope
}

/**
 * `local` and `project` are both resolved against the working directory, so the
 * CLI has to run from inside the target project. `user` is machine-wide.
 */
function cwdFor(scope, projectPath) {
  return scope !== 'user' && projectPath ? projectPath : os.homedir()
}

/**
 * If the binary we cached can no longer be spawned, forget it. The CLI was
 * uninstalled, upgraded into a different directory, or the VS Code extension
 * that provided it was updated — all of which are recoverable by resolving
 * again, and none of which should mean every operation fails until restart.
 */
function noteSpawnFailure(res) {
  if (res && res.failure === 'spawn') invalidateResolution()
}

/**
 * Register the server through the CLI so the client secret lands in Claude
 * Code's credential store. Removes any existing entry of the same name first so
 * re-running the wizard is idempotent (and replaces a malformed entry).
 */
export async function registerServer({ name, entry, scope, projectPath, clientSecret }) {
  safeName(name)
  safeEntry(entry)
  const bin = await resolveClaude()
  if (!bin) {
    throw new Error(
      'Claude Code CLI not found. It is required to store the OAuth client secret, ' +
        'which Claude Code keeps in your keychain rather than in the config file.'
    )
  }

  const cliScope = cliScopeFor(scope)
  const cwd = cwdFor(scope, projectPath)

  // Capture whatever is registered under this name BEFORE removing it. The
  // remove-then-add sequence below is not atomic, so a failed add used to
  // destroy a working connection outright: the entry was already gone, with
  // nothing to put back. Reached from add, applyScopeRefresh, duplicate and
  // rename, so the blast radius was wide.
  let previous = null
  try {
    previous = configFile.readServerEntry({ scope, projectPath, name })
  } catch {
    // Unreadable config: the add below will fail on its own and say why. Not
    // being able to snapshot is not itself a reason to refuse.
  }

  // Best-effort removal; a missing entry is not an error we care about.
  await runClaude(bin, ['mcp', 'remove', name, '-s', cliScope], { cwd })

  const args = ['mcp', 'add-json', name, JSON.stringify(entry), '--scope', cliScope]
  const env = {}
  if (clientSecret) {
    // --client-secret normally prompts; MCP_CLIENT_SECRET supplies it
    // non-interactively, which is what we need from a GUI.
    args.push('--client-secret')
    env.MCP_CLIENT_SECRET = clientSecret
  }

  const res = await runClaude(bin, args, { cwd, env })
  if (!res.ok) {
    // cliError keeps the CLI's own output when it exited cleanly with a
    // complaint, and substitutes an explanation when it never ran at all —
    // which used to produce an Error with no message.
    noteSpawnFailure(res)
    const err = cliError(res, 'Could not register the connection with Claude Code')
    const restored = await restorePrevious({ bin, name, cliScope, cwd, previous })
    if (restored === false) {
      err.message +=
        ` The previous configuration for "${name}" could not be restored either, so it is ` +
        'no longer registered. Add it again to recover it.'
    }
    throw err
  }
  return { ok: true, output: res.stdout, cliScope, cwd }
}

/**
 * Put back what the pre-emptive remove took away.
 *
 * Only reachable when the add failed, so this is a best-effort repair of a
 * situation that is already an error — it never turns a failure into a success,
 * it just stops one failure from also deleting a working connection.
 *
 * Returns null when there was nothing to restore, true on success, false when
 * the restore itself failed (so the caller can say so). The client secret is
 * deliberately not re-supplied: Claude Code won't hand its copy back, so it
 * isn't ours to replay here. The entry returns; the caller's own stored secret
 * covers re-registration.
 */
async function restorePrevious({ bin, name, cliScope, cwd, previous }) {
  if (!previous || !previous.entry) return null
  try {
    const res = await runClaude(
      bin,
      ['mcp', 'add-json', name, JSON.stringify(previous.entry), '--scope', cliScope],
      { cwd }
    )
    return res.ok
  } catch {
    return false
  }
}

/**
 * Read back what Claude Code has registered. The `OAuth:` line is what proves
 * the secret was stored — it reads
 * "client_id configured, client_secret configured, callback_port 8080".
 */
export async function getServer({ name, scope, projectPath }) {
  safeName(name)
  const bin = await resolveClaude()
  if (!bin) throw new Error('Claude Code CLI not found.')
  const cwd = cwdFor(scope, projectPath)
  // A read the connections list runs once per connection, so it gets a much
  // tighter budget than the 90 s default: one unreachable server must not hold
  // the whole list up, and the CLI either answers in seconds or is stuck.
  const res = await runClaude(bin, ['mcp', 'get', name], {
    cwd,
    timeoutMs: READ_TIMEOUT_MS,
    env: READ_ENV
  })
  if (!res.ok) {
    noteSpawnFailure(res)
    // Distinguish "the CLI answered and doesn't know this server" from "the CLI
    // never ran". Both used to arrive here as an empty `raw`, and deriveStatus
    // reported both as "Claude Code does not report this server."
    return {
      found: false,
      raw: res.stderr || res.stdout,
      failure: res.failure,
      // A read that never executed says nothing about the connection, so let
      // deriveStatus surface the real reason instead of guessing.
      unreachable: res.failure !== 'exit',
      unreachableReason: res.failure !== 'exit' ? res.message : null,
      clientSecretConfigured: false
    }
  }
  const raw = res.stdout
  // Parsed by a separate pure module so the CLI's output shape can be pinned
  // down by tests against recorded output — see mcpGetOutput.js.
  return { found: true, raw, ...parseMcpGetOutput(raw) }
}

/**
 * Start the OAuth flow by running `claude mcp login <name>` in a real terminal
 * window.
 *
 * Why a terminal rather than a child process: `claude mcp login` checks that
 * stdin is a TTY up front and aborts with "stdin isn't a terminal, so
 * authentication can't be completed here". An Electron app has no terminal
 * attached, and piping, ignoring and inheriting stdio all fail that check
 * (verified against the CLI). Letting the OS open a real terminal is the only
 * dependency-free way to give the CLI the TTY it demands. node-pty would also
 * work, but it is a native module needing a C++ toolchain on every build
 * machine — the same maintenance burden PLAN.md rejected keytar for.
 *
 * The CLI then opens the browser, listens on the callback port, and completes
 * the token exchange with the stored client secret. Callers poll getServer()
 * to detect success, so the terminal is a transient helper the user never has
 * to interact with.
 */
export async function startLogin({ name, scope, projectPath }) {
  // SECURITY: `name` and the project path can both come from a `.mcp.json`
  // committed to a shared repository, so neither is trusted. safeName() is
  // the boundary; launchInTerminal's own quoting is defence in depth.
  safeName(name)
  const bin = await resolveClaude()
  if (!bin) throw new Error('Claude Code CLI not found.')
  const cwd = cwdFor(scope, projectPath)
  return launchInTerminal({ cwd, bin, args: ['mcp', 'login', name] })
}

export async function removeServer({ name, scope, projectPath }) {
  safeName(name)
  const bin = await resolveClaude()
  if (!bin) throw new Error('Claude Code CLI not found.')
  const cwd = cwdFor(scope, projectPath)
  const res = await runClaude(bin, ['mcp', 'remove', name, '-s', cliScopeFor(scope)], { cwd })
  noteSpawnFailure(res)
  // Callers verify the removal against the config rather than trusting this, but
  // they report `output` when it failed — so make sure it says something.
  return { ok: res.ok, output: res.stdout || res.stderr || res.message || '' }
}
