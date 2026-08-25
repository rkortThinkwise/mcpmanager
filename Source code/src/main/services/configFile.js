import fs from 'fs'
import os from 'os'
import path from 'path'
import { atomicWriteJson, readJsonSafe } from './fileStore'
import * as log from './logger'

/**
 * Resolve the default Claude Code config path in an OS-aware way.
 * `~/.claude.json` lives in the user's home directory on every platform;
 * always build the path through path.join so Windows backslashes are handled.
 */
export function defaultConfigPath() {
  return path.join(os.homedir(), '.claude.json')
}

/**
 * Step 6a — automatic scan for ~/.claude.json.
 */
export function locateConfig() {
  const filePath = defaultConfigPath()
  const found = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
  return { found, path: filePath }
}

/**
 * Validate that a path points at a real Claude config: parseable JSON with the
 * shape we expect (an object, optionally carrying mcpServers / projects).
 * If a directory is passed, we look for `.claude.json` inside it.
 */
export function validateConfig(inputPath) {
  let filePath = inputPath
  try {
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null
    if (stat && stat.isDirectory()) {
      filePath = path.join(filePath, '.claude.json')
    }
    if (!fs.existsSync(filePath)) {
      return { valid: false, path: filePath, error: 'File does not exist.' }
    }
    const raw = fs.readFileSync(filePath, 'utf8')
    let config
    try {
      config = JSON.parse(raw)
    } catch (e) {
      return { valid: false, path: filePath, error: `File is not valid JSON: ${e.message}` }
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      return { valid: false, path: filePath, error: 'Not a Claude configuration object.' }
    }
    // A genuine Claude config carries at least one of these keys. Being lenient
    // here: an empty {} is acceptable (a fresh install), but arrays/strings are not.
    return { valid: true, path: filePath, config }
  } catch (e) {
    return { valid: false, path: filePath, error: e.message }
  }
}

/**
 * Project-scoped MCP servers don't live in ~/.claude.json at all — they're in a
 * `.mcp.json` at the project root, which is meant to be committed so the whole
 * team gets the same servers. Read-only here: this app never writes one, since
 * that file is shared and a client secret must never end up in it.
 */
export function mcpJsonPath(projectPath) {
  return path.join(projectPath, '.mcp.json')
}

