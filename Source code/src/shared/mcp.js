// Logic shared by the main process and the renderer. Both bundle this file
// directly (it crosses no IPC boundary) so the two can't drift apart — the
// scope filter in particular has to agree, or the wizard would offer scopes the
// refresh-scopes diff would then report as unknown.

/**
 * Application scopes look like `application_name/scope_name`. The server also
 * advertises protocol scopes such as `openid` and `offline_access`, which are
 * not application scopes and must not be offered or written to the config.
 */
export function isApplicationScope(name) {
  return /^[^/\s]+\/[^/\s]+$/.test(name)
}

/**
 * Whether a server name is safe to put on a command line.
 *
 * A server name reaches two places that cannot be escaped reliably: a Windows
 * command line routed through `cmd.exe` (which re-parses metacharacters and does
 * not understand the `\"` escaping Node applies), and the generated
 * authorization script. So names are restricted to a conservative allowlist
 * rather than escaped per call site — Claude Code's own names already fit it.
 *
 * Not every name in the config was typed by this app's user: project-scoped
 * servers are read from a `.mcp.json` that is committed to a repository, so a
 * name can arrive from a third party.
 *
 * A space is allowed: existing configurations legitimately contain names like
 * "My Server", and a space is inert everywhere the name is used — both generated
 * scripts quote it, and Node quotes it correctly for cmd.exe as long as the name
 * carries no `"`. Leading/trailing whitespace is rejected so a name can't differ
 * from its trimmed form, which callers compare against.
 */
const SERVER_NAME_CHARS = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/

export function isValidServerName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 64 &&
    name === name.trim() &&
    SERVER_NAME_CHARS.test(name)
  )
}

/**
 * Whether a value can be passed through `cmd.exe` without changing how the
 * command line parses. Covers quote state (`"`), command chaining (`&`, `|`),
 * redirection (`<`, `>`), cmd's escape character (`^`) and line breaks.
 *
 * `%`, `$` and backtick are deliberately NOT rejected: `%VAR%` only expands
 * from an environment we control, `$`/backtick matter to POSIX shells and no
 * POSIX path here goes through one, and all three appear in legitimate URLs.
 */
export function isShellSafeValue(value) {
  return typeof value === 'string' && !/["&|<>^\r\n]/.test(value)
}

/** Split `application_name/scope_name` into its application prefix. */
export function applicationOf(name) {
  return name.split('/')[0]
}

/**
 * Group scope objects by their application prefix, preserving first-seen order.
 * Returns [{ application, scopes: [...] }].
 */
export function groupScopesByApplication(scopes) {
  const groups = new Map()
  for (const s of scopes) {
    const app = applicationOf(s.name)
    if (!groups.has(app)) groups.set(app, [])
    groups.get(app).push(s)
  }
  return Array.from(groups, ([application, list]) => ({ application, scopes: list }))
}

/**
 * Same grouping for bare scope-name strings, sorted by application so a long
 * list reads consistently. Returns [{ application, names: [...] }].
 */
export function groupScopeNamesByApplication(names) {
  const groups = new Map()
  for (const name of names) {
    const app = applicationOf(name)
    if (!groups.has(app)) groups.set(app, [])
    groups.get(app).push(name)
  }
  return Array.from(groups, ([application, list]) => ({
    application,
    names: list.slice().sort()
  })).sort((a, b) => a.application.localeCompare(b.application))
}

/**
 * Claude Code's MCP configuration scopes. These are the CLI's own names, used
 * verbatim as our internal values so nothing has to be translated at the
 * boundary:
 *
 *  - `local`   (the CLI's default) only you, in one project. Stored in
 *              ~/.claude.json under projects[<path>].mcpServers.
 *  - `project` shared with everyone via a .mcp.json committed to the repo.
 *  - `user`    you, across every project. Top-level mcpServers in ~/.claude.json.
 *
 * Naming matters here: Claude Code's older releases called `local` "project"
 * and called `user` "global". Reusing those retired names would mean this app's
 * "project" meant the opposite of Claude Code's, so we don't.
 */
export const SCOPES = ['user', 'local', 'project']

export const SCOPE_LABELS = {
  user: {
    label: 'User',
    short: 'User',
    description: 'Available in every project you open on this machine'
  },
  local: {
    label: 'Local',
    short: 'Local',
    description: 'Available only within this specific project on this machine'
  },
  project: {
    label: 'Project',
    short: 'Project',
    description: 'Shared with everyone via the project’s .mcp.json'
  }
}

// Codex support is fully implemented but not yet ready to show users.
// Flip this to re-enable it everywhere at once (wizard, connections list,
// status checks) — everything downstream derives from TARGETS below, so
// nothing else needs to change.
export const CODEX_ENABLED = false

/**
 * The applications this manager can register an MCP connector into. Claude
 * Code and Codex CLI have unrelated config files, CLIs and OAuth models — see
 * services/claudeCli.js and services/codexCli.js — but both are driven from
 * one wizard, so the wizard and the connections list need a name for "which
 * app is this connection in" alongside the existing per-app scope.
 */
export const TARGETS = CODEX_ENABLED ? ['claude', 'codex'] : ['claude']

export const TARGET_LABELS = {
  claude: {
    label: 'Claude Code',
    description: 'Registered through the Claude Code CLI, in ~/.claude.json.'
  },
  codex: {
    label: 'Codex',
    description: 'Registered through the Codex CLI, in ~/.codex/config.toml.'
  }
}

/**
 * Each target has its own scope vocabulary. Claude Code has three (see
 * SCOPES above); Codex only supports its global config in this app for now —
 * project-scoped, trust-gated Codex config is a distinct feature, not
 * modeled here yet.
 */
export const TARGET_SCOPES = {
  claude: SCOPES,
  codex: ['user']
}

/**
 * Scope labels, per target — Codex's single scope is its global config, which
 * reads better as "Global" than the Claude-Code-specific "User" wording.
 */
export const TARGET_SCOPE_LABELS = {
  claude: SCOPE_LABELS,
  codex: {
    user: {
      label: 'Global',
      short: 'Global',
      description: 'Available in every project you open on this machine'
    }
  }
}

/**
 * Given the Indicium base URL the user typed, derive every URL we need. The
 * user enters e.g. `https://web10.thinkwise.app/pm_mcp_test_indicium`; we append
 * `/mcp` for the MCP endpoint and `/.well-known/openid-configuration` for OAuth
 * metadata. A trailing slash or an accidentally-included `/mcp` suffix is
 * normalized away so both forms resolve to the same base.
 */
export function deriveEndpoints(rawBaseUrl) {
  const base = (rawBaseUrl || '')
    .trim()
    .replace(/\/+$/, '') // drop trailing slashes
    .replace(/\/mcp$/i, '') // tolerate a pasted MCP URL
  if (!base) return { baseUrl: '', mcpUrl: '', metadataUrl: '' }
  return {
    baseUrl: base,
    mcpUrl: `${base}/mcp`,
    metadataUrl: `${base}/.well-known/openid-configuration`
  }
}

/**
 * Recover the base URL from a stored MCP endpoint, for connections we read back
 * out of the config rather than collect through the wizard.
 */
export function baseUrlOf(mcpUrl) {
  return deriveEndpoints(mcpUrl).baseUrl
}

/** Scope diff between what a connection has and what the server now advertises. */
export function diffScopes(current, advertised) {
  const cur = new Set(current)
  const adv = new Set(advertised)
  return {
    added: advertised.filter((s) => !cur.has(s)),
    removed: current.filter((s) => !adv.has(s)),
    unchanged: current.filter((s) => adv.has(s))
  }
}
