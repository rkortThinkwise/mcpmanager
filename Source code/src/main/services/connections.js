import path from 'path'
import { app } from 'electron'
import * as configFile from './configFile'
import * as claudeSettings from './claudeSettings'
import * as connectivity from './connectivity'
import * as claudeCli from './claudeCli'
import * as codexCli from './codexCli'
import * as secrets from './secrets'
import { atomicWriteJson, readJsonSafe } from './fileStore'
import { baseUrlOf, diffScopes, isApplicationScope, CODEX_ENABLED } from '../../shared/mcp'
import * as log from './logger'

/**
 * The manager's view of Claude Code's MCP configuration.
 *
 * Reads come straight from the config files — they're the authoritative list of
 * what Claude Code has registered. Writes deliberately do NOT: they go through
 * services/claudeCli.js, because Claude Code keeps the OAuth client secret in
 * the OS credential store rather than the config, and the CLI is the only
 * supported way to put it there. See the comment block in claudeCli.js.
 *
 * Three scopes exist, and we use the CLI's own names for them (see SCOPES in
 * src/shared/mcp.js):
 *   user    -> top-level mcpServers in ~/.claude.json
 *   local   -> projects[<path>].mcpServers in ~/.claude.json
 *   project -> mcpServers in <path>/.mcp.json, committed to the repo
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

// A connection is identified by where it lives, not by a generated uuid, so an
// id stays stable across restarts and across edits made outside this app. The
// three parts are packed into one opaque string because a project path on
// Windows contains both ':' and '\', which rules out a plain delimiter.
//
// `target` (which app the connection lives in — 'claude' | 'codex') is only
// added to the payload for 'codex': every id minted before targets existed
// was implicitly Claude Code, and omitting the key for that default keeps
// those ids byte-identical after upgrade, so connections-meta.json and
// secrets.json records for existing connections aren't orphaned.
function makeId({ target, installScope, projectPath, name }) {
  const payload = JSON.stringify({
    ...(target === 'codex' ? { t: target } : {}),
    s: installScope,
    p: projectPath || null,
    n: name
  })
  return Buffer.from(payload, 'utf8').toString('base64url')
}

function parseId(id) {
  try {
    const { t, s, p, n } = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'))
    if (!n || !s) throw new Error('incomplete')
    return { target: t || 'claude', installScope: s, projectPath: p || undefined, name: n }
  } catch (e) {
    // An opaque internal id, not something a user typed — the real cause
    // (malformed base64/JSON) isn't actionable for them, but it's worth a
    // trace rather than disappearing entirely, since this only happens from
    // a bug or a hand-edited value reaching here.
    log.error('connections', 'could not parse connection id:', id, e.message)
    throw new Error('That connection could not be identified. Refresh the list and try again.', {
      cause: e
    })
  }
}

// ---------------------------------------------------------------------------
// Our own per-connection record
// ---------------------------------------------------------------------------

// Claude Code doesn't record when a server last worked, nor whether its scopes
// have drifted from what the server advertises, so we keep both ourselves.
// Never written into the Claude config.
function metaPath() {
  return path.join(app.getPath('userData'), 'connections-meta.json')
}

function readMeta() {
  const { data, corrupted, error } = readJsonSafe(metaPath(), {})
  if (corrupted) {
    // Drift history, lastVerified timestamps and scope exclusions all live
    // here — losing them degrades labels and can make a deliberate scope
    // opt-out look like new drift, but nothing about the connections
    // themselves, so falling back to an empty record (as before) is still
    // the right call. Just don't let it happen silently anymore.
    log.error('connections', 'could not read connections-meta.json:', error)
    return {}
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

function writeMeta(meta) {
  try {
    // Records which servers exist and which scopes were deliberately excluded —
    // not secret, but no reason for it to be world-readable either.
    atomicWriteJson(metaPath(), meta, { mode: 0o600 })
  } catch (e) {
    // A missing timestamp only degrades a label; never fail a list for it —
    // but it's worth a trace, since this used to fail completely silently.
    log.error('connections', 'failed to write connections-meta.json:', e.message)
  }
}

/**
 * Read-modify-write the meta file in a single synchronous step.
 *
 * Every caller used to read a snapshot, await network or CLI work, then write
 * that whole snapshot back — which lost updates routinely, because these
 * operations overlap constantly: the authorization poller calls
 * getConnectionDetails every two seconds while the background sweep is
 * recording drift, and whichever finished last silently discarded the other's
 * results. Node runs this callback to completion without interleaving, so as
 * long as nothing awaits *inside* it, no concurrent writer can be clobbered.
 * Collect whatever you need across an await first, then apply it here.
 */
function mutateMeta(fn) {
  const meta = readMeta()
  const result = fn(meta)
  writeMeta(meta)
  return result
}

// ---------------------------------------------------------------------------
// Reading connections out of the config
// ---------------------------------------------------------------------------

function entryToConnection({ name, entry, installScope, projectPath, disabled = false }) {
  const oauth = entry.oauth || {}
  // buildEntry() writes scopes as a single space-separated string (OAuth 2.0
  // scope syntax). Tolerate an array in case the entry was hand-written.
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes
    : String(oauth.scopes || '')
        .split(/\s+/)
        .filter(Boolean)

  return {
    id: makeId({ target: 'claude', installScope, projectPath, name }),
    target: 'claude',
    name,
    url: entry.url || '',
    clientId: oauth.clientId || '',
    callbackPort: Number(oauth.callbackPort) || 8080,
    metadataUrl: oauth.authServerMetadataUrl || '',
    scopes,
    installScope,
    projectPath: projectPath || undefined,
    disabled
  }
}

