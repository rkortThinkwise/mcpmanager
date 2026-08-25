import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const ConnectionsContext = createContext(null)

// How long to wait for a browser authorization to land, and how often to ask.
// Matches the wizard's authorize step: the CLI drives the flow, we just watch.
// How long to give the terminal window to appear before concluding it never
// will. Generous compared to the ~instant reality of `start`, but a cold
// Windows Terminal launch on a loaded machine is not instant.
export const LAUNCH_START_GRACE_MS = 12000

/**
 * Decide whether a sign-in is doomed, from the markers the launch script writes.
 *
 * Returns an error message, or null to keep waiting. This is what stops the
 * worst failure in the app: when the terminal never opened at all, every poll
 * looked exactly like a user who simply hadn't finished in the browser yet, so
 * the only outcome was a five-minute timeout with nothing to act on.
 */
export function launchFailureMessage(probe, elapsedMs) {
  if (!probe || !probe.known) return null
  if (probe.exited && probe.exitCode !== 0 && probe.exitCode !== null) {
    return (
      'The sign-in command finished without authorizing this connection. ' +
      'Check the terminal window for the error it printed.'
    )
  }
  if (!probe.started && elapsedMs > LAUNCH_START_GRACE_MS) {
    return (
      'The sign-in terminal never opened, so authorization could not start. ' +
      'Antivirus or a security policy may be blocking it. Try again, or run ' +
      '`claude mcp login` yourself in a terminal.'
    )
  }
  return null
}

/** Best-effort probe: a failure to read it must not end the wait. */
async function readLaunchProbe(launchId) {
  if (!launchId) return null
  try {
    return await window.api.claude.launchStatus(launchId)
  } catch {
    return null
  }
}

export const AUTH_POLL_MS = 2000
export const AUTH_TIMEOUT_MS = 5 * 60 * 1000

export function ConnectionsProvider({ children }) {
  const [connections, setConnections] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [system, setSystem] = useState(null)
  const [systemError, setSystemError] = useState(null)
  const [settings, setSettings] = useState(null)
  const [settingsLoadError, setSettingsLoadError] = useState(null)
  const [codexListError, setCodexListError] = useState(null)
  const [checkingScopes, setCheckingScopes] = useState(false)

  const reload = useCallback(async () => {
    try {
      const list = await window.api.connections.list()
      setConnections(list)
      setError(null)
      // Paired with the list itself (see connections:codexHealth) rather
      // than folded into it, so a Codex CLI output-parsing failure can be
      // flagged without changing the list's own plain-array shape.
      try {
        const health = await window.api.connections.codexHealth()
        setCodexListError(health.codexListError)
      } catch {
        // Non-fatal: the list itself already loaded fine either way.
      }
      return list
    } catch (e) {
      setError(e.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  const reloadSettings = useCallback(async () => {
    try {
      setSettings(await window.api.settings.get())
      setSettingsLoadError(null)
    } catch (e) {
      // Settings are advisory; the app works on defaults without them — but
      // "couldn't reach settings:get at all" is worth showing, distinct from
      // settings.settingsCorrupted (a successful call reporting its own
      // settings.json was unreadable), which is already carried on the
      // `settings` object itself.
      setSettingsLoadError(e.message)
    }
  }, [])

  useEffect(() => {
    reload()
    reloadSettings()
    window.api.system
      .info()
      .then((info) => {
        setSystem(info)
        setSystemError(null)
      })
      .catch((e) => setSystemError(e.message))
  }, [reload, reloadSettings])

  // The periodic scope check runs in the main process, so the list has to be
  // told when it has recorded something new.
  useEffect(() => {
    const offChanged = window.api.connections.onChanged(() => {
      reload()
      reloadSettings()
    })
    const offChecking = window.api.scopes.onChecking(setCheckingScopes)
    return () => {
      offChanged()
      offChecking()
    }
  }, [reload, reloadSettings])

  const saveSettings = useCallback(async (patch) => {
    setSettings(await window.api.settings.set(patch))
  }, [])

  const checkScopesNow = useCallback(async () => {
    await window.api.scopes.checkNow()
    // The main process emits connections:changed when it finishes, which
    // reloads the list — nothing to do here.
  }, [])

  /**
   * Replace one connection in place from an authoritative main-process result,
   * so a single action doesn't cost a full re-list (which re-runs the CLI once
   * per connection).
   */
  const replace = useCallback((conn) => {
    setConnections((list) => list.map((c) => (c.id === conn.id ? conn : c)))
  }, [])

  const remove = useCallback((id) => {
    setConnections((list) => list.filter((c) => c.id !== id))
  }, [])

  /**
   * Enable or disable a connection. The main process returns the connection
   * re-read from config, so we replace from the authoritative result rather than
   * guessing the new state. Lossless in both directions — no re-authorization.
   */
  const setEnabled = useCallback(
    async (id, enabled) => {
      const conn = await window.api.connections.setEnabled(id, enabled)
      replace(conn)
      return conn
    },
    [replace]
  )

  /**
   * Poll until an authorization started in the browser completes. Resolves with
   * the connected connection, or throws with a plain-language timeout message.
   *
   * Every poll's own error used to be discarded outright, so a stuck sign-in
   * showed nothing for the full 5-minute timeout and then one fixed sentence.
   * The last one is now folded into that message: every caller already does
   * `setError(e.message)` and renders it verbatim, so appending it here makes
   * it show up everywhere this is used with no changes needed at each
   * call site.
   */
  const waitForAuthorization = useCallback(
    // `launchId` is optional: callers that don't have one (or a Codex login)
    // simply get the old timeout-only behaviour.
    async (id, launchId = null) => {
      const startedAt = Date.now()
      let lastError = null
      for (;;) {
        await new Promise((r) => setTimeout(r, AUTH_POLL_MS))
        try {
          const conn = await window.api.connections.get(id)
          // 'connected' or 'scope_drift' both mean authorization succeeded —
          // drift is about the scope set, not about whether we have a token.
          if (conn.status === 'connected' || conn.status === 'scope_drift') {
            replace(conn)
            return conn
          }
          lastError = null
        } catch (e) {
          lastError = e.message
        }
        // Checked after the status read, so a sign-in that completed in the
        // same tick still wins over a stale marker.
        const failure = launchFailureMessage(
          await readLaunchProbe(launchId),
          Date.now() - startedAt
        )
        if (failure) throw new Error(failure)
        if (Date.now() - startedAt > AUTH_TIMEOUT_MS) {
          throw new Error(
            'Timed out waiting for the authorization to complete. Finish the sign-in in the ' +
              'browser and terminal window, or try again.' +
              (lastError ? ` Last check failed: ${lastError}` : '')
          )
        }
      }
    },
    [replace]
  )

  const value = useMemo(
    () => ({
      connections,
      loading,
      error,
      system,
      systemError,
      settings,
      settingsLoadError,
      codexListError,
      checkingScopes,
      reload,
      replace,
      remove,
      setEnabled,
      saveSettings,
      checkScopesNow,
      waitForAuthorization
    }),
    [
      connections,
      loading,
      error,
      system,
      systemError,
      settings,
      settingsLoadError,
      codexListError,
      checkingScopes,
      reload,
      replace,
      remove,
      setEnabled,
      saveSettings,
      checkScopesNow,
      waitForAuthorization
    ]
  )

  return <ConnectionsContext.Provider value={value}>{children}</ConnectionsContext.Provider>
}

export function useConnections() {
  const ctx = useContext(ConnectionsContext)
  if (!ctx) throw new Error('useConnections must be used within ConnectionsProvider')
  return ctx
}
