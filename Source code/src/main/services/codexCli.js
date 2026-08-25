import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isShellSafeValue, isValidServerName } from '../../shared/mcp'
import { launchInTerminal } from './terminalLauncher'
import * as log from './logger'

const isWindows = process.platform === 'win32'

const READ_TIMEOUT_MS = 20000

/**
 * Why this service exists, and how it differs from claudeCli.js:
 *
 * Codex CLI's OAuth support (confirmed against a real `codex` 0.146.0 install —
 * `codex mcp add --help` / `codex mcp login --help`) has no client-secret
 * concept at all: `codex mcp add <name> --url <url> --oauth-client-id <id>`
 * accepts a client ID but there is no `--oauth-client-secret` flag anywhere.
 * Codex is therefore always a public (PKCE) client — there is nothing to
 * withhold, this app simply never has a secret to give it.
 *
 * Unlike Claude Code, Codex's OAuth tokens (and everything else about the
 * server) live entirely in `~/.codex/config.toml` plus Codex's own OS-keyring
 * token store — `codex mcp list --json` / `codex mcp get <name> --json` are
 * cheap, reliable, and already return structured data, so this service never
 * needs to read or write that TOML file directly. That's also why there's no
 * `codexConfigFile.js` counterpart to `configFile.js`.
 */

function runRaw(file, args, { cwd, env, timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        env: { ...process.env, ...(env || {}) },
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: (stdout || '').toString().trim(),
          stderr: (stderr || '').toString().trim()
        })
      }
    )
  })
}

// A global npm/cargo install can expose `codex` as a `.cmd` shim on Windows,
// same situation as claude.cmd in claudeCli.js — route those through cmd.exe.
function runCodex(bin, args, opts) {
  if (isWindows && /\.(cmd|bat)$/i.test(bin)) {
    return runRaw('cmd.exe', ['/c', bin, ...args], opts)
  }
  return runRaw(bin, args, opts)
}

/** Same allowlist Claude Code names are held to — see isValidServerName. */
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

function safeValue(value, label) {
  if (!isShellSafeValue(String(value ?? ''))) {
    throw new Error(
      `${label} contains characters that cannot be passed to the Codex CLI (one of: " & | < > ^ ` +
        'or a line break).'
    )
  }
  return value
}

