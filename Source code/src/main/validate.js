import fs from 'fs'
import { SCOPES, TARGETS, isValidServerName } from '../shared/mcp'

/**
 * Shape checks for everything crossing the IPC boundary.
 *
 * The renderer is our own code, so this is not a trust boundary in the usual
 * sense — but it is the one place every write path converges, and the services
 * behind it put values on a command line, into a JSON file shared with Claude
 * Code, and into the OS credential store. Several handlers used to spread a
 * renderer-supplied payload straight into a service call, which meant each
 * service re-derived its own idea of what a valid scope or port was (and
 * `duplicate` accepted an install scope nothing validated at all). Checking
 * once, here, keeps that uniform and turns a malformed call into a clear
 * message instead of a downstream surprise.
 *
 * Business rules — does this name collide, is the secret stored — deliberately
 * stay in the services, which are the only things that can answer them.
 */

function fail(message) {
  throw new Error(message)
}

export function requireString(value, label, { max = 2048 } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} is required.`)
  if (value.length > max) fail(`${label} is too long (max ${max} characters).`)
  return value
}

export function optionalString(value, label, opts) {
  if (value === undefined || value === null || value === '') return undefined
  return requireString(value, label, opts)
}

export function requireServerName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!isValidServerName(name)) {
    fail(
      'Use letters, digits, spaces, dot, dash or underscore only, starting with a letter or ' +
        'digit (max 64 characters).'
    )
  }
  return name
}

export function requireHttpUrl(value, label) {
  requireString(value, label)
  let url
  try {
    url = new URL(value)
  } catch {
    return fail(`${label} is not a valid URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`${label} must be an http or https URL.`)
  }
  return value
}

export function requirePort(value, label = 'The callback port') {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`${label} must be a whole number between 1 and 65535.`)
  }
  return port
}

export function requireInstallScope(value) {
  if (!SCOPES.includes(value)) fail(`"${value}" is not a valid install scope.`)
  return value
}

export function requireScopeList(value, label = 'Scopes') {
  if (!Array.isArray(value)) fail(`${label} must be a list.`)
  for (const s of value) {
    if (typeof s !== 'string' || s.trim().length === 0) fail(`${label} must all be non-empty text.`)
  }
  return value.map((s) => s.trim())
}

// A public (PKCE) client has no secret; a confidential one does. Defaults to
// confidential so anything predating this field keeps its current behaviour.
export function requireClientType(value) {
  if (value === undefined || value === null || value === '') return 'confidential'
  if (value !== 'public' && value !== 'confidential') {
    fail('The client type must be "public" or "confidential".')
  }
  return value
}

// Which app this connection lives in. Defaults to 'claude' so any payload
// predating targets (or the CLI target routing in connections.js) keeps its
// current behaviour.
export function requireTarget(value) {
  if (value === undefined || value === null || value === '') return 'claude'
  if (!TARGETS.includes(value)) fail(`"${value}" is not a valid install target.`)
  return value
}

/**
 * Scope plus project path travel together everywhere: `user` is machine-wide
 * and must not carry one, the other two are resolved against it and are
 * meaningless without it.
 */
export function requireLocation({ installScope, projectPath }) {
  const scope = requireInstallScope(installScope)
  if (scope === 'user') return { installScope: scope, projectPath: undefined }
  return {
    installScope: scope,
    projectPath: requireString(projectPath, 'A project path')
  }
}

/**
 * The payload the wizard's write step sends. One call always targets one
 * app — the wizard runs Claude Code and Codex through two separate
 * `connections:add` calls when both are selected — so most fields below only
 * make sense, and are only required, for the Claude Code target: Codex has no
 * callback port, no OAuth metadata URL field, and doesn't take a scope list
 * at registration time (scopes are requested later, at login).
 */
