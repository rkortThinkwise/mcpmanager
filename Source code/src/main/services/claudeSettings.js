import fs from 'fs'
import os from 'os'
import path from 'path'
import { atomicWriteJson, readJsonSafe } from './fileStore'
import * as log from './logger'

/**
 * Enable/disable for project-scoped servers (the ones in a shared `.mcp.json`)
 * goes through Claude Code's own `disabledMcpjsonServers` mechanism rather than
 * editing `.mcp.json` — that file is committed and shared with the team, so we
 * must never touch it. Per the docs, "a `disabledMcpjsonServers` entry in any
 * settings file still rejects the server."
 *
 * We WRITE to the project's `.claude/settings.local.json`, which is local and
 * gitignored by convention, so disabling a project server only affects this
 * machine. We READ from the local, project, and user settings files so a server
 * disabled elsewhere still shows as disabled and Enable can explain when it
 * can't take effect.
 */

// Ordered by precedence for reporting; `ours` marks the one file we write.
function settingsFiles(projectPath) {
  return [
    {
      label: '.claude/settings.local.json',
      path: path.join(projectPath, '.claude', 'settings.local.json'),
      ours: true
    },
    {
      label: '.claude/settings.json',
      path: path.join(projectPath, '.claude', 'settings.json'),
      ours: false
    },
    {
      label: '~/.claude/settings.json',
      path: path.join(os.homedir(), '.claude', 'settings.json'),
      ours: false
    }
  ]
}

function readJson(filePath) {
  const { data, corrupted, error } = readJsonSafe(filePath, {})
  if (corrupted) {
    // This file is only ever hand-edited or written by this app itself, so a
    // corrupt one is more likely disk/crash damage than a typo — but either
    // way, silently treating it as "nothing disabled" can misreport a
    // project connection's real enabled/disabled state. No dedicated UI
    // warning for this one (a project-scoped, per-file edge case); a console
    // trace is the right level of investment here.
    log.error('claudeSettings', `could not read ${filePath}:`, error)
    return {}
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

function disabledListOf(doc) {
  return Array.isArray(doc.disabledMcpjsonServers) ? doc.disabledMcpjsonServers : []
}

/**
 * Which settings files currently disable this project server. Returns
 * [{ label, ours }]; empty means the server is enabled.
 */
export function disabledSources(projectPath, name) {
  if (!projectPath) return []
  return settingsFiles(projectPath)
    .filter((f) => disabledListOf(readJson(f.path)).includes(name))
    .map(({ label, ours }) => ({ label, ours }))
}

export function isProjectServerDisabled(projectPath, name) {
  return disabledSources(projectPath, name).length > 0
}

/**
 * True when the server is disabled by a settings file other than the one we
 * write, so Enable can tell the user why removing our entry didn't re-enable it.
 */
export function disabledByOtherFile(projectPath, name) {
  return disabledSources(projectPath, name).some((s) => !s.ours)
}

/**
 * Add or remove the server name in the project's `.claude/settings.local.json`
 * `disabledMcpjsonServers` array, creating the file and directory if needed.
 */
export function setProjectServerDisabled(projectPath, name, disabled) {
  const ours = settingsFiles(projectPath).find((f) => f.ours)
  const doc = readJson(ours.path)
  const current = new Set(disabledListOf(doc))

  if (disabled) current.add(name)
  else current.delete(name)

  const next = [...current]
  if (next.length) doc.disabledMcpjsonServers = next
  else delete doc.disabledMcpjsonServers

  fs.mkdirSync(path.dirname(ours.path), { recursive: true })
  atomicWriteJson(ours.path, doc)

  // Report whether another file will keep it disabled anyway (only meaningful
  // when we were trying to enable).
  return { stillDisabledElsewhere: !disabled && disabledByOtherFile(projectPath, name) }
}
