import path from 'path'
import { app } from 'electron'
import { atomicWriteJson, readJsonSafe } from './fileStore'
import * as log from './logger'

// App preferences, kept in our own userData directory. Nothing here ever goes
// into the Claude config.

// Offered in the settings dialog. `0` means "never check automatically" — the
// manual "Check now" button still works.
export const CHECK_INTERVAL_OPTIONS = [
  { minutes: 0, label: 'Never (manual only)' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 360, label: 'Every 6 hours' },
  { minutes: 720, label: 'Every 12 hours' },
  { minutes: 1440, label: 'Every day' }
]

const DEFAULTS = {
  // Six hours: scope sets change on the server's release cadence, not by the
  // minute, and each check is a real HTTP round trip per connection.
  scopeCheckIntervalMinutes: 360,
  // Checking once shortly after launch is what makes the status trustworthy
  // when you open the app to look at it.
  checkOnStartup: true,
  lastCheckAt: null,
  // Set by scopeWatcher.runNow() when a whole sweep fails outright (as
  // opposed to a single connection's own driftError) — surfaced next to
  // "last checked" in the settings dialog rather than only ever logged.
  lastCheckError: null,
  // Escape hatch for a Claude Code install this app can't find on its own —
  // an unusual install location, a locked-down PATH, a portable copy. null
  // means "detect automatically", which is what almost everyone wants.
  claudeCliPath: null
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

// Tracks the outcome of the most recent readSettings() call — see the
// matching pattern (and rationale) in secrets.js's getStoreHealth().
let lastReadCorrupted = false
let lastReadError = null

export function readSettings() {
  const { data: raw, corrupted, error } = readJsonSafe(settingsPath(), null)
  if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    lastReadCorrupted = true
    lastReadError = 'settings.json does not contain a JSON object.'
    return { ...DEFAULTS }
  }
  lastReadCorrupted = corrupted
  lastReadError = error
  return { ...DEFAULTS, ...(raw || {}) }
}

/** Whether settings.json could be read cleanly last time anything read it. */
export function getSettingsHealth() {
  readSettings()
  return { corrupted: lastReadCorrupted, error: lastReadError }
}

/**
 * Normalise a hand-set CLI path.
 *
 * Deliberately does NOT check that the file exists, and writeSettings stores
 * whatever survives this. Existence is the resolver's job to *report* — a path
 * on a network share that happens to be offline right now must not be silently
 * erased from the user's settings. validate.optionalCliPath is what tells them
 * about a bad path, at the moment they save it.
 */
export function sanitizeCliPath(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^"(.*)"$/, '$1')
  if (!trimmed) return null
  // A NUL or newline in a path can only come from a corrupted file or a paste
  // accident, and both would be passed to execFile.
  if (/[\0\r\n]/.test(trimmed)) return null
  if (trimmed.length > 4096) return null
  if (!path.isAbsolute(trimmed)) return null
  return trimmed
}

export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  next.claudeCliPath = sanitizeCliPath(next.claudeCliPath)
  // Only accept an interval we actually offer; a hand-edited file shouldn't be
  // able to set a 1-second poll against the customer's server.
  if (!CHECK_INTERVAL_OPTIONS.some((o) => o.minutes === Number(next.scopeCheckIntervalMinutes))) {
    next.scopeCheckIntervalMinutes = DEFAULTS.scopeCheckIntervalMinutes
  }
  next.scopeCheckIntervalMinutes = Number(next.scopeCheckIntervalMinutes)
  try {
    atomicWriteJson(settingsPath(), next)
  } catch (e) {
    // Non-fatal: settings revert to defaults next launch — but worth a trace,
    // since this used to fail completely silently.
    log.error('settings', 'failed to write settings.json:', e.message)
  }
  return next
}