export function connectionPayload(payload) {
  if (!payload || typeof payload !== 'object') fail('No connection details were supplied.')
  const target = requireTarget(payload.target)

  const name = requireServerName(payload.name)
  const url = requireHttpUrl(payload.url, 'The MCP server URL')
  // Kept for both targets: Codex's config has nowhere to put it, but
  // Indicium's OAuth server still needs a pre-registered client id to match
  // whatever the target CLI presents, so the wizard always collects one.
  const clientId = requireString(payload.clientId, 'A client ID')

  if (target === 'codex') {
    return { target, name, url, clientType: 'public', clientId, installScope: 'user', projectPath: undefined }
  }

  const { installScope, projectPath } = requireLocation({
    installScope: payload.installScope || 'user',
    projectPath: payload.projectPath
  })
  return {
    target,
    name,
    url,
    clientType: requireClientType(payload.clientType),
    clientId,
    clientSecret: optionalString(payload.clientSecret, 'The client secret'),
    callbackPort: requirePort(payload.callbackPort),
    scopes: requireScopeList(payload.scopes),
    allScopes: Array.isArray(payload.allScopes) ? requireScopeList(payload.allScopes) : undefined,
    metadataUrl: requireHttpUrl(payload.metadataUrl, 'The OAuth metadata URL'),
    installScope,
    projectPath
  }
}

/** The payload the Duplicate modal sends. */
export function duplicatePayload(payload) {
  if (!payload || typeof payload !== 'object') fail('No duplicate details were supplied.')
  const { installScope, projectPath } = requireLocation({
    installScope: payload.installScope || 'user',
    projectPath: payload.projectPath
  })
  return {
    name: requireServerName(payload.name),
    scopes: requireScopeList(payload.scopes),
    providedSecret: optionalString(payload.providedSecret, 'The client secret'),
    installScope,
    projectPath
  }
}

/** The payload the Rename modal sends. */
export function renamePayload(payload) {
  if (!payload || typeof payload !== 'object') fail('No new name was supplied.')
  return {
    name: requireServerName(payload.name),
    providedSecret: optionalString(payload.providedSecret, 'The client secret')
  }
}

/** The payload the scope pickers send when applying a new scope set. */
export function scopeRefreshPayload(payload) {
  if (!payload || typeof payload !== 'object') return {}
  return {
    scopes: payload.scopes === undefined ? undefined : requireScopeList(payload.scopes),
    providedSecret: optionalString(payload.providedSecret, 'The client secret')
  }
}

/** A `{ name, scope, projectPath }` triple aimed at the Claude Code CLI. */
export function cliTarget(payload) {
  if (!payload || typeof payload !== 'object') fail('No server was specified.')
  const { installScope, projectPath } = requireLocation({
    installScope: payload.scope,
    projectPath: payload.projectPath
  })
  return { name: requireServerName(payload.name), scope: installScope, projectPath }
}

/**
 * A `{ name, scopes }` pair aimed at the Codex CLI. No scope/projectPath the
 * way cliTarget has: Codex only has the one (global) target in this app.
 */
export function codexTarget(payload) {
  if (!payload || typeof payload !== 'object') fail('No server was specified.')
  return {
    name: requireServerName(payload.name),
    scopes: payload.scopes === undefined ? undefined : requireScopeList(payload.scopes)
  }
}

/**
 * The optional hand-set path to a CLI executable.
 *
 * This is where a bad path gets reported — at the moment the user saves it,
 * while they're looking at the field — rather than later as a failed
 * connection. An empty value clears the override and returns to automatic
 * detection, so it is explicitly allowed.
 *
 * `statSync` is injectable so this stays testable without a real filesystem.
 */
export function optionalCliPath(value, deps = {}) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') fail('The CLI path must be text.')
  const trimmed = value.trim().replace(/^"(.*)"$/, '$1')
  if (!trimmed) return null
  if (trimmed.length > 4096) fail('That path is too long.')
  if (!isAbsolutePath(trimmed)) {
    fail('Enter the full path to the program, starting from the drive or root.')
  }
  const statSync = deps.statSync || fs.statSync
  let stat
  try {
    stat = statSync(trimmed)
  } catch {
    fail(`There is no file at ${trimmed}.`)
  }
  if (stat.isDirectory()) {
    fail(`${trimmed} is a folder. Point this at the program itself.`)
  }
  return trimmed
}

// Absolute-path test that doesn't depend on the host platform, so a Windows
// path is still recognised when these checks run under a POSIX test runner.
function isAbsolutePath(p) {
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(p)
}

/**
 * The opaque token identifying a sign-in launch.
 *
 * Only the token crosses IPC — never the marker paths it maps to. A
 * renderer-supplied path would let any renderer bug (or anything that could
 * reach the channel) turn this into an arbitrary-file-read.
 */
export function launchId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) {
    fail('A sign-in reference is required.')
  }
  return value
}

export function connectionId(id) {
  return requireString(id, 'A connection', { max: 4096 })
}
