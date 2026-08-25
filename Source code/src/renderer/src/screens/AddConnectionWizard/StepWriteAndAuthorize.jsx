import { useEffect, useRef } from 'react'
import { Alert, Box, Button, Typography } from '@mui/material'
import StatusRow from '../../components/StatusRow'
import ReopenAuthorizationButton from '../../components/ReopenAuthorizationButton'
import ErrorDetail from '../../components/ErrorDetail'
import { brand } from '../../theme'
import { useWizard } from '../../state/WizardContext'
import { AUTH_POLL_MS, AUTH_TIMEOUT_MS, launchFailureMessage } from '../../state/ConnectionsContext'
import { TARGET_LABELS } from '../../../../shared/mcp'

/**
 * Write, verify, authorize — the plan folds the original installer's separate
 * config-write, path-check and verification steps into this one step, and it
 * runs automatically on entry, once per selected target.
 *
 * Claude Code and Codex run through genuinely different sequences: Claude
 * Code's has a path-casing check and an OAuth-credential-stored check with no
 * Codex equivalent (Codex has no project-path concept in this app, and
 * nothing analogous to "is the secret stored" — see services/codexCli.js).
 * Rather than force one row list to fit both, each target gets its own
 * status-row group and its own runner.
 */
export default function StepWriteAndAuthorize() {
  const { state, update, selectedScopes, selectedTargets, endpoints } = useWizard()
  const { server, config, connectivity } = state
  const cancelled = useRef(false)

  const metadataUrl = connectivity.metadata?.metadataUrl || endpoints.metadataUrl

  useEffect(() => {
    cancelled.current = false
    for (const target of selectedTargets) {
      if (!state.install[target].ran) run(target)
    }
    return () => {
      cancelled.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function run(target) {
    let current = {
      ran: true,
      writeStatus: 'pending',
      pathStatus: 'pending',
      entryStatus: 'pending',
      oauthStatus: 'pending',
      authStatus: 'pending',
      entryVerified: null,
      oauth: null,
      error: null,
      pathError: null,
      connection: null
    }
    const patch = (p) => {
      current = { ...current, ...p }
      if (!cancelled.current) update('install', { [target]: current })
      return current
    }
    patch({})

    if (target === 'codex') {
      await runCodex(patch)
    } else {
      await runClaude(patch)
    }
  }

  /** Claude Code: path check → write via the CLI → verify entry → verify the
   * stored OAuth credentials → authorize. Unchanged from before targets
   * existed, aside from reading/writing `install.claude` instead of the flat
   * `install` object. */
  async function runClaude(patch) {
    patch({ pathStatus: 'running', writeStatus: 'pending', entryStatus: 'pending', oauthStatus: 'pending', authStatus: 'pending', error: null })

    // 1. Path check — casing/slash variants of the same project path produce
    // duplicate keys that Claude Code treats as distinct projects (Windows).
    // Only meaningful for `local` scope, which is keyed by project path;
    // `user`/`project` scope never touches `projects[*]`, so running it
    // without a project path would otherwise fall back to scanning every
    // project entry in the file and reporting unrelated pre-existing
    // duplicates as if they were part of this connection's write.
    if (config.installScope !== 'local') {
      patch({ pathStatus: 'success' })
    } else {
      try {
        const casing = await window.api.config.casingCheck(config.configPath, config.projectPath)
        patch({
          casing,
          pathStatus: casing.hasMismatch ? 'error' : 'success',
          duplicateVariants: casing.hasMismatch ? casing.variants.flatMap((v) => v.keys) : null
        })
      } catch (e) {
        // A distinct field from `error` (shared by the write/auth rows below):
        // this catch is specifically for the path-casing check throwing (an
        // I/O error, say) rather than actually finding a casing conflict —
        // the two used to be indistinguishable in the UI, see TargetProgress.
        patch({ pathStatus: 'error', pathError: e.message })
      }
    }

    // 2. Write. Registration goes through the Claude Code CLI rather than a
    // plain JSON write: it's the only path that also stores the OAuth client
    // secret in Claude Code's credential store. See services/claudeCli.js.
    patch({ writeStatus: 'running' })
    let connection
    try {
      connection = await window.api.connections.add({
        target: 'claude',
        name: server.name,
        url: endpoints.mcpUrl,
        clientType: server.clientType,
        clientId: server.clientId,
        clientSecret: server.clientType === 'public' ? undefined : server.secret,
        callbackPort: server.callbackPort,
        scopes: selectedScopes,
        // The full set the server advertised, not just what's selected — lets
        // addConnection() remember which scopes were deliberately left out, so
        // the first later "Refresh scopes" doesn't mistake them for new drift.
        allScopes: connectivity.scopes.map((s) => s.name),
        metadataUrl,
        installScope: config.installScope,
        projectPath: config.projectPath
      })
      patch({ connection, writeStatus: 'success' })
      update('config', { written: true })
    } catch (e) {
      patch({ writeStatus: 'error', error: e.message })
      return
    }

    // 3. Read the entry back and confirm it matches. Must exist, point at the
    // MCP endpoint, and carry `type: http` — without `type`, Claude Code skips
    // the server entirely.
    patch({ entryStatus: 'running' })
    let entryOk = false
    try {
      const res = await window.api.config.readEntry({
        filePath: config.configPath,
        scope: config.installScope,
        projectPath: config.projectPath,
        name: server.name
      })
      entryOk = res.exists && res.entry?.url === endpoints.mcpUrl && res.entry?.type === 'http'
      patch({ entryVerified: { ...res, matches: entryOk }, entryStatus: entryOk ? 'success' : 'error' })
    } catch (e) {
      patch({ entryVerified: { exists: false, matches: false, error: e.message }, entryStatus: 'error' })
    }
    if (!entryOk) return

    // 4. Confirm Claude Code actually holds the OAuth credentials. The client
    // secret lives in Claude Code's keychain, not the config file, so this is
    // the only way to know the browser login will be able to finish.
    patch({ oauthStatus: 'running' })
    const isPublic = server.clientType === 'public'
    let oauthOk = false
    try {
      const oauth = await window.api.claude.get({
        name: server.name,
        scope: config.installScope,
        projectPath: config.projectPath
      })
      oauthOk = oauth.found && oauth.clientIdConfigured && (isPublic || oauth.clientSecretConfigured)
      patch({ oauth, oauthStatus: oauthOk ? 'success' : 'error' })
    } catch (e) {
      patch({ oauth: { error: e.message }, oauthStatus: 'error' })
    }
    if (!oauthOk) return

    patch({ authStatus: 'running', error: null })
    let launchId = null
    try {
      // The launch token lets the poller below notice a terminal that never
      // opened, instead of waiting out the full timeout.
      const launch = await window.api.claude.startLogin({
        name: server.name,
        scope: config.installScope,
        projectPath: config.projectPath
      })
      launchId = launch?.launchId || null
    } catch (e) {
      patch({ authStatus: 'error', error: e.message })
      return
    }
    await pollForConnected(connection, patch, launchId)
  }

  /**
   * Codex: write via the CLI → verify entry → authorize. Shorter than
   * Claude's — no project path to check for casing, and nothing analogous to
   * "is the OAuth credential stored": Codex has no client secret at all, and
   * `codex mcp get` is itself the verification (see codexCli.js).
   */
  async function runCodex(patch) {
    patch({ writeStatus: 'running', entryStatus: 'pending', authStatus: 'pending', error: null })

    let connection
    try {
      connection = await window.api.connections.add({
        target: 'codex',
        name: server.name,
        url: endpoints.mcpUrl,
        clientId: server.clientId
      })
      patch({ connection, writeStatus: 'success' })
    } catch (e) {
      patch({ writeStatus: 'error', error: e.message })
      return
    }

    patch({ entryStatus: 'running' })
    let entryOk = false
    try {
      const res = await window.api.codex.get({ name: server.name })
      entryOk = res.found && res.url === endpoints.mcpUrl
      patch({ entryVerified: { ...res, matches: entryOk }, entryStatus: entryOk ? 'success' : 'error' })
    } catch (e) {
      patch({ entryVerified: { exists: false, matches: false, error: e.message }, entryStatus: 'error' })
    }
    if (!entryOk) return

    patch({ authStatus: 'running', error: null })
    let launchId = null
    try {
      const launch = await window.api.codex.startLogin({
        name: server.name,
        scopes: selectedScopes
      })
      launchId = launch?.launchId || null
    } catch (e) {
      patch({ authStatus: 'error', error: e.message })
      return
    }
    await pollForConnected(connection, patch, launchId)
  }

  /**
   * `claude mcp login` / `codex mcp login` both need a real terminal (they
   * reject a piped stdin), so we launch one and watch for the result here —
   * the user only ever deals with the browser.
   *
   * Every poll's own error used to be discarded outright, so a sign-in stuck
   * for the full 5-minute timeout showed nothing but a spinner the whole
   * time, then one fixed sentence at the end. `pollError` now tracks the most
   * recent one, surfaced live in the "waiting" row once it's repeated a few
   * times in a row (skip the first couple — expected transient hiccups, not
   * worth flagging) and carried into the timeout message either way.
   */
  async function pollForConnected(connection, patch, launchId = null) {
    const startedAt = Date.now()
    let consecutiveFailures = 0
    let lastPollError = null
    for (;;) {
      await new Promise((r) => setTimeout(r, AUTH_POLL_MS))
      if (cancelled.current) return
      try {
        const fresh = await window.api.connections.get(connection.id)
        if (fresh.status === 'connected') {
          patch({ authStatus: 'success', connection: fresh, pollError: null })
          return
        }
        consecutiveFailures = 0
        lastPollError = null
        patch({ pollError: null })
      } catch (e) {
        consecutiveFailures += 1
        lastPollError = e.message
        if (consecutiveFailures >= 3) patch({ pollError: lastPollError })
      }
      // A launch that never produced a terminal, or a sign-in that already
      // failed behind the `pause`, is knowable in seconds — don't sit on it
      // for the full timeout.
      if (launchId) {
        let probe = null
        try {
          probe = await window.api.claude.launchStatus(launchId)
        } catch {
          // Unreadable probe is not a reason to abandon the wait.
        }
        const failure = launchFailureMessage(probe, Date.now() - startedAt)
        if (failure) {
          patch({ authStatus: 'error', error: failure, errorDetail: lastPollError })
          return
        }
      }
      if (Date.now() - startedAt > AUTH_TIMEOUT_MS) {
        patch({
          authStatus: 'error',
          error:
            'Timed out waiting for the sign-in to complete. Finish the sign-in in the terminal ' +
            'window, or reopen the authorization window and try again.',
          errorDetail: lastPollError
        })
        return
      }
    }
  }

  return (
    <Box>
      {selectedTargets.map((target) => (
        <TargetProgress
          key={target}
          target={target}
          install={state.install[target]}
          server={server}
          scope={config.installScope}
          projectPath={config.projectPath}
          scopes={selectedScopes}
          onRetry={() => run(target)}
          onReopenError={(msg) => {
            if (!cancelled.current) {
              update('install', { [target]: { ...state.install[target], error: msg } })
            }
          }}
        />
      ))}
    </Box>
  )
}

/** One target's status-row group, error handling and retry/reopen affordances. */
function TargetProgress({ target, install, server, scope, projectPath, scopes, onRetry, onReopenError }) {
  const s = (k) => install[k] || 'pending'
  const isClaude = target === 'claude'

  return (
    <Box sx={{ mb: 3.5, '&:last-of-type': { mb: 0 } }}>
      <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1.5 }}>
        {TARGET_LABELS[target].label}
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, mb: 2 }}>
        <StatusRow
          status={s('writeStatus')}
          title="Configuration written"
          subtitle={
            s('writeStatus') === 'success'
              ? `Entry added to the ${TARGET_LABELS[target].label} configuration.`
              : s('writeStatus') === 'error'
                ? install.error || 'The entry could not be written.'
                : 'Registering the server…'
          }
        />
        {isClaude && (
          <StatusRow
            status={s('pathStatus')}
            title="Path check"
            subtitle={
              s('pathStatus') === 'success' ? (
                'No casing or slash conflicts found.'
              ) : s('pathStatus') === 'error' ? (
                install.casing?.hasMismatch ? (
                  `Path casing/slash variants were detected${
                    install.duplicateVariants ? ` (${install.duplicateVariants.length} keys)` : ''
                  }. Claude Code may treat them as separate projects.`
                ) : (
                  <ErrorDetail
                    summary="The path check could not run."
                    detail={install.pathError}
                  />
                )
              ) : (
                'Scanning project paths…'
              )
            }
          />
        )}
        <StatusRow
          status={s('entryStatus')}
          title="Config entry verified"
          subtitle={
            s('entryStatus') === 'success' ? (
              'Matches what was written'
            ) : s('entryStatus') === 'error' ? (
              <ErrorDetail
                summary="The written entry could not be confirmed."
                detail={install.entryVerified?.error}
              />
            ) : (
              'Reading the config back…'
            )
          }
        />
        {isClaude && (
          <StatusRow
            status={s('oauthStatus')}
            title="OAuth credentials stored"
            subtitle={
              s('oauthStatus') === 'success'
                ? install.oauth?.oauthLine ||
                  (server.clientType === 'public'
                    ? 'Client ID is registered'
                    : 'Client ID and client secret are registered')
                : s('oauthStatus') === 'error'
                  ? (
                      <ErrorDetail
                        summary={
                          server.clientType === 'public'
                            ? 'Client ID is not stored — authentication would not complete'
                            : 'Client secret is not stored — authentication would not complete'
                        }
                        detail={install.oauth?.error}
                      />
                    )
                  : 'Checking stored credentials…'
            }
          />
        )}
        <StatusRow
          status={s('authStatus')}
          title={s('authStatus') === 'success' ? 'Authorized' : 'Waiting for authorization'}
          subtitle={
            s('authStatus') === 'success' ? (
              install.connection?.statusDetail || 'Connected and ready to use.'
            ) : s('authStatus') === 'error' ? (
              <ErrorDetail summary={install.error || 'The sign-in did not finish.'} detail={install.errorDetail} />
            ) : s('authStatus') === 'running' ? (
              install.pollError ? (
                <ErrorDetail
                  summary="Still waiting — complete the OAuth prompt in the browser window that opened."
                  detail={`Last check failed: ${install.pollError}`}
                />
              ) : (
                'Complete the OAuth prompt in the browser window that opened.'
              )
            ) : (
              'Waiting for the steps above…'
            )
          }
        />
      </Box>

      {s('authStatus') === 'running' && (
        <>
          <Typography sx={{ fontSize: 12.5, color: brand.textSecondary, mb: 1.5, lineHeight: 1.6 }}>
            A terminal window is running the sign-in and your browser should have opened. If you
            don't see it, reopen the authorization window below. You can close the terminal once it
            reports success.
          </Typography>
          <ReopenAuthorizationButton
            target={target}
            name={server.name}
            scope={scope}
            projectPath={projectPath}
            scopes={scopes}
            onError={onReopenError}
          />
        </>
      )}

      {isClaude && s('entryStatus') === 'error' && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <ErrorDetail
            summary="The entry couldn't be verified. Go back to review the details and try again."
            detail={install.entryVerified?.error}
          />
        </Alert>
      )}

      {isClaude && s('oauthStatus') === 'error' && s('entryStatus') === 'success' && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <ErrorDetail
            summary={
              server.clientType === 'public'
                ? "The OAuth client ID isn't stored with Claude Code. Authorization would start in " +
                  'the browser but never finish. Go back and check the client ID, then try again.'
                : "The OAuth client secret isn't stored with Claude Code. Authorization would " +
                  'start in the browser but never finish. Go back and check the client secret, ' +
                  'then try again.'
            }
            detail={install.oauth?.error}
          />
        </Alert>
      )}

      {(s('writeStatus') === 'error' || s('authStatus') === 'error') && (
        <Box sx={{ mt: 2 }}>
          <Button variant="contained" onClick={onRetry}>
            Try again
          </Button>
        </Box>
      )}
    </Box>
  )
}
