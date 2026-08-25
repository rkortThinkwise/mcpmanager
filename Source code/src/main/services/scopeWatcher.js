import * as connections from './connections'
import * as settings from './settings'
import * as log from './logger'

/**
 * Runs the scope-drift check on a timer and tells the renderer when the result
 * changes.
 *
 * It lives in the main process rather than the renderer because it owns the
 * network and the config, and because a renderer-side interval would be at the
 * mercy of Chromium's background-tab timer throttling.
 *
 * Scheduling deliberately uses a fresh setTimeout per run rather than
 * setInterval: a run takes as long as the slowest server responds, and
 * setInterval would let runs pile up on top of each other if a server hangs.
 */

let timer = null
let running = false
let stopped = false
let getWindow = () => null

function notify(channel, payload) {
  const win = getWindow()
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

function clearTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

/** Run the sweep now. Safe to call at any time; overlapping calls are ignored. */
export async function runNow({ reschedule: doReschedule = true } = {}) {
  if (running) return null
  running = true
  notify('scopes:checking', true)
  try {
    const summary = await connections.checkAllScopeDrift()
    settings.writeSettings({ lastCheckAt: summary.checkedAt, lastCheckError: null })
    // The list's statuses are derived from what the sweep just recorded, so the
    // renderer needs to re-read them.
    notify('connections:changed', summary)
    return summary
  } catch (e) {
    // Per-connection errors are already recorded against each connection by
    // checkAllScopeDrift — this catch is for the sweep failing *outright*
    // (e.g. reading the connection list itself threw). That's a systemic
    // problem worth more than silence: record it next to lastCheckAt so the
    // settings dialog can show it instead of a falsely-reassuring "last
    // checked: never" or a stale timestamp with no explanation.
    log.error('scopeWatcher', 'scope-drift sweep failed:', e.message)
    settings.writeSettings({ lastCheckError: e.message })
    return null
  } finally {
    running = false
    notify('scopes:checking', false)
    if (doReschedule) schedule()
  }
}

/** (Re)arm the timer from the currently saved interval. */
export function schedule() {
  clearTimer()
  // A sweep already in flight when stop() ran would otherwise re-arm the timer
  // from its `finally` after we'd deliberately cleared it.
  if (stopped) return
  const { scopeCheckIntervalMinutes } = settings.readSettings()
  if (!scopeCheckIntervalMinutes || scopeCheckIntervalMinutes <= 0) return // manual only
  timer = setTimeout(() => runNow(), scopeCheckIntervalMinutes * 60 * 1000)
}

export function start(windowGetter) {
  getWindow = windowGetter
  stopped = false
  const { checkOnStartup } = settings.readSettings()
  if (checkOnStartup) {
    // Let the window paint and the first list load land before firing off a
    // request per connection. Tracked in `timer` like any other pending run, so
    // quitting inside those five seconds actually cancels it.
    clearTimer()
    timer = setTimeout(() => runNow(), 5_000)
  } else {
    schedule()
  }
}

export function stop() {
  stopped = true
  clearTimer()
}
