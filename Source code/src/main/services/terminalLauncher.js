import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { classifyCandidate, comSpec, powerShell } from './cliDiscovery'
import { describeRunFailure, run } from './procRun'

const isWindows = process.platform === 'win32'

/**
 * Launch a CLI command in a real, visible terminal window and return
 * immediately — shared by claudeCli.js and codexCli.js, both of which need
 * this for the same reason: `claude mcp login` / `codex mcp login` check that
 * stdin is a TTY before opening the browser and completing the OAuth
 * exchange, and an Electron app has no terminal attached to hand them. This
 * used to be duplicated per-CLI; the OS-specific quoting and terminal-fallback
 * logic below is substantial enough that a second copy would drift from the
 * first the moment one of them got a bug fix.
 *
 * The command's arguments never touch this process's command line or a
 * shell's interpretation of one on POSIX (env vars on Windows, single-quoting
 * on POSIX) — callers are still responsible for validating any value that
 * ends up in `args` (see safeName/isValidServerName in the CLI services),
 * since a bad value here still corrupts the generated script.
 */

const runRaw = run

/**
 * A sentence for a launch that never got off the ground. Without this the caller
 * reported success and the user waited out the whole authorization timeout.
 */
function launchFailure(res) {
  return `Could not open a terminal window to sign in. ${describeRunFailure(res) || ''}`.trim()
}

/**
 * Make sure the directory we're about to hand the terminal actually exists.
 *
 * `cwd` is a project path read out of ~/.claude.json, and projects get moved,
 * renamed and deleted. Spawning into a missing directory fails with ENOENT, and
 * because the launch result used to be discarded the caller was told the sign-in
 * had started — leaving the user watching a spinner for the full five-minute
 * authorization timeout with no window ever appearing.
 */
export function resolveLaunchCwd(cwd, deps = {}) {
  const statSync = deps.statSync || fs.statSync
  let stat
  try {
    stat = statSync(cwd)
  } catch {
    throw new Error(
      `The folder for this connection no longer exists: ${cwd}. Reopen the project ` +
        'in that location, or delete and re-add the connection.'
    )
  }
  if (!stat.isDirectory()) {
    throw new Error(`The path for this connection is not a folder: ${cwd}.`)
  }
  return cwd
}

const LOGIN_DIR_PREFIX = 'twmcp-login-'
const LOGIN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Reap abandoned sign-in script directories, shared across every CLI this app
 * drives through a terminal. Each sign-in writes its script to a fresh temp
 * directory that has to outlive this process — the terminal running it is
 * independent of the app — so cleanup happens on the *next* launch instead of
 * at quit. Anything a day old belongs to a sign-in long since finished or
 * abandoned.
 */
