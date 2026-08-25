import { execFile } from 'child_process'

/**
 * One process runner for every CLI this app drives.
 *
 * This replaces four near-identical copies of a `runRaw` that reported
 * `{ code: 1 }` for anything that wasn't a clean exit — which meant a missing
 * binary, a timeout kill, an output overflow and a genuine non-zero exit were
 * indistinguishable. Since a failed spawn also produces empty stdout AND empty
 * stderr, callers doing `throw new Error(stderr || stdout || 'failed')` ended up
 * throwing an error with no message at all.
 *
 * The result keeps `code`, `stdout` and `stderr` with their original meanings so
 * existing `res.code !== 0` call sites behave exactly as before; everything that
 * distinguishes failures is additive.
 */

// 1 MiB truncated real `claude mcp get` output on configs with many servers.
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 90000

/**
 * Work out what actually went wrong from the error execFile handed us.
 *
 * Pure, so the mapping can be tested against synthetic Node errors — which is
 * the only practical way to cover ENOENT/EACCES/timeout/overflow without
 * arranging four different broken machines.
 */
export function classifyRunFailure(error, { elapsedMs = 0, timeoutMs = 0 } = {}) {
  if (!error) return { failure: null, code: 0, errno: null, signal: null, truncated: false }

  // A string `code` is an errno from the spawn itself: the file doesn't exist,
  // isn't executable, or is a script Windows can't run directly. Note the
  // reported code is -1, not 1 — still truthy for `!== 0`, but distinguishable.
  if (typeof error.code === 'string' && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { failure: 'spawn', code: -1, errno: error.code, signal: null, truncated: false }
  }

  if (
    error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    /maxBuffer length exceeded/i.test(error.message || '')
  ) {
    return { failure: 'maxBuffer', code: -1, errno: null, signal: null, truncated: true }
  }

  // execFile kills with SIGTERM when `timeout` expires. Corroborate with the
  // clock so an unrelated SIGTERM isn't misreported as our own timeout.
  if (error.killed && (elapsedMs === 0 || elapsedMs >= timeoutMs * 0.9)) {
    return {
      failure: 'timeout',
      code: -1,
      errno: null,
      signal: error.signal || 'SIGTERM',
      truncated: false
    }
  }

  if (error.signal) {
    return { failure: 'signal', code: -1, errno: null, signal: error.signal, truncated: false }
  }

  if (typeof error.code === 'number') {
    return { failure: 'exit', code: error.code, errno: null, signal: null, truncated: false }
  }

  return { failure: 'exit', code: 1, errno: null, signal: null, truncated: false }
}

const ERRNO_HINTS = {
  ENOENT:
    'the file could not be started — it may have been moved or removed, or it may be a script ' +
    'this platform cannot run directly',
  EACCES: 'permission was denied',
  EPERM: 'permission was denied',
  ENOTDIR: 'part of the path is not a directory',
  E2BIG: 'the command line was too long'
}

/**
 * A sentence describing a failed run, for a user who has no idea what execFile
 * is. Always non-empty for a failure — that guarantee is what stops an empty
 * error message reaching the UI.
 */
export function describeRunFailure(res) {
  if (!res || !res.failure || res.failure === null) return null
  const target = res.file ? `"${res.file}"` : 'the command'
  switch (res.failure) {
    case 'spawn':
      return `Could not run ${target}: ${ERRNO_HINTS[res.errno] || `the system reported ${res.errno}`}.`
    case 'timeout':
      return `${target} did not finish within ${Math.round((res.timeoutMs || 0) / 1000)} seconds and was stopped.`
    case 'maxBuffer':
      return `${target} produced more output than expected, so the result was truncated.`
    case 'signal':
      return `${target} was terminated unexpectedly (${res.signal}).`
    case 'exit': {
      const detail = res.stderr || res.stdout
      return detail || `${target} exited with code ${res.code} and produced no output.`
    }
    default:
      return `${target} failed (${res.failure}).`
  }
}

/**
 * Run a command. Never rejects — failures come back on the result, matching the
 * contract every existing caller was written against.
 */
export function run(file, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBuffer = DEFAULT_MAX_BUFFER,
    execFileImpl = execFile
  } = options

  const startedAt = Date.now()
  return new Promise((resolve) => {
    execFileImpl(
      file,
      args,
      {
        cwd,
        env: { ...process.env, ...(env || {}) },
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer
      },
      (error, stdout, stderr) => {
        const elapsedMs = Date.now() - startedAt
        const classified = classifyRunFailure(error, { elapsedMs, timeoutMs })
        // Keep whatever output we did get. On a maxBuffer overflow this is the
        // partial result, which is far more useful than the empty string the
        // previous implementation produced.
        const res = {
          ...classified,
          ok: classified.failure === null,
          stdout: (stdout || '').toString().trim(),
          stderr: (stderr || '').toString().trim(),
          file,
          args,
          cwd,
          timeoutMs,
          durationMs: elapsedMs
        }
        res.message = describeRunFailure(res)
        resolve(res)
      }
    )
  })
}

/**
 * Build an Error carrying the machine-readable failure alongside the sentence,
 * so ipc.js can forward the kind and ErrorDetail can show the raw output.
 */
export function cliError(res, label) {
  const raw = [res.stderr, res.stdout].filter(Boolean).join('\n')
  // For a clean non-zero exit the CLI's own output IS the explanation; for
  // everything else the CLI never got far enough to explain itself.
  const message = res.failure === 'exit' && raw ? `${label}: ${raw}` : `${label}: ${res.message}`
  const err = new Error(message)
  err.cliFailure = res.failure
  err.cliErrno = res.errno || null
  err.detail = raw || null
  return err
}