/**
 * A Codex server, as read from `codex mcp list --json` (see codexCli.js —
 * there's no separate config-file reader for Codex, the CLI's JSON output is
 * the source of truth). Fields with no Codex equivalent (callback port,
 * scopes actually enforced by us, disabled/parked state) are normalized to
 * the same shape Claude connections use so the rest of this module and the
 * renderer can treat both uniformly where it matters (name, url, status
 * inputs) and simply ignore the Claude-only fields where it doesn't.
 */
function codexEntryToConnection(entry) {
  return {
    id: makeId({ target: 'codex', installScope: 'user', projectPath: null, name: entry.name }),
    target: 'codex',
    name: entry.name,
    url: entry.transport?.url || '',
    clientId: '',
    callbackPort: null,
    metadataUrl: '',
    scopes: [],
    installScope: 'user',
    projectPath: undefined,
    disabled: false,
    codexAuthStatus: entry.auth_status || null
  }
}

// The outcome of the most recent readCodexConnections() call — see
// getCodexListError() below for why this isn't just thrown/returned inline.
let lastCodexListError = null

/**
 * Every Codex-registered server, read via `codex mcp list --json` (see
 * codexCli.js). A missing Codex CLI just means no Codex connections show up,
 * the same way a missing Claude Code CLI doesn't crash the rest of the list —
 * but an actual parse/read failure (a corrupted `~/.codex/config.toml`, or a
 * future Codex CLI version changing its output format) is recorded rather
 * than silently producing the same empty result, so the list can tell the two
 * apart and warn only for the latter.
 */
async function readCodexConnections() {
  try {
    const { servers, error } = await codexCli.listServers()
    lastCodexListError = error
    // Also guard against a malformed-but-parseable entry (not an object, or
    // missing the one field everything here keys off of) rather than
    // trusting every element `codex mcp list --json` produces.
    return servers
      .filter((s) => s && typeof s === 'object' && typeof s.name === 'string')
      .map(codexEntryToConnection)
  } catch (e) {
    lastCodexListError = e.message
    log.error('connections', 'unexpected error listing Codex servers:', e.message)
    return []
  }
}

/**
 * Whether the most recent Codex listing hit a real error (as opposed to
 * "Codex isn't installed" or "no Codex connections exist", both `null` here).
 * Read by the `connections:codexHealth` IPC channel, which the renderer polls
 * alongside every `connections:list` call so a banner can warn when Codex
 * connections might be missing from the list for a reason worth fixing.
 */
export function getCodexListError() {
  return lastCodexListError
}

/**
 * Every HTTP MCP server across all three scopes, including disabled ones.
 *
 * stdio servers are skipped: they have no URL, no OAuth, and none of this app's
 * actions (refresh scopes, reauthorize) mean anything for them.
 *
 * Disabled servers are read from where "disable" parked them:
 *   user/local -> the sibling `mcpServersDisabled` key in ~/.claude.json
 *   project    -> still in .mcp.json, flagged via disabledMcpjsonServers in a
 *                 settings file (see services/claudeSettings.js)
 *
 * Codex connections are folded in here too (async, unlike the rest of this
 * function) so every other reader of readConnections() sees one combined list
 * without having to know Codex exists.
 */
async function readConnections() {
  const out = []

  const collect = (container, installScope, projectPath, disabled) => {
    if (!container || typeof container !== 'object') return
    for (const [name, entry] of Object.entries(container)) {
      if (!entry || typeof entry !== 'object' || !entry.url) continue
      out.push(entryToConnection({ name, entry, installScope, projectPath, disabled }))
    }
  }

  const v = configFile.validateConfig(configFile.defaultConfigPath())
  const config = v.valid ? v.config : {}

  collect(config.mcpServers, 'user', null, false)
  collect(configFile.readParkedServers(config, 'user', null), 'user', null, true)

  if (config.projects && typeof config.projects === 'object') {
    for (const projectPath of Object.keys(config.projects)) {
      const project = config.projects[projectPath]
      collect(project && project.mcpServers, 'local', projectPath, false)
      collect(configFile.readParkedServers(config, 'local', projectPath), 'local', projectPath, true)

      // Project scope lives outside ~/.claude.json entirely, in a .mcp.json at
      // the project root. It stays there whether enabled or disabled; a settings
      // file's disabledMcpjsonServers is what flags it off.
      const mcpJson = configFile.readMcpJson(projectPath)
      if (mcpJson && mcpJson.mcpServers && typeof mcpJson.mcpServers === 'object') {
        const settingsDisabled = new Set(
          Object.keys(mcpJson.mcpServers).filter((name) =>
            claudeSettings.isProjectServerDisabled(projectPath, name)
          )
        )
        // A rejected project server is also recorded in the project's own
        // disabledMcpjsonServers inside ~/.claude.json, so honour that too.
        const projectRejected = Array.isArray(project && project.disabledMcpjsonServers)
          ? project.disabledMcpjsonServers
          : []
        for (const name of projectRejected) settingsDisabled.add(name)

        for (const [name, entry] of Object.entries(mcpJson.mcpServers)) {
          if (!entry || typeof entry !== 'object' || !entry.url) continue
          out.push(
            entryToConnection({
              name,
              entry,
              installScope: 'project',
              projectPath,
              disabled: settingsDisabled.has(name)
            })
          )
        }
      }
    }
  }

  if (CODEX_ENABLED) out.push(...(await readCodexConnections()))

  return out
}