export function sweepOldLoginDirs() {
  let entries
  try {
    entries = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  const cutoff = Date.now() - LOGIN_DIR_MAX_AGE_MS
  // Drop tokens for launches whose directory is about to go, so the map can't
  // grow for the life of the process.
  for (const [id, entry] of launches) {
    if (entry.at < cutoff) launches.delete(id)
  }
  for (const name of entries) {
    if (!name.startsWith(LOGIN_DIR_PREFIX)) continue
    const dir = path.join(os.tmpdir(), name)
    try {
      if (fs.statSync(dir).mtimeMs > cutoff) continue
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Another user's directory, or one still held open — leave it.
    }
  }
}

/**
 * How the batch script should invoke the CLI.
 *
 * cmd can't run a .ps1 at all — it would hand the file to whatever the shell
 * associates with the extension — so a PowerShell shim needs an explicit
 * interpreter here, the same way runClaude does for direct execution.
 */
function winInvocation(bin) {
  if (classifyCandidate(bin, 'win32') === 'ps1') {
    return `"${powerShell(process.env)}" -NoProfile -ExecutionPolicy Bypass -File "%TWMCP_BIN%"`
  }
  return '"%TWMCP_BIN%"'
}

const STARTED_MARKER = 'started'
const EXIT_MARKER = 'exit'

/**
 * Live sign-in launches, keyed by an opaque token.
 *
 * The marker paths deliberately never leave the main process: handing the
 * renderer a path and taking it back would be an arbitrary-file-read primitive
 * on an IPC channel. The renderer only ever sees the token.
 */
const launches = new Map()

function registerLaunch(dir) {
  const launchId = crypto.randomBytes(16).toString('hex')
  launches.set(launchId, {
    dir,
    started: path.join(dir, STARTED_MARKER),
    exited: path.join(dir, EXIT_MARKER),
    at: Date.now()
  })
  return launchId
}

/**
 * What the sign-in script has managed to do so far.
 *
 * This is what separates the three states the poller could not previously tell
 * apart: the terminal never opened at all (nothing written), the CLI is running
 * and waiting on the browser (started, no exit), and the sign-in finished or
 * failed behind the `pause` (exit written, with its code). Without it, a
 * terminal that never appeared looked exactly like a user who hadn't finished
 * yet — a five-minute wait for an error that was knowable in seconds.
 */
export function readLaunchProbe(launchId) {
  const entry = launches.get(launchId)
  if (!entry) return { known: false, started: false, exited: false, exitCode: null }
  const started = fs.existsSync(entry.started)
  let exited = false
  let exitCode = null
  try {
    const raw = fs.readFileSync(entry.exited, 'utf8').trim()
    exited = true
    const n = Number.parseInt(raw, 10)
    exitCode = Number.isFinite(n) ? n : null
  } catch {
    // Not written yet, which is the normal case while the user is signing in.
  }
  return { known: true, started, exited, exitCode, ageMs: Date.now() - entry.at }
}

/**
 * Quote a value for a POSIX shell script. Wrapping in single quotes makes
 * every character literal; the replace closes the quote, emits an escaped
 * quote and reopens, which is the only sequence single quotes can't contain.
 */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Run `bin arg1 arg2 ...` in a new terminal window and return once it's
 * launched — the caller polls for the command's effect separately, the same
 * way claudeCli.js's callers poll `claude mcp get`.
 *
 * `args` values are passed through the environment on Windows (not the
 * script text) and through POSIX single-quoting on other platforms, mirroring
 * the approach `claudeCli.js` used before this was extracted. Only a small,
 * fixed number of positional args is supported (enough for `mcp login <name>
 * [--scopes <list>]`-shaped commands); each becomes one `%TWMCP_ARGn%` /
 * shell-quoted token.
 */
export async function launchInTerminal({ cwd, bin, args }) {
  resolveLaunchCwd(cwd)
  sweepOldLoginDirs()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), LOGIN_DIR_PREFIX))

  if (isWindows) {
    const bat = path.join(dir, 'authorize.cmd')
    const env = {
      TWMCP_CWD: cwd,
      TWMCP_BIN: bin,
      TWMCP_STARTED: path.join(dir, STARTED_MARKER),
      TWMCP_EXITED: path.join(dir, EXIT_MARKER)
    }
    const argRefs = args.map((value, i) => {
      env[`TWMCP_ARG${i}`] = value
      return `"%TWMCP_ARG${i}%"`
    })
    // Values come from the environment rather than the script text, which
    // keeps them out of a file on disk. Note this is tidiness, NOT the
    // security boundary: %VAR% (and !VAR! with delayed expansion) is
    // substituted before the resulting command line is parsed, and a global
    // npm install's shim may re-expand its own `%*` anyway — so a value
    // containing `"` cannot be made safe by any quoting scheme here. Callers
    // must validate (see safeName) before a value ever reaches this function.
    fs.writeFileSync(
      bat,
      [
        '@echo off',
        'title MCP Manager authorization',
        'cd /d "%TWMCP_CWD%"',
        // Guard the cd: without it a failed one runs the sign-in from the wrong
        // directory, which silently resolves the wrong scope for local/project.
        // `if errorlevel` rather than `||` — the latter is unreliable after a
        // cmd *internal* command.
        'if errorlevel 1 ( echo Could not enter "%TWMCP_CWD%" - the sign-in was not started. & pause & exit /b 1 )',
        // Written BEFORE the CLI runs: its presence is what proves a terminal
        // actually opened, separately from whether the sign-in succeeded.
        'echo started > "%TWMCP_STARTED%"',
        // `call` is mandatory, not tidiness: invoking a .cmd from a .cmd without
        // it TRANSFERS control, so every line below — including the `pause` —
        // would never run and the window would vanish before the user could
        // read anything. A global npm install makes %TWMCP_BIN% exactly that.
        // `call` is harmless for an .exe and preserves its exit code.
        `call ${winInvocation(bin)} ${argRefs.join(' ')}`,
        // Capture the code immediately — anything after this clobbers it.
        'set TWMCP_RC=%ERRORLEVEL%',
        // The space before `>` is load-bearing: `echo 3> file` makes cmd read
        // the digit as a file-descriptor number and writes nothing at all.
        'echo %TWMCP_RC% > "%TWMCP_EXITED%"',
        'echo.',
        'if not "%TWMCP_RC%"=="0" (echo Authorization failed - see the message above.) else (echo Authorization complete. You can close this window.)',
        'pause'
      ].join('\r\n'),
      'utf8'
    )
    // `start` hands off to the OS's configured console host, which is why this
    // needs no knowledge of Windows Terminal vs. conhost — the user's default
    // wins. It does mean the exit code only tells us whether cmd.exe itself
    // ran, not whether the console appeared; the caller still polls for that.
    const res = await runRaw(comSpec(), ['/c', 'start', '', bat], {
      cwd,
      env: { ...process.env, ...env }
    })
    if (!res.ok) throw new Error(launchFailure(res))
    return { launched: true, script: bat, dir, launchId: registerLaunch(dir) }
  }

  // POSIX uses shell quoting rather than the environment: `open -a Terminal`
  // does not reliably pass this process's environment to the new Terminal.
  const sh = path.join(dir, 'authorize.sh')
  fs.writeFileSync(
    sh,
    [
      '#!/bin/sh',
      `cd ${shQuote(cwd)} || exit 1`,
      // Inlined rather than passed through the environment: `open -a Terminal`
      // does not reliably hand this process's env to the new terminal.
      `: > ${shQuote(path.join(dir, STARTED_MARKER))}`,
      `${shQuote(bin)} ${args.map(shQuote).join(' ')}`,
      `echo $? > ${shQuote(path.join(dir, EXIT_MARKER))}`,
      'echo',
      'echo "You can close this window."',
      process.platform === 'darwin' ? '' : 'read -r _'
    ].join('\n'),
    { mode: 0o755 }
  )

  if (process.platform === 'darwin') {
    // Terminal.app is not guaranteed to be present or permitted; fall back to
    // the user's default handler for the script rather than failing outright.
    let res = await runRaw('open', ['-a', 'Terminal', sh], { cwd })
    if (!res.ok) res = await runRaw('open', ['-a', 'iTerm', sh], { cwd })
    if (!res.ok) res = await runRaw('open', [sh], { cwd })
    if (!res.ok) throw new Error(launchFailure(res))
    return { launched: true, script: sh, dir, launchId: registerLaunch(dir) }
  }

  // Linux: no terminal emulator is guaranteed, so try the common ones in turn.
  const terminals = [
    ['x-terminal-emulator', ['-e', sh]],
    ['gnome-terminal', ['--', sh]],
    ['konsole', ['-e', sh]],
    ['xfce4-terminal', ['-e', sh]],
    ['xterm', ['-e', sh]]
  ]
  for (const [term, termArgs] of terminals) {
    const which = await runRaw('which', [term])
    if (!which.ok || !which.stdout) continue
    // Detached, not awaited: xterm -e runs in the FOREGROUND, so awaiting it
    // would not resolve until the user closed the window — and the caller
    // can't start polling until this returns.
    const child = spawn(term, termArgs, { cwd, detached: true, stdio: 'ignore' })
    const failed = await new Promise((resolve) => {
      const settle = (v) => {
        clearTimeout(t)
        resolve(v)
      }
      const t = setTimeout(() => settle(null), 750)
      child.once('error', (e) => settle(e))
      child.once('spawn', () => settle(null))
    })
    if (failed) continue
    child.unref()
    return { launched: true, script: sh, dir, terminal: term, launchId: registerLaunch(dir) }
  }
  throw new Error(
    `No terminal emulator found to run the sign-in. Run this manually: ${bin} ${args.join(' ')}`
  )
}
