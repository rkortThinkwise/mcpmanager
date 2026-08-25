import fs from 'fs'
import path from 'path'
import { app } from 'electron'

/**
 * A log file, because console output doesn't exist in a packaged app.
 *
 * Every diagnostic this app produced went to console.error, which is visible
 * when running from a terminal and nowhere at all once installed — so a user
 * reporting "it says it can't find the CLI" had nothing to attach, and no way to
 * say what the app had actually tried. Settings exposes the folder so a bug
 * report can include it.
 *
 * Deliberately small: no levels beyond info/warn/error, no async queue, no
 * third-party dependency. It has to keep working while something else is going
 * wrong.
 */

const MAX_BYTES = 1024 * 1024
// One generation back is enough to cover "it broke, I restarted, then I looked".
const KEEP_ROTATIONS = 1
const INDENT = '    '

let logPath = null
let failed = false

function resolveLogPath() {
  if (logPath || failed) return logPath
  try {
    const dir = app.getPath('logs')
    fs.mkdirSync(dir, { recursive: true })
    logPath = path.join(dir, 'mcp-manager.log')
  } catch {
    failed = true
  }
  return logPath
}

/** Roll the file over once it gets big, so it can't grow without bound. */
function rotateIfNeeded(file) {
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return // no file yet
  }
  if (size < MAX_BYTES) return
  try {
    for (let i = KEEP_ROTATIONS; i >= 1; i -= 1) {
      const older = `${file}.${i}`
      if (i === KEEP_ROTATIONS && fs.existsSync(older)) fs.rmSync(older, { force: true })
      const newer = i === 1 ? file : `${file}.${i - 1}`
      if (fs.existsSync(newer)) fs.renameSync(newer, older)
    }
  } catch {
    // Another instance holding the file, or a permission problem. Appending to
    // an oversized log is strictly better than losing the log.
  }
}

/**
 * Flatten the trailing arguments into one indented block.
 *
 * Variadic because call sites legitimately have more than one thing to say (a
 * connection name AND the error, say), and silently dropping the tail would
 * defeat the purpose of keeping a log at all.
 */
function formatExtras(extras) {
  const parts = extras
    .filter((e) => e !== undefined && e !== null && e !== '')
    .map((e) => (e instanceof Error ? e.stack || e.message : String(e)))
  if (!parts.length) return ''
  return parts.join(' ').split(/\r?\n/).join(`\n${INDENT}`)
}

function write(level, scope, message, extras) {
  const head = [new Date().toISOString(), level.toUpperCase(), `[${scope}]`, message]
    .filter(Boolean)
    .join(' ')
  const detail = formatExtras(extras)
  const line = detail ? `${head}\n${INDENT}${detail}` : head

  // Keep the console output too: it's what's useful during development, and the
  // file is what's useful in the field.
  const toConsole =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  toConsole(line)

  if (failed) return
  const file = resolveLogPath()
  if (!file) return
  try {
    rotateIfNeeded(file)
    fs.appendFileSync(file, `${line}\n`, 'utf8')
  } catch {
    // Never let logging be the thing that breaks the app. Give up rather than
    // throwing on every subsequent call.
    failed = true
  }
}

export function info(scope, message, ...extras) {
  write('info', scope, message, extras)
}

export function warn(scope, message, ...extras) {
  write('warn', scope, message, extras)
}

export function error(scope, message, ...extras) {
  write('error', scope, message, extras)
}

/** Where the log lives, for the "Open logs folder" button in Settings. */
export function logDirectory() {
  const file = resolveLogPath()
  return file ? path.dirname(file) : null
}