function staticCandidates() {
  const home = os.homedir()
  if (isWindows) {
    return [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
      path.join(process.env.APPDATA || '', 'npm', 'codex.cmd')
    ]
  }
  return [
    path.join(home, '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex'
  ]
}

let cachedBin = null

/**
 * Locate the codex executable. PATH first (`where`/`which`), then well-known
 * install locations — a GUI app doesn't always inherit the user's shell PATH.
 */
export async function resolveCodex({ refresh = false } = {}) {
  if (cachedBin && !refresh && fs.existsSync(cachedBin)) return cachedBin

  const located = await runRaw(isWindows ? 'where' : 'which', ['codex'])
  if (located.code === 0 && located.stdout) {
    const first = located.stdout.split(/\r?\n/)[0].trim()
    if (first && fs.existsSync(first)) {
      cachedBin = first
      return cachedBin
    }
  }

  for (const candidate of staticCandidates()) {
    if (candidate && fs.existsSync(candidate)) {
      cachedBin = candidate
      return cachedBin
    }
  }
  return null
}

export async function detect() {
  const bin = await resolveCodex({ refresh: true })
  if (!bin) return { found: false, path: null, version: null }
  const v = await runCodex(bin, ['--version'], { timeoutMs: READ_TIMEOUT_MS })
  return {
    found: true,
    path: bin,
    // `codex --version` prints e.g. "codex-cli 0.146.0".
    version: v.code === 0 ? v.stdout.split(/\s+/).pop() : null
  }
}

/**
 * Register a streamable-HTTP MCP server. Codex's global config only, in this
 * app — there is no scope argument the way Claude Code has one.
 *
 * `clientId` is optional the way Claude Code's confidential path isn't: a
 * server that supports dynamic client registration doesn't need one, so an
 * empty value is simply omitted rather than rejected.
 */
export async function registerServer({ name, url, clientId }) {
  safeName(name)
  safeValue(url, 'The MCP server URL')
  if (clientId) safeValue(clientId, 'The client ID')

  const bin = await resolveCodex()
  if (!bin) throw new Error('Codex CLI not found.')

  // Best-effort removal so re-running the wizard is idempotent, mirroring
  // claudeCli.registerServer.
  await runCodex(bin, ['mcp', 'remove', name])

  const args = ['mcp', 'add', name, '--url', url]
  if (clientId) args.push('--oauth-client-id', clientId)

  const res = await runCodex(bin, args)
  if (res.code !== 0) {
    throw new Error(res.stderr || res.stdout || 'codex mcp add failed.')
  }
  return { ok: true, output: res.stdout }
}

// Verified against a real `codex` 0.146.0 install: `codex mcp get --json`
// reports the config (name/enabled/transport) but never `auth_status` — only
// `codex mcp list --json` does. Values observed: "not_logged_in" for a
// registered-but-unauthorized server, and "unsupported" for a URL with no
// OAuth support at all. The positive ("actually signed in") value was not
// observed — completing that requires a live browser OAuth round trip, which
// this spike didn't run — so treat anything outside this known-negative set
// as authenticated rather than guess at one exact string; verify this against
// a real successful login before relying on it further.
const NOT_AUTHENTICATED_STATUSES = new Set(['not_logged_in', 'unsupported'])

/**
 * Read back one server's registration, via `codex mcp list --json` rather
 * than `codex mcp get` — see NOT_AUTHENTICATED_STATUSES above for why.
 */
export async function getServer({ name }) {
  safeName(name)
  const { servers } = await listServers()
  const entry = servers.find((s) => s && typeof s === 'object' && s.name === name)
  if (!entry) return { found: false, raw: null, authenticated: false }
  return {
    found: true,
    raw: JSON.stringify(entry),
    enabled: Boolean(entry.enabled),
    url: entry.transport?.url || null,
    authStatus: entry.auth_status || null,
    authenticated: Boolean(entry.auth_status) && !NOT_AUTHENTICATED_STATUSES.has(entry.auth_status)
  }
}

/**
 * Start the OAuth flow by running `codex mcp login <name>` in a real terminal
 * window — same TTY reasoning as claudeCli.startLogin, using the shared
 * launcher rather than a second copy of the terminal-fallback logic.
 *
 * `scopes`, if given, is passed as `--scopes a,b,c`; Codex persists the
 * requested scopes into config.toml on successful login.
 */
export async function startLogin({ name, scopes }) {
  safeName(name)
  const bin = await resolveCodex()
  if (!bin) throw new Error('Codex CLI not found.')
  const args = ['mcp', 'login', name]
  if (Array.isArray(scopes) && scopes.length) {
    args.push('--scopes', scopes.join(','))
  }
  return launchInTerminal({ cwd: os.homedir(), bin, args })
}

export async function removeServer({ name }) {
  safeName(name)
  const bin = await resolveCodex()
  if (!bin) throw new Error('Codex CLI not found.')
  const res = await runCodex(bin, ['mcp', 'remove', name])
  return { ok: res.code === 0, output: res.stdout || res.stderr }
}

/**
 * Every server Codex currently knows about — one cheap call for the whole
 * list. Returns `{ servers, error }` rather than a bare array: a JSON-parse
 * failure or a non-zero exit (e.g. Codex refusing to read a corrupted
 * `~/.codex/config.toml`) is a real problem distinct from "Codex isn't
 * installed" or "no servers configured yet" (both of which legitimately mean
 * an empty list), and callers need to be able to tell them apart to warn
 * instead of silently showing zero Codex connections.
 */
export async function listServers() {
  const bin = await resolveCodex()
  if (!bin) return { servers: [], error: null }

  const res = await runCodex(bin, ['mcp', 'list', '--json'], { timeoutMs: READ_TIMEOUT_MS })
  if (res.code !== 0) {
    const detail = res.stderr || res.stdout
    return { servers: [], error: detail || 'codex mcp list failed with no output.' }
  }

  let parsed
  try {
    parsed = JSON.parse(res.stdout)
  } catch (e) {
    log.error('codexCli', 'could not parse `codex mcp list --json` output:', res.stdout)
    return { servers: [], error: `Could not parse the Codex CLI's output: ${e.message}` }
  }
  if (!Array.isArray(parsed)) {
    return {
      servers: [],
      error: `codex mcp list --json returned unexpected data: ${res.stdout.slice(0, 500)}`
    }
  }
  return { servers: parsed, error: null }
}