export function readMcpJson(projectPath) {
  const { data, corrupted, error } = readJsonSafe(mcpJsonPath(projectPath), null)
  if (corrupted) {
    // An unreadable or malformed .mcp.json shouldn't take the whole list
    // down — the project's servers just don't show up, same as before —
    // but it's worth a trace, since this used to be indistinguishable from
    // "no .mcp.json here at all".
    log.error('configFile', `could not read ${mcpJsonPath(projectPath)}:`, error)
    return null
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null
}

/**
 * List project entries from the config. Claude stores per-project data under
 * `projects`, keyed by absolute project path.
 */
export function listProjects(config) {
  if (!config || typeof config.projects !== 'object' || config.projects === null) {
    return []
  }
  return Object.keys(config.projects)
}

/**
 * Step 6c — detect path casing / slash inconsistencies among project keys.
 * A known Windows issue: different callers write the same project path with
 * different casing or slash direction, producing duplicate keys that Claude
 * treats as distinct projects. We group keys by their normalized form and flag
 * any group with more than one raw spelling.
 */
function normalizePathKey(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function casingCheck(config, projectPath) {
  const keys = listProjects(config)
  const groups = new Map()
  for (const key of keys) {
    const norm = normalizePathKey(key)
    if (!groups.has(norm)) groups.set(norm, [])
    groups.get(norm).push(key)
  }

  // If a specific project path was chosen, only report variants of that one.
  const variants = []
  if (projectPath) {
    const norm = normalizePathKey(projectPath)
    const group = groups.get(norm) || []
    if (group.length > 1) variants.push({ normalized: norm, keys: group })
  } else {
    for (const [norm, group] of groups) {
      if (group.length > 1) variants.push({ normalized: norm, keys: group })
    }
  }
  return { hasMismatch: variants.length > 0, variants }
}

/**
 * Build the mcpServers entry object that gets written into the config.
 *
 * This shape is dictated by what Claude Code actually reads — do not change it
 * casually:
 *  - `type` (NOT `transport`) selects the transport. Claude Code treats an
 *    entry that has a `url` but no `type` as a stdio server and skips it with
 *    `MCP server "<name>" has a "url" but no "type"`, so the server never shows
 *    up in /mcp. See https://code.claude.com/docs/en/mcp
 *  - The OAuth details live inside `oauth` using camelCase keys, and `scopes`
 *    is a single space-separated string (OAuth 2.0 scope syntax), not an array.
 */
export function buildEntry({ url, clientId, callbackPort, scopes, metadataUrl }) {
  // `oauth.scopes` is an optional pin (Claude Code docs: "Leave it unset to
  // let the MCP server determine the requested scope set"). Sending it as a
  // present-but-empty string when nothing was selected is rejected by the CLI
  // with a generic "Invalid configuration: : Invalid input" — so the key must
  // be omitted entirely rather than sent as ''.
  const scopeStr = Array.isArray(scopes) ? scopes.join(' ') : String(scopes || '')
  return {
    type: 'http',
    url,
    oauth: {
      clientId,
      callbackPort: Number(callbackPort),
      authServerMetadataUrl: metadataUrl,
      ...(scopeStr ? { scopes: scopeStr } : {})
    }
  }
}

// NOTE: there is deliberately no writeConfig() here that would *create* a
// server entry.
//
// Writing a fresh entry into ~/.claude.json directly is possible but wrong:
// Claude Code keeps the OAuth client secret in the OS keychain / its own
// credentials file, never in the config. A hand-written entry therefore has no
// secret, the token exchange fails with `invalid_client`, and /mcp hangs
// forever on "Completing authentication in browser...". Registration goes
// through services/claudeCli.js (`claude mcp add-json ... --client-secret`)
// instead, which is the only supported way to store the secret.
//
// parkServer/unparkServer below ARE direct writes, and that's deliberate: they
// only *move* an already-registered entry between `mcpServers` and a sibling
// `mcpServersDisabled` key, so Claude Code stops (or resumes) using it. They
// never create an entry and never touch the secret — the keychain credential is
// keyed by server name and is left untouched — so the failure mode above can't
// apply. This is how "disable" stays lossless: no CLI remove/re-add, no
// re-authorization. The spike in the enable/disable plan confirmed Claude Code
// preserves the `mcpServersDisabled` key across its own rewrites of this file.

// Where the OAuth client secret lives means we never create entries by hand, but
// moving an existing one is safe — see the NOTE above.
const DISABLED_KEY = 'mcpServersDisabled'

// atomicWriteJson (imported from ./fileStore) is what makes writes here safe:
// ~/.claude.json is shared with the running Claude Code app, so a half-written
// file from an interrupted write would be worse than any race the rename
// itself loses, and preserving the file's existing mode matters because it
// holds OAuth state and history.

// The object that owns a scope's server maps. For `user` that's the config root
// (top-level `mcpServers`); for `local` it's the matching `projects[<path>]`
// object. Project keys can differ in casing/slash direction from what we were
// handed, so fall back to a normalized match — the same tolerance findConnection
// and casingCheck already apply.
function scopeOwner(config, scope, projectPath) {
  if (scope === 'user') return config
  if (scope !== 'local') {
    throw new Error(`parkServer only handles user/local scope, not "${scope}".`)
  }
  if (!config.projects || typeof config.projects !== 'object') return null
  if (config.projects[projectPath]) return config.projects[projectPath]
  const norm = normalizePathKey(projectPath || '')
  const key = Object.keys(config.projects).find((k) => normalizePathKey(k) === norm)
  return key ? config.projects[key] : null
}

function moveServerEntry({ scope, projectPath, name, from, to }) {
  const filePath = defaultConfigPath()
  const v = validateConfig(filePath)
  if (!v.valid) {
    throw new Error(`Could not read the Claude Code configuration (${filePath}): ${v.error}`)
  }
  const config = v.config
  const owner = scopeOwner(config, scope, projectPath)
  if (!owner) {
    throw new Error(`Could not locate the ${scope} configuration for "${name}".`)
  }

  const src = owner[from]
  if (!src || !src[name]) {
    // Idempotent: if it already sits in the destination, the desired state is
    // already true — treat as success rather than erroring.
    if (owner[to] && owner[to][name]) return { moved: false }
    throw new Error(`"${name}" was not found in the ${scope} configuration.`)
  }

  if (!owner[to] || typeof owner[to] !== 'object') owner[to] = {}
  // Overwrite any stale entry of the same name in the destination: the live
  // source entry is authoritative (plan edge case "name collision on park").
  owner[to][name] = src[name]
  delete src[name]

  atomicWriteJson(filePath, config)
  return { moved: true }
}

/**
 * Disable a user/local server by moving its entry from `mcpServers` to a sibling
 * `mcpServersDisabled` key in the same file. Claude Code then stops connecting
 * to it, while its keychain token and client secret stay intact for enable.
 */
export function parkServer({ scope, projectPath, name }) {
  return moveServerEntry({ scope, projectPath, name, from: 'mcpServers', to: DISABLED_KEY })
}

/** Re-enable a parked user/local server: move it back into `mcpServers`. */
export function unparkServer({ scope, projectPath, name }) {
  return moveServerEntry({ scope, projectPath, name, from: DISABLED_KEY, to: 'mcpServers' })
}

/**
 * The raw entry registered under a name in one scope, enabled or parked, or
 * null. Covers stdio servers and disabled ones too, unlike readConnections(),
 * which returns only HTTP servers carrying a URL — so this is what can answer
 * "is this name already taken?", and by what.
 *
 * It also lets a caller tell "this name belongs to something else" from "this
 * is the entry we are about to rewrite": the difference between a collision and
 * an idempotent retry.
 */
export function readServerEntry({ scope, projectPath, name }) {
  if (scope === 'project') {
    const doc = readMcpJson(projectPath)
    const entry = doc && doc.mcpServers && doc.mcpServers[name]
    return entry && typeof entry === 'object' ? { entry, disabled: false } : null
  }

  const v = validateConfig(defaultConfigPath())
  if (!v.valid) return null
  const owner = scope === 'user' ? v.config : scopeOwner(v.config, 'local', projectPath)
  if (!owner) return null
  for (const [key, disabled] of [
    ['mcpServers', false],
    [DISABLED_KEY, true]
  ]) {
    const entry = owner[key] && owner[key][name]
    if (entry && typeof entry === 'object') return { entry, disabled }
  }
  return null
}

/**
 * Read a scope's disabled (parked) server map, so the list can show disabled
 * user/local connections. Mirrors the `mcpServers` read but for the sibling key.
 */
export function readParkedServers(config, scope, projectPath) {
  const owner =
    scope === 'user'
      ? config
      : config.projects &&
        (config.projects[projectPath] ||
          config.projects[
            Object.keys(config.projects).find(
              (k) => normalizePathKey(k) === normalizePathKey(projectPath || '')
            )
          ])
  const map = owner && owner[DISABLED_KEY]
  return map && typeof map === 'object' ? map : {}
}

/**
 * Read back the entry that was just written, to confirm it matches (the wizard's
 * verification step).
 *
 * The wizard only installs `user` or `local` scope: `user` lives in top-level
 * `mcpServers`, `local` under `projects[<path>].mcpServers`. (This checked
 * `scope === 'project'` before the scope vocabulary was renamed to Claude
 * Code's own `user`/`local`/`project`, which quietly sent local installs to the
 * user container.)
 */
export function readEntry({ filePath, scope, projectPath, name }) {
  const v = validateConfig(filePath)
  if (!v.valid) {
    throw new Error(`Could not read back the configuration (${filePath}): ${v.error}`)
  }
  const config = v.config
  let container
  if (scope === 'local') {
    container =
      config.projects &&
      config.projects[projectPath] &&
      config.projects[projectPath].mcpServers
  } else {
    container = config.mcpServers
  }
  const entry = container ? container[name] : undefined
  return { exists: Boolean(entry), entry: entry || null }
}