// Same normalization the casing check uses. Two spellings of one Windows path
// ("C:\Foo" vs "c:/foo/") are the same project, and the CLI may store a key
// spelled differently from the one we handed it — an exact-match lookup would
// then fail to find a connection that was just written successfully.
function normalizePathKey(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

async function findConnection(id) {
  const { target, installScope, projectPath, name } = parseId(id)
  const candidates = (await readConnections()).filter(
    (c) => c.target === target && c.name === name && c.installScope === installScope
  )
  const match =
    candidates.find((c) => (c.projectPath || undefined) === projectPath) ||
    (projectPath
      ? candidates.find(
          (c) => c.projectPath && normalizePathKey(c.projectPath) === normalizePathKey(projectPath)
        )
      : undefined)
  if (!match) {
    const appName = target === 'codex' ? 'Codex' : 'Claude Code'
    throw new Error(`"${name}" is no longer in the ${appName} configuration.`)
  }
  return match
}

// ---------------------------------------------------------------------------
// Scope drift
// ---------------------------------------------------------------------------

/**
 * Ask the server what it advertises now and compare against what this
 * connection is configured with. Pure read: hits the well-known endpoint, wrote
 * nothing, triggers no authorization.
 *
 * "added" is computed against the *eligible* set (advertised minus scopes the
 * user has previously excluded via a picker), not the raw advertised set, so a
 * deliberate opt-out doesn't come back as manufactured drift on every check.
 * "removed" is always computed against the raw advertised set: losing a scope
 * the connection actually has is real drift regardless of any exclusion list.
 */
async function computeDrift(conn) {
  const base = baseUrlOf(conn.url)
  if (!base) throw new Error('This connection has no server URL, so its scopes cannot be checked.')

  const meta = await connectivity.discoverMetadata(base)
  if (!meta.ok) {
    throw new Error(meta.message || 'Could not read the scopes the server advertises.')
  }

  // Same filter the wizard applies, so the diff can't report protocol scopes
  // such as `openid` as newly available.
  const advertised = (meta.scopes || []).filter(isApplicationScope)
  const excluded = new Set(readMeta()[conn.id]?.excludedScopes || [])
  const eligible = advertised.filter((s) => !excluded.has(s))

  return {
    ...diffScopes(conn.scopes, eligible),
    removed: conn.scopes.filter((s) => !advertised.includes(s)),
    advertised,
    metadataUrl: meta.metadataUrl,
    scopesAdvertised: meta.scopesAdvertised
  }
}

function driftRecordFrom(diff) {
  return {
    added: diff.added,
    removed: diff.removed,
    checkedAt: new Date().toISOString(),
    // Stored so the list can show a drift status without re-hitting the network
    // on every render.
    hasDrift: diff.added.length > 0 || diff.removed.length > 0
  }
}

/**
 * The periodic check. Walks every connection, records drift, and returns a
 * summary. Errors are recorded per connection rather than thrown: one
 * unreachable server must not abort the sweep for the rest.
 */
export async function checkAllScopeDrift() {
  // Disabled servers are off, so there's nothing to check and no reason to spend
  // a network round trip on them. Codex connections don't track a scope set of
  // their own (see readServerState/deriveStatus), so drift has nothing to
  // compare and would only manufacture noise.
  const conns = (await readConnections()).filter((c) => !c.disabled && c.target === 'claude')
  let withDrift = 0
  let failed = 0

  // Collect first, write once: writing a snapshot captured before these
  // network round trips would discard anything else recorded meanwhile.
  //
  // Bounded for the same reason the status reads are (see STATUS_CONCURRENCY):
  // this was an unbounded Promise.all, so a config with many connections opened
  // one HTTPS round trip per connection at once — hard on a corporate proxy,
  // and enough to look like a burst of traffic from a single client.
  const patches = await mapLimit(conns, DRIFT_CONCURRENCY, async (conn) => {
    try {
      const record = driftRecordFrom(await computeDrift(conn))
      if (record.hasDrift) withDrift += 1
      return { id: conn.id, patch: { drift: record, driftError: null } }
    } catch (e) {
      failed += 1
      return { id: conn.id, patch: { driftError: e.message } }
    }
  })

  mutateMeta((m) => {
    for (const { id, patch } of patches) m[id] = { ...(m[id] || {}), ...patch }
  })
  return { checked: conns.length, withDrift, failed, checkedAt: new Date().toISOString() }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * What `claude mcp get` last said about a connection.
 *
 * Every status derivation spawns the CLI, and the list derives one per
 * connection — so a ten-connection list was ten processes, repeated on every
 * `connections:changed` event and after every action. The CLI's answer only
 * changes when something acts on the configuration, and everything that does
 * runs through this module, so a short TTL plus explicit invalidation on write
 * is enough. The TTL stays small because the CLI is not the only writer: the
 * user can also authorize in the terminal we opened for them.
 */
const SERVER_STATE_TTL_MS = 10_000
const serverStateCache = new Map()

function invalidateServerState(id) {
  if (id) serverStateCache.delete(id)
  else serverStateCache.clear()
}

/**
 * `fresh` bypasses the cache: the authorization poller is watching for exactly
 * the transition the cache would hide, so it must always ask the CLI.
 *
 * Codex's `getServer` returns a smaller shape than Claude's — no `statusLine`,
 * no scope/secret detail, just `found` and `authenticated` — because that's
 * all `codex mcp get --json` actually reports. deriveStatus below reads only
 * the fields both shapes share.
 */
async function readServerState(conn, { fresh = false } = {}) {
  if (!fresh) {
    const hit = serverStateCache.get(conn.id)
    if (hit && Date.now() - hit.at < SERVER_STATE_TTL_MS) return hit.value
  }
  const value =
    conn.target === 'codex'
      ? await codexCli.getServer({ name: conn.name })
      : await claudeCli.getServer({
          name: conn.name,
          scope: conn.installScope,
          projectPath: conn.projectPath
        })
  serverStateCache.set(conn.id, { at: Date.now(), value })
  return value
}

/**
 * Run an async mapper over a list, at most `limit` at a time.
 *
 * Deriving a status spawns a process, so an unbounded Promise.all over a large
 * list spawned one per connection simultaneously.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const STATUS_CONCURRENCY = 4

// Network round trips rather than processes, so a little wider than the status
// cap — but still bounded, and still gentle on a proxy that sees every one.
const DRIFT_CONCURRENCY = 6

/**
 * Status is derived on every read, never stored:
 *  - disabled:    turned off in this app; Claude Code isn't using it.
 *  - error:       the CLI can't see it, or couldn't be run.
 *  - warn:        registered but not authorized yet — reauthorizing fixes it.
 *  - scope_drift: authorized, but the last check found the server's advertised
 *                 scopes no longer match what's configured.
 *  - connected:   authorized and scopes match.
 *
 * Precedence matters: a connection that isn't authorized has a more urgent
 * problem than one whose scopes drifted, so auth state is reported first.
 */
async function deriveStatus(conn, record, options) {
  // A disabled connection short-circuits before any CLI call: a parked
  // user/local entry isn't in `claude mcp get` at all, and for a disabled
  // project server its auth state is beside the point — it's simply off.
  // (Codex connections never reach here disabled — see codexEntryToConnection.)
  const appName = conn.target === 'codex' ? 'Codex' : 'Claude Code'
  if (conn.disabled) {
    return { status: 'disabled', statusDetail: `Disabled — ${appName} is not using this server.` }
  }
  try {
    const s = await readServerState(conn, options)
    if (!s.found) {
      // "Not reported" is only meaningful when the CLI actually answered. If it
      // never ran — missing binary, timeout, a shim this platform can't launch
      // — that says nothing about the connection, and claiming otherwise sent
      // users looking for a configuration problem that wasn't there.
      if (s.unreachable) {
        return {
          status: 'error',
          statusDetail:
            s.unreachableReason ||
            `Could not run the ${appName} CLI to check this server.`
        }
      }
      return { status: 'error', statusDetail: `${appName} does not report this server.` }
    }
    // The CLI answered, but not in a shape this app recognizes — reporting
    // "not authorized" here would be a guess dressed up as a fact. See the
    // `unrecognized` flag in claudeCli.getServer for when this fires.
    if (s.unrecognized) {
      return {
        status: 'error',
        statusDetail:
          `Could not understand ${appName}'s response for this server — it may have changed ` +
          `format since this app was built. Raw output: ${s.raw || '(empty)'}`
      }
    }
    if (!s.authenticated) {
      return {
        status: 'warn',
        statusDetail: s.statusLine || 'Registered, but not authorized yet.'
      }
    }
    if (record?.drift?.hasDrift) {
      const { added, removed } = record.drift
      const parts = []
      if (added.length) parts.push(`${added.length} new`)
      if (removed.length) parts.push(`${removed.length} no longer offered`)
      return {
        status: 'scope_drift',
        statusDetail: `The server's scopes have changed (${parts.join(', ')}).`
      }
    }
    return { status: 'connected', statusDetail: s.statusLine || 'Connected' }
  } catch (e) {
    return { status: 'error', statusDetail: e.message }
  }
}

/**
 * Derive a connection's presentable form. Returns the connection plus the meta
 * change it implies, rather than writing meta itself — the caller applies every
 * patch in one synchronous mutateMeta after all the awaiting is done, so
 * concurrent readers can't clobber each other. See mutateMeta.
 */
async function decorate(conn, record, options) {
  const { status, statusDetail } = await deriveStatus(conn, record, options)
  const verifiedNow = status === 'connected' || status === 'scope_drift'
  const lastVerified = verifiedNow ? new Date().toISOString() : record?.lastVerified || null
  return {
    lastVerified: verifiedNow ? lastVerified : null,
    connection: {
      ...conn,
      status,
      statusDetail,
      lastVerified,
      scopesCheckedAt: record?.drift?.checkedAt || null,
      driftError: record?.driftError || null,
      // A connection with no recorded type predates this field and is
      // confidential, same as everything the wizard has ever required until now.
      clientType: record?.clientType || 'confidential',
      // Drives whether the refresh-scopes flow has to ask for the secret again.
      // Deliberately reports *usable*, not merely present: an undecryptable
      // record (OS key store changed since it was written) has to prompt, or
      // the refresh fails later with no field to type into.
      hasStoredSecret: secrets.usableSecret(conn)
    }
  }
}

// ---------------------------------------------------------------------------
// Guards shared by the write paths
// ---------------------------------------------------------------------------

/**
 * Refuse to register over a name that already belongs to something else.
 *
 * registerServer removes any existing entry of the name before adding, which is
 * what makes re-running the wizard idempotent — and also what made a name
 * collision destructive. The old collision check only consulted
 * readConnections(), which lists HTTP servers carrying a URL, so a name
 * matching an stdio server this app never shows was silently deleted.
 *
 * An entry that is already this exact connection — HTTP, same URL — is not a
 * collision: that is the wizard's own "Try again" after a partial failure, and
 * rewriting it is the intended behaviour.
 */
async function assertNameAvailable({ target, scope, projectPath, name, url }) {
  if (target === 'codex') {
    // registerServer's own best-effort `codex mcp remove` before adding would
    // otherwise silently delete an unrelated server (e.g. a stdio or
    // bearer-token one) that happens to share this name.
    const existing = await codexCli.getServer({ name })
    if (!existing.found) return
    if (url && existing.url === url) return
    throw new Error(
      `"${name}" is already registered in Codex (${existing.url || 'a different configuration'}). ` +
        'Choose a different name, or delete that server first.'
    )
  }

  const existing = configFile.readServerEntry({ scope, projectPath, name })
  if (!existing) return
  if (url && existing.entry.type === 'http' && existing.entry.url === url) return

  const where =
    scope === 'user' ? 'your user configuration' : `the ${scope} configuration for ${projectPath}`
  const what = existing.entry.type === 'http' ? existing.entry.url : 'a command-based (stdio) server'
  throw new Error(
    `"${name}" is already registered in ${where} (${what}). Choose a different name, or delete ` +
      'that server first.'
  )
}

/**
 * Project scope means a `.mcp.json` committed to a repository and shared with
 * the team. Registering into it is not this app's to do: the wizard has always
 * refused it (a client secret has no place in a shared file), and duplicate is
 * the other path that would *create* an entry there.
 *
 * Rename and scope changes are deliberately still allowed for a project
 * connection — they modify an entry that is already in that file, and the UI
 * warns that the change lands in a shared file. Creating a new one is a
 * different act.
 */
function assertNotCreatingInProjectScope(scope) {
  if (scope === 'project') {
    throw new Error(
      'A new connection cannot be created in project scope: that writes to the .mcp.json shared ' +
        'with everyone on the project, which is no place for an OAuth client secret. Choose User ' +
        'or Local scope.'
    )
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Drop records for connections that no longer exist.
 *
 * An id encodes name + scope + project path, so anything that changes one of
 * those — deleting a connection, moving a project, or a rename of our scope
 * vocabulary — strands its old record. Nothing reads a stranded record, but
 * without this the file only ever grows. Everything in it is re-derivable, so
 * pruning costs nothing.
 */
function pruneMeta(meta, conns) {
  const live = new Set(conns.map((c) => c.id))
  for (const id of Object.keys(meta)) {
    if (!live.has(id)) delete meta[id]
  }
  return meta
}

export async function listConnections() {
  const conns = await readConnections()
  // The full list is also the only thing that can say which connection a
  // version-1, name-keyed secret belonged to. See secrets.migrateLegacyKeys.
  if (conns.length > 0) secrets.migrateLegacyKeys(conns)

  const meta = readMeta()
  // Each deriveStatus spawns the CLI; run them in parallel so the list doesn't
  // take N seconds to appear, but bounded so a large list isn't N processes at
  // once.
  const results = await mapLimit(conns, STATUS_CONCURRENCY, (c) => decorate(c, meta[c.id]))

  mutateMeta((m) => {
    for (const { connection, lastVerified } of results) {
      if (lastVerified) m[connection.id] = { ...(m[connection.id] || {}), lastVerified }
    }
    // The full list is in hand here, which is the only place we can safely tell
    // a stale record from one belonging to a connection we simply didn't load.
    pruneMeta(m, conns)
  })
  return results.map((r) => r.connection)
}

/**
 * One connection, always read fresh from the CLI: this is what the
 * authorization poller calls, and it is watching for exactly the transition a
 * cached answer would hide.
 */
export async function getConnectionDetails(id) {
  const conn = await findConnection(id)
  const { connection, lastVerified } = await decorate(conn, readMeta()[conn.id], { fresh: true })
  if (lastVerified) {
    mutateMeta((m) => {
      m[conn.id] = { ...(m[conn.id] || {}), lastVerified }
    })
  }
  return connection
}

/**
 * On-demand check for one connection, used by the refresh-scopes modal. Records
 * the result too, so an explicit check also settles the list's status.
 */
export async function refreshScopes(id) {
  const conn = await findConnection(id)
  if (conn.target === 'codex') {
    throw new Error(
      `"${conn.name}" is a Codex connection; scope refresh isn't supported for Codex yet.`
    )
  }
  const diff = await computeDrift(conn)
  const record = driftRecordFrom(diff)
  mutateMeta((m) => {
    m[conn.id] = { ...(m[conn.id] || {}), drift: record, driftError: null }
  })
  return diff
}

/**
 * Write the server-advertised scope set and start a fresh authorization, which
 * a scope change requires — the existing token was consented to for the old set.
 *
 * Re-registering means removing and re-adding the CLI entry, which drops the
 * stored client secret unless we pass it again. If we don't have it (the
 * connection was added outside this app, or on another machine), refuse rather
 * than silently registering a secret-less entry whose token exchange would then
 * fail with invalid_client. The caller can supply the secret to proceed, and we
 * remember it so this is asked at most once per connection.
 *
 * `scopes` is the exact final set the user left checked in the picker — it may
 * differ from `diff.unchanged + diff.added` if they deselected something.
 * Whatever the server advertises but isn't in that final set becomes the new
 * `excludedScopes` baseline, so a deliberate opt-out sticks on later refreshes.
 */
export async function applyScopeRefresh(id, { scopes, providedSecret } = {}) {
  const conn = await findConnection(id)
  if (conn.target === 'codex') {
    throw new Error(
      `"${conn.name}" is a Codex connection; scope refresh isn't supported for Codex yet.`
    )
  }
  // Re-registering always writes a live entry, so applying scopes to a parked
  // connection would quietly switch it back on. The UI doesn't offer this for a
  // disabled connection; refuse rather than rely on that.
  if (conn.disabled) {
    throw new Error(
      `"${conn.name}" is disabled. Enable it first — updating scopes re-registers and ` +
        'reauthorizes the connection, which would turn it back on.'
    )
  }
  // Re-run the check server-side rather than trusting whatever diff the
  // renderer is still holding, which may be minutes stale.
  const diff = await computeDrift(conn)
  const nextScopes = Array.isArray(scopes) ? scopes : [...diff.unchanged, ...diff.added]
  const nextExcluded = diff.advertised.filter((s) => !nextScopes.includes(s))

  const isPublic = readMeta()[conn.id]?.clientType === 'public'
  const clientSecret = providedSecret || secrets.getSecret(conn)
  if (!isPublic && !clientSecret) {
    throw new Error(
      'The OAuth client secret for this connection is not stored on this machine, and updating ' +
        'its scopes requires re-registering it. Enter the client secret to continue.'
    )
  }

  const entry = configFile.buildEntry({
    url: conn.url,
    clientId: conn.clientId,
    callbackPort: conn.callbackPort,
    scopes: nextScopes,
    metadataUrl: diff.metadataUrl || conn.metadataUrl
  })

  await claudeCli.registerServer({
    name: conn.name,
    entry,
    scope: conn.installScope,
    projectPath: conn.projectPath,
    clientSecret
  })
  invalidateServerState(conn.id)
  // Remember it only once the registration it was needed for actually worked.
  if (providedSecret) secrets.storeSecret(conn, providedSecret)

  // launchId lets the caller's poller tell "no terminal ever opened" apart from
  // "still waiting on the browser" — see terminalLauncher.readLaunchProbe.
  const launch = await claudeCli.startLogin({
    name: conn.name,
    scope: conn.installScope,
    projectPath: conn.projectPath
  })

  // The scope set now matches the server, so any recorded drift is stale.
  mutateMeta((m) => {
    m[conn.id] = {
      ...(m[conn.id] || {}),
      excludedScopes: nextExcluded,
      drift: { added: [], removed: [], hasDrift: false, checkedAt: new Date().toISOString() },
      driftError: null
    }
  })

  // Authorization completes in the browser, so the connection is not connected
  // yet. The renderer polls getConnectionDetails until it is.
  return {
    connection: { ...conn, scopes: nextScopes },
    authorizationStarted: true,
    launchId: launch?.launchId || null
  }
}

/**
 * Fresh token, same configuration. Deliberately does not touch scopes: changing
 * those needs a re-registration and re-consent, which is applyScopeRefresh.
 */
export async function reauthorize(id) {
  const conn = await findConnection(id)
  let launch = null
  if (conn.target === 'codex') {
    // No scopes passed: Codex keeps whatever scope set the original login
    // (or the wizard) requested, in its own config.toml — this just refreshes
    // the token against that same configuration.
    launch = await codexCli.startLogin({ name: conn.name })
  } else {
    launch = await claudeCli.startLogin({
      name: conn.name,
      scope: conn.installScope,
      projectPath: conn.projectPath
    })
  }
  invalidateServerState(conn.id)
  return { connection: conn, authorizationStarted: true, launchId: launch?.launchId || null }
}

/**
 * Remove a connection from the Claude Code configuration.
 *
 * A disabled user/local connection is parked in `mcpServersDisabled`, where the
 * CLI cannot see it: `claude mcp remove` fails, and delete used to report an
 * error for a connection sitting right there in the list. So the entry goes
 * back before the CLI is asked to remove it — which also lets the CLI clear the
 * stored OAuth credentials, as deleting the parked entry by hand would not.
 */
export async function deleteConnection(id) {
  const conn = await findConnection(id)

  if (conn.target === 'codex') {
    const res = await codexCli.removeServer({ name: conn.name })
    invalidateServerState(conn.id)
    if (!res.ok) {
      // The exit code isn't the last word, same reasoning as the Claude Code
      // path below: check the CLI's own view before failing the caller.
      const check = await codexCli.getServer({ name: conn.name })
      if (check.found) throw new Error(res.output || `Could not remove "${conn.name}" from Codex.`)
    }
    secrets.deleteSecret(conn)
    mutateMeta((m) => {
      delete m[conn.id]
    })
    return true
  }

  const target = { scope: conn.installScope, projectPath: conn.projectPath, name: conn.name }
  const wasParked = conn.disabled && conn.installScope !== 'project'

  if (wasParked) configFile.unparkServer(target)

  const res = await claudeCli.removeServer({
    name: conn.name,
    scope: conn.installScope,
    projectPath: conn.projectPath
  })
  invalidateServerState(conn.id)

  // The exit code isn't the last word: an entry already gone from a partially
  // applied earlier attempt makes the CLI fail while the desired state holds.
  // Check the configuration itself.
  if (configFile.readServerEntry(target)) {
    // Leave the user where they were rather than silently enabled — but never
    // let that failing mask why the delete failed.
    if (wasParked) {
      try {
        configFile.parkServer(target)
      } catch (e) {
        // Reported below; the removal error is the one worth showing to the
        // user — but a trace here is the only way this secondary failure is
        // ever diagnosable if the connection ends up stuck enabled.
        log.error('connections', `failed to re-park "${conn.name}" after a failed delete:`, e.message)
      }
    }
    throw new Error(res.output || `Could not remove "${conn.name}" from the configuration.`)
  }

  // A disabled project server is flagged off in a settings file rather than
  // moved, so clear that too — otherwise a server later re-added under the same
  // name comes back mysteriously disabled.
  if (conn.installScope === 'project' && conn.disabled) {
    try {
      claudeSettings.setProjectServerDisabled(conn.projectPath, conn.name, false)
    } catch (e) {
      // The entry is gone either way; a stale flag is not worth failing the
      // delete on, but worth a trace if a future re-add comes back disabled
      // for no visible reason.
      log.error('connections', `failed to clear disabled flag for "${conn.name}":`, e.message)
    }
  }

  secrets.deleteSecret(conn)
  mutateMeta((m) => {
    delete m[conn.id]
  })
  return true
}

/**
 * Turn a connection off or on. Lossless in both directions and, unlike delete,
 * fully reversible:
 *  - user/local: move the entry between `mcpServers` and `mcpServersDisabled` in
 *    ~/.claude.json. The keychain token and client secret are untouched, so
 *    enabling needs no re-authorization and never asks for the secret.
 *  - project: add/remove the name in a settings file's `disabledMcpjsonServers`
 *    (services/claudeSettings.js). The shared .mcp.json is never edited.
 *
 * Returns the connection re-read from config so the list reflects the real
 * post-toggle state.
 */
export async function setConnectionEnabled(id, enabled) {
  const conn = await findConnection(id)
  if (conn.target === 'codex') {
    throw new Error(
      `"${conn.name}" is a Codex connection; enabling/disabling isn't supported for Codex yet.`
    )
  }

  if (conn.installScope === 'project') {
    const res = claudeSettings.setProjectServerDisabled(conn.projectPath, conn.name, !enabled)
    // We removed our own disable, but another settings file still turns it off.
    if (enabled && res.stillDisabledElsewhere) {
      throw new Error(
        `"${conn.name}" is also disabled by another settings file, so it stays off. Remove it ` +
          `from that file's "disabledMcpjsonServers" to enable it.`
      )
    }
  } else {
    const move = enabled ? configFile.unparkServer : configFile.parkServer
    move({ scope: conn.installScope, projectPath: conn.projectPath, name: conn.name })
  }

  invalidateServerState(conn.id)
  return getConnectionDetails(id)
}

/**
 * Register a new connection. Mirrors what the wizard's write step has always
 * done — CLI registration, so the secret lands in the credential store — and
 * returns the connection as read back from the config, so the list reflects
 * what was actually written rather than the form values.
 */
export async function addConnection(payload) {
  const target = payload.target === 'codex' ? 'codex' : 'claude'
  const { name, url } = payload

  if (target === 'codex') {
    // Codex's global config only — no scope choice, no client secret to
    // store (see codexCli.js), always recorded as a public client.
    await assertNameAvailable({ target, name, url })
    await codexCli.registerServer({ name, url, clientId: payload.clientId })

    const id = makeId({ target, installScope: 'user', projectPath: null, name })
    invalidateServerState(id)
    mutateMeta((m) => {
      m[id] = { ...(m[id] || {}), clientType: 'public' }
    })
    return getConnectionDetails(id)
  }

  const { clientId, clientSecret, callbackPort, scopes, metadataUrl } = payload
  const installScope = payload.installScope || 'user'
  const projectPath = payload.projectPath || undefined

  assertNotCreatingInProjectScope(installScope)
  // Passing the URL makes this tolerant of the wizard's own "Try again": an
  // entry already pointing at the same endpoint is ours to rewrite. Anything
  // else under that name belongs to someone and must not be overwritten.
  await assertNameAvailable({ target, scope: installScope, projectPath, name, url })

  const entry = configFile.buildEntry({ url, clientId, callbackPort, scopes, metadataUrl })
  await claudeCli.registerServer({
    name,
    entry,
    scope: installScope,
    projectPath,
    clientSecret
  })

  const id = makeId({ target, installScope, projectPath, name })
  invalidateServerState(id)
  // Storing it here is what makes a later scope refresh silent: the secret is
  // needed again to re-register, and this is the only moment we have it. A
  // public client never has one to store.
  if (clientSecret) secrets.storeSecret({ id, name }, clientSecret)

  // Record the client type so later rename/duplicate/refresh-scopes flows know
  // never to ask a public client for a secret it will never have, and seed
  // exclusions from what the wizard discovered but the user left unchecked, so
  // the first later "Refresh scopes" doesn't mistake a deliberate opt-out for
  // new drift.
  mutateMeta((m) => {
    m[id] = {
      ...(m[id] || {}),
      clientType: payload.clientType === 'public' ? 'public' : 'confidential',
      ...(Array.isArray(payload.allScopes) && payload.allScopes.length
        ? { excludedScopes: payload.allScopes.filter((s) => !scopes.includes(s)) }
        : {})
    }
  })

  return getConnectionDetails(id)
}

/**
 * Register a second connection against the same server/OAuth client as an
 * existing one, under a new name and its own scope subset — e.g. a read-only
 * copy of a connector that otherwise grants full access.
 *
 * Reuses the source's url/clientId/callbackPort/metadataUrl and, if held, its
 * client secret (the secret belongs to the OAuth client, not to any one
 * Claude Code entry, so it's valid for the duplicate too). Exclusions are
 * seeded the same way addConnection() seeds them, so the duplicate's own
 * future refreshes behave consistently from the start.
 */
export async function duplicateConnection(id, payload) {
  const source = await findConnection(id)
  if (source.target === 'codex') {
    throw new Error(
      `"${source.name}" is a Codex connection; duplicating isn't supported for Codex yet.`
    )
  }
  const installScope = payload.installScope || source.installScope
  const projectPath = installScope === 'user' ? undefined : payload.projectPath || undefined
  const name = payload.name

  // Duplicating a project-scoped connection defaulted to project scope, which
  // would have written a brand-new entry into the repository's shared
  // .mcp.json — the one thing the wizard has always refused to do.
  assertNotCreatingInProjectScope(installScope)
  if (installScope !== 'user' && !projectPath) {
    throw new Error('A project is required for a local-scope connection.')
  }
  await assertNameAvailable({ target: 'claude', scope: installScope, projectPath, name })

  const isPublic = readMeta()[source.id]?.clientType === 'public'
  const clientSecret = payload.providedSecret || secrets.getSecret(source)
  if (!isPublic && !clientSecret) {
    throw new Error(
      'The OAuth client secret for this connection is not stored on this machine, and ' +
        'duplicating it requires re-registering under the new name. Enter the client secret to continue.'
    )
  }

  const entry = configFile.buildEntry({
    url: source.url,
    clientId: source.clientId,
    callbackPort: source.callbackPort,
    scopes: payload.scopes,
    metadataUrl: source.metadataUrl
  })
  await claudeCli.registerServer({ name, entry, scope: installScope, projectPath, clientSecret })

  const newId = makeId({ installScope, projectPath, name })
  invalidateServerState(newId)
  if (clientSecret) secrets.storeSecret({ id: newId, name }, clientSecret)
  mutateMeta((m) => {
    m[newId] = { ...(m[newId] || {}), clientType: isPublic ? 'public' : 'confidential' }
  })

  // Seed exclusions from the source's currently advertised scopes, same as a
  // fresh wizard-created connection does.
  try {
    const base = baseUrlOf(source.url)
    const discovered = base ? await connectivity.discoverMetadata(base) : { ok: false }
    if (discovered.ok) {
      const advertised = (discovered.scopes || []).filter(isApplicationScope)
      const excludedScopes = advertised.filter((s) => !payload.scopes.includes(s))
      mutateMeta((m) => {
        m[newId] = { ...(m[newId] || {}), excludedScopes }
      })
    }
  } catch (e) {
    // Best-effort: a failed rediscovery here just means the duplicate's first
    // refresh treats every advertised scope as undecided, same as a normal
    // wizard-created connection would if metadata discovery failed there —
    // but still worth a trace rather than disappearing entirely.
    log.error('connections', `scope rediscovery failed while duplicating to "${name}":`, e.message)
  }

  const launch = await claudeCli.startLogin({ name, scope: installScope, projectPath })

  return {
    connection: await getConnectionDetails(newId),
    authorizationStarted: true,
    launchId: launch?.launchId || null
  }
}

/**
 * Rename a connection. Claude Code has no rename primitive — the CLI keys the
 * OAuth token by server name — so this is a re-registration under the new
 * name (same mechanics as duplicateConnection, requiring the client secret and
 * a fresh authorization) followed by removing the old entry.
 *
 * A disabled source is re-parked under the new name instead of authorized:
 * registerServer always writes a live entry, but reauthorizing something the
 * user deliberately turned off would be surprising, so the off state is
 * restored immediately after registration and no login flow is started.
 *
 * Because Claude Code's own config is the source of truth VS Code's Claude
 * Code extension reads, the rename is visible there too without any
 * extra sync step.
 */
export async function renameConnection(id, { name, providedSecret } = {}) {
  const source = await findConnection(id)
  if (source.target === 'codex') {
    throw new Error(
      `"${source.name}" is a Codex connection; renaming isn't supported for Codex yet. Delete it ` +
        'and add it again under the new name instead.'
    )
  }
  const newName = (name || '').trim()
  if (!newName) throw new Error('A name is required.')
  if (newName === source.name) {
    return { connection: await getConnectionDetails(id), authorizationStarted: false }
  }

  await assertNameAvailable({
    target: 'claude',
    scope: source.installScope,
    projectPath: source.projectPath,
    name: newName
  })

  const isPublic = readMeta()[source.id]?.clientType === 'public'
  const clientSecret = providedSecret || secrets.getSecret(source)
  if (!isPublic && !clientSecret) {
    throw new Error(
      'The OAuth client secret for this connection is not stored on this machine, and renaming ' +
        'it requires re-registering under the new name. Enter the client secret to continue.'
    )
  }

  const entry = configFile.buildEntry({
    url: source.url,
    clientId: source.clientId,
    callbackPort: source.callbackPort,
    scopes: source.scopes,
    metadataUrl: source.metadataUrl
  })

  await claudeCli.registerServer({
    name: newName,
    entry,
    scope: source.installScope,
    projectPath: source.projectPath,
    clientSecret
  })

  const newId = makeId({
    installScope: source.installScope,
    projectPath: source.projectPath,
    name: newName
  })
  invalidateServerState(newId)
  if (clientSecret) secrets.storeSecret({ id: newId, name: newName }, clientSecret)
  mutateMeta((m) => {
    m[newId] = { ...(m[newId] || {}), clientType: isPublic ? 'public' : 'confidential' }
  })

  // Now drop the old entry. A parked source has to be unparked first, for the
  // same reason delete does: `claude mcp remove` cannot see
  // `mcpServersDisabled`. Without this the old entry survived under its old
  // name and came back in the list as a second, disabled connection.
  const oldTarget = {
    scope: source.installScope,
    projectPath: source.projectPath,
    name: source.name
  }
  if (source.disabled && source.installScope !== 'project') {
    configFile.unparkServer(oldTarget)
  }
  const removal = await claudeCli.removeServer({
    name: source.name,
    scope: source.installScope,
    projectPath: source.projectPath
  })
  invalidateServerState(id)
  // Verify against the configuration rather than trusting the exit code, and
  // say so plainly if it didn't work — the alternative is two entries for one
  // connection and no indication of why.
  if (configFile.readServerEntry(oldTarget)) {
    throw new Error(
      `"${newName}" was registered, but "${source.name}" could not be removed, so both now ` +
        `exist. Delete "${source.name}" manually. ${removal.output || ''}`.trim()
    )
  }
  secrets.deleteSecret(source)
  if (source.installScope === 'project' && source.disabled) {
    // The disabled flag is keyed by name, so it has to move with the rename.
    claudeSettings.setProjectServerDisabled(source.projectPath, source.name, false)
  }

  // Carry the drift/exclusion record over so the rename doesn't masquerade as
  // a fresh connection on the next scope check.
  mutateMeta((m) => {
    if (m[id]) {
      m[newId] = m[id]
      delete m[id]
    }
  })

  let authorizationStarted = false
  let launch = null
  if (source.disabled) {
    if (source.installScope === 'project') {
      claudeSettings.setProjectServerDisabled(source.projectPath, newName, true)
    } else {
      configFile.parkServer({
        scope: source.installScope,
        projectPath: source.projectPath,
        name: newName
      })
    }
  } else {
    launch = await claudeCli.startLogin({
      name: newName,
      scope: source.installScope,
      projectPath: source.projectPath
    })
    authorizationStarted = true
  }

  return {
    connection: await getConnectionDetails(newId),
    authorizationStarted,
    launchId: launch?.launchId || null
  }
}

/** The id a connection will have once written, so the wizard can poll for it. */
export function connectionId({ target, installScope, projectPath, name }) {
  return makeId({
    target: target === 'codex' ? 'codex' : 'claude',
    installScope: target === 'codex' ? 'user' : installScope,
    projectPath: target === 'codex' ? null : projectPath || null,
    name
  })
}
