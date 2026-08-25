import { createContext, useContext, useMemo, useState, useCallback } from 'react'
import {
  applicationOf,
  deriveEndpoints,
  groupScopesByApplication,
  isApplicationScope,
  isValidServerName,
  TARGETS
} from '../../../shared/mcp'

// Re-exported so the wizard steps keep importing these from one place. The
// definitions live in src/shared/mcp.js because the main process applies the
// same scope filter when diffing scopes for the refresh flow, and enforces the
// same server-name rule before the name reaches a command line.
export {
  isApplicationScope,
  applicationOf,
  groupScopesByApplication,
  deriveEndpoints,
  isValidServerName,
  TARGETS
}

export function isValidUrl(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function isValidPort(value) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 65535
}

/**
 * Step 2's gate. Every field is mandatory, and the URL and port must parse —
 * lives here rather than inside the step because the wizard's footer bar owns
 * the Next button and needs to know when to enable it.
 *
 * `targets` shapes which fields actually matter: a callback port only means
 * anything for Claude Code, and a client secret is never required for Codex
 * (it has no secret concept at all — see services/codexCli.js) even if the
 * client type radio is left on "confidential" for Claude Code's own half of
 * a dual-target run.
 */
export function serverDetailsValid(server, targets) {
  const wantsClaude = targets ? targets.claude : true
  return (
    // Not just non-empty: the name ends up on a command line, so the main
    // process rejects anything outside a conservative allowlist. Gate it here
    // too, or Next would lead to a failure five steps later.
    isValidServerName(server.name.trim()) &&
    isValidUrl(server.baseUrl) &&
    server.clientId.trim().length > 0 &&
    // A public client has no secret to give — only a confidential Claude Code
    // client requires one. Codex never does, regardless of clientType.
    (!wantsClaude || server.clientType === 'public' || server.secret.length > 0) &&
    (!wantsClaude || isValidPort(server.callbackPort))
  )
}

export const STEPS = [
  { n: 1, title: 'Target & prerequisites' },
  { n: 2, title: 'Server details' },
  { n: 3, title: 'Connectivity' },
  { n: 4, title: 'Review' },
  { n: 5, title: 'Write & authorize' },
  { n: 6, title: 'Finish' }
]

export const LAST_STEP = STEPS.length

/** A fresh step-5 status block for one target — see the `install` state below. */
function freshInstallStatus() {
  return {
    ran: false,
    writeStatus: 'pending',
    pathStatus: 'pending',
    entryStatus: 'pending',
    oauthStatus: 'pending',
    authStatus: 'pending',
    entryVerified: null,
    oauth: null,
    error: null,
    connection: null // the authoritative connection, once written
  }
}

const initialState = {
  step: 1,
  // Step 1 — which app(s) to register this connector into. Claude Code stays
  // the default so a user who ignores the new picker sees the same behavior
  // as before targets existed.
  targets: { claude: true, codex: false },
  // Step 2 — server details. `baseUrl` is the Indicium base URL; the MCP
  // endpoint and OAuth metadata URL are derived from it (see `endpoints`).
  server: {
    name: '',
    baseUrl: '',
    // 'confidential' clients authenticate with a client secret; 'public'
    // clients (PKCE) have none — only the client ID. Governs Claude Code's
    // registration only; Codex is always public regardless of this value.
    clientType: 'confidential',
    clientId: '',
    secret: '',
    callbackPort: '8080'
  },
  // Step 3 — connectivity results
  connectivity: {
    ran: false,
    reachability: null, // { ok, status, timeMs, message, errorType }
    metadata: null, // { ok, metadataUrl, scopes, message, errorType }
    scopes: [], // [{ name, selected }]
    manualScopesText: ''
  },
  // Step 4 chooses the install scope; step 5 locates the config and writes.
  config: {
    located: null, // { found, path }
    configPath: null,
    valid: false,
    // Claude Code's own scope names; see SCOPES in src/shared/mcp.js. The
    // wizard offers `user` and `local` only — `project` writes to a shared
    // .mcp.json, which is no place for a client secret.
    installScope: 'user', // 'user' | 'local'
    projects: [],
    projectPath: null,
    casing: null, // { hasMismatch, variants }
    duplicateVariants: null,
    written: false
  },
  // Step 5 — write, verify, authorize, keyed by target: both can run in one
  // pass, each with its own status sequence (Codex's is shorter — see
  // StepWriteAndAuthorize, it has no callback-port/OAuth-credential rows).
  install: {
    claude: freshInstallStatus(),
    codex: freshInstallStatus()
  },
  system: null
}

const WizardContext = createContext(null)

/**
 * Wizard state. Mounted only while the wizard is open, so closing it discards
 * the entered client secret rather than leaving it in memory behind the list.
 */
export function WizardProvider({ children }) {
  const [state, setState] = useState(initialState)

  // Shallow-merge a patch into a top-level slice (or the root when key omitted).
  const update = useCallback((key, patch) => {
    setState((s) => {
      if (key == null) return { ...s, ...patch }
      return { ...s, [key]: { ...s[key], ...patch } }
    })
  }, [])

  const goTo = useCallback((n) => {
    setState((s) => ({ ...s, step: Math.min(LAST_STEP, Math.max(1, n)) }))
  }, [])

  const goNext = useCallback(
    () => setState((s) => ({ ...s, step: Math.min(LAST_STEP, s.step + 1) })),
    []
  )
  const goBack = useCallback(() => setState((s) => ({ ...s, step: Math.max(1, s.step - 1) })), [])

  const reset = useCallback(() => setState(initialState), [])

  // Derived: the effective list of selected scope names (discovered + manual).
  const selectedScopes = useMemo(() => {
    const fromDiscovery = state.connectivity.scopes.filter((s) => s.selected).map((s) => s.name)
    const manual = state.connectivity.manualScopesText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    // De-duplicate while preserving order.
    return Array.from(new Set([...fromDiscovery, ...manual]))
  }, [state.connectivity.scopes, state.connectivity.manualScopesText])

  // Derived: the URLs built from the Indicium base URL. The user only ever
  // enters the base; the MCP endpoint and OAuth metadata path are appended here.
  const endpoints = useMemo(() => deriveEndpoints(state.server.baseUrl), [state.server.baseUrl])

  // Derived: which targets are checked, in TARGETS order, so every step that
  // needs to loop over "the targets this run covers" agrees on the order.
  const selectedTargets = useMemo(
    () => TARGETS.filter((t) => state.targets[t]),
    [state.targets]
  )

  const value = useMemo(
    () => ({ state, update, goTo, goNext, goBack, reset, selectedScopes, endpoints, selectedTargets }),
    [state, update, goTo, goNext, goBack, reset, selectedScopes, endpoints, selectedTargets]
  )

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>
}

export function useWizard() {
  const ctx = useContext(WizardContext)
  if (!ctx) throw new Error('useWizard must be used within WizardProvider')
  return ctx
}
