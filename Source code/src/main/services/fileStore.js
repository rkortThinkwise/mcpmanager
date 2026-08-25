import fs from 'fs'

/**
 * Shared JSON file helpers for every store this app owns
 * (connections-meta.json, secrets.json, settings.json, and the
 * `.claude/settings.local.json` this app writes) — extracted from
 * configFile.js, which had the original atomic-write implementation, because
 * the same two problems kept recurring in each service that grew its own copy:
 *
 *  1. A plain `fs.writeFileSync` to the final path can leave a torn/corrupt
 *     file if the process dies mid-write (crash, forced quit, disk full).
 *  2. A plain `JSON.parse(fs.readFileSync(...))` doesn't distinguish "the
 *     file doesn't exist yet" (normal, e.g. first run) from "the file exists
 *     but is corrupt" (a real problem worth telling someone about) — every
 *     caller that used to catch-and-default lost that distinction entirely.
 */

/**
 * Write JSON without risking a torn file if interrupted mid-write: write a
 * sibling temp file, then rename over the target (atomic on the same volume).
 *
 * `mode`: if given, the file is always written with exactly this mode —
 * for a store that must never be group/world-readable regardless of what
 * created it before (e.g. secrets.json). If omitted, the existing file's
 * mode is preserved (falling back to 0600 for a brand-new file) — the right
 * default for a file this app doesn't own the permissions model of.
 */
export function atomicWriteJson(filePath, obj, { mode } = {}) {
  const tmp = `${filePath}.tmp-${process.pid}`
  let finalMode = mode
  if (finalMode === undefined) {
    finalMode = 0o600
    try {
      finalMode = fs.statSync(filePath).mode & 0o777
    } catch {
      // New file — stay private rather than inheriting the umask default.
    }
  }
  try {
    // Write, flush, then rename. Without the fsync the rename can land before
    // the contents do, so a power loss leaves a correctly-named empty file —
    // and for ~/.claude.json that's the user's whole MCP configuration.
    const fd = fs.openSync(tmp, 'w', finalMode)
    try {
      fs.writeFileSync(fd, JSON.stringify(obj, null, 2), { encoding: 'utf8' })
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    // openSync only applies `mode` when it creates the file, so a leftover temp
    // from an interrupted run would keep its old permissions.
    try {
      fs.chmodSync(tmp, finalMode)
    } catch {
      // Non-POSIX filesystem; the rename below is still correct.
    }
    renameWithRetry(tmp, filePath)
  } finally {
    // A failed write or rename must not leave a stray .tmp-<pid> next to the
    // real file, where the next run would find it with stale permissions.
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      // Nothing more we can do; the temp name is pid-scoped so it won't be
      // mistaken for the real file.
    }
  }
}

// Windows hands out sharing violations when someone else has the file open for
// a moment — Defender scanning a just-written file, OneDrive syncing it, or
// Claude Code itself reading ~/.claude.json. These clear in milliseconds, so a
// short retry turns a hard failure into a pause nobody notices.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_ATTEMPTS = 5

function renameWithRetry(tmp, filePath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmp, filePath)
      return
    } catch (e) {
      if (attempt >= RENAME_ATTEMPTS - 1 || !RENAME_RETRY_CODES.has(e.code)) throw e
      sleepSync(10 * 2 ** attempt)
    }
  }
}

/**
 * Block briefly without async. Every caller of atomicWriteJson is synchronous by
 * design — mutateMeta in connections.js depends on read-modify-write not being
 * interleaved — so this cannot become a promise without reopening that race.
 */
function sleepSync(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Intentionally busy: the waits are single-digit milliseconds.
  }
}

/**
 * Read and JSON.parse a file, splitting "doesn't exist" from "exists but is
 * unreadable/corrupt" so a caller can fall back silently for the former and
 * surface a warning for the latter, instead of treating both the same.
 *
 * Returns `{ data, corrupted, error }`. `data` is `fallback` in both the
 * missing and corrupted cases — every caller still gets something usable
 * without its own extra null-check — but `corrupted`/`error` are only set
 * when the file existed and something about it was actually wrong.
 */
export function readJsonSafe(filePath, fallback) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { data: fallback, corrupted: false, error: null }
    return { data: fallback, corrupted: true, error: e.message }
  }
  try {
    return { data: JSON.parse(raw), corrupted: false, error: null }
  } catch (e) {
    return { data: fallback, corrupted: true, error: e.message }
  }
}
