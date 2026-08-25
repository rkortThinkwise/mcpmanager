import { useEffect, useState } from 'react'
import { Alert, Box, Button, Link, TextField, Typography } from '@mui/material'
import StatusRow from '../../components/StatusRow'
import ScopePicker from '../../components/ScopePicker'
import { brand } from '../../theme'
import { useWizard, isApplicationScope, groupScopesByApplication } from '../../state/WizardContext'

export default function StepConnectivity() {
  const { state, update, endpoints } = useWizard()
  const c = state.connectivity
  const [showManual, setShowManual] = useState(false)
  const wantsCodex = state.targets.codex

  async function runChecks() {
    update('connectivity', {
      ran: true,
      reachStatus: 'running',
      metaStatus: 'pending',
      scopeStatus: 'pending',
      reachability: null,
      metadata: null,
      scopes: []
    })

    // 1. Reachability — a hard gate for everything downstream. We probe the
    // MCP endpoint derived from the base URL.
    let reach
    try {
      reach = await window.api.connectivity.reachability(endpoints.mcpUrl)
    } catch (e) {
      reach = { ok: false, message: e.message }
    }
    update('connectivity', { reachability: reach, reachStatus: reach.ok ? 'success' : 'error' })
    if (!reach.ok) {
      update('connectivity', { metaStatus: 'pending', scopeStatus: 'pending' })
      return
    }

    // 2. Metadata discovery — from the Indicium base URL, not the MCP endpoint,
    // so the well-known path resolves to <base>/.well-known/openid-configuration.
    update('connectivity', { metaStatus: 'running' })
    let meta
    try {
      meta = await window.api.connectivity.metadata(endpoints.baseUrl)
    } catch (e) {
      meta = { ok: false, message: e.message }
    }
    update('connectivity', { metadata: meta, metaStatus: meta.ok ? 'success' : 'error' })

    // 3. Scope discovery from metadata. Only application scopes
    // (`application_name/scope_name`) are offered; protocol scopes the server
    // also advertises, such as `openid` and `offline_access`, are dropped.
    const appScopes = (meta.ok && meta.scopes ? meta.scopes : []).filter(isApplicationScope)
    if (appScopes.length) {
      update('connectivity', {
        scopes: appScopes.map((name) => ({ name, selected: true })),
        scopeStatus: 'success'
      })
    } else {
      // Reachable + metadata found but no application scopes advertised:
      // surface as an actionable error prompting manual entry.
      update('connectivity', { scopes: [], scopeStatus: 'error' })
    }
  }

  // Runs automatically on entering the step, once — no button to trigger it.
  useEffect(() => {
    if (!c.ran) runChecks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleScope = (name) => {
    update('connectivity', {
      scopes: c.scopes.map((s) => (s.name === name ? { ...s, selected: !s.selected } : s))
    })
  }

  // Select / deselect every scope belonging to one application at once.
  const setGroupSelection = (application, selected) => {
    update('connectivity', {
      scopes: c.scopes.map((s) => (s.name.startsWith(`${application}/`) ? { ...s, selected } : s))
    })
  }

  const groups = groupScopesByApplication(c.scopes)

  const reachStatus = c.reachStatus || 'pending'
  const metaStatus = c.metaStatus || 'pending'
  const scopeStatus = c.scopeStatus || 'pending'

  const reachSub =
    reachStatus === 'success'
      ? c.reachability?.message
      : reachStatus === 'error'
        ? c.reachability?.message
        : 'Contacting the server…'

  const scopeSub =
    scopeStatus === 'success'
      ? `${c.scopes.length} application scope${c.scopes.length === 1 ? '' : 's'} across ` +
        `${groups.length} application${groups.length === 1 ? '' : 's'}`
      : scopeStatus === 'error'
        ? 'Server did not advertise any application scopes — enter manually below'
        : 'Waiting for metadata…'

  return (
    <Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, mb: 2.5 }}>
        <StatusRow status={reachStatus} title="Reachability" subtitle={reachSub} />
        <StatusRow
          status={metaStatus}
          title="Metadata discovery"
          subtitle={
            metaStatus === 'success'
              ? c.metadata?.message
              : metaStatus === 'error'
                ? c.metadata?.message
                : 'Waiting for reachability…'
          }
        />
        <StatusRow status={scopeStatus} title="Scope discovery" subtitle={scopeSub} />
      </Box>

      {reachStatus === 'error' && (
        <Alert
          severity="error"
          sx={{ mb: 2.5 }}
          action={
            <Button color="inherit" size="small" onClick={runChecks}>
              Retry
            </Button>
          }
        >
          {c.reachability?.message || 'Could not reach the server.'} Every later step depends on
          this, so it must succeed before continuing.
        </Alert>
      )}

      {c.scopes.length > 0 && (
        <>
          <Typography sx={{ fontSize: 12.5, fontWeight: 500, color: brand.textSecondary, mb: 1 }}>
            Application scopes
          </Typography>
          {wantsCodex && (
            <Alert severity="info" sx={{ mb: 1.5, fontSize: 12.5 }}>
              For Codex, this selection is requested at sign-in (`codex mcp login --scopes`) rather
              than embedded in a registered entry the way Claude Code's is — the server's own policy
              still decides what's actually granted.
            </Alert>
          )}
          <Box sx={{ mb: 2.5 }}>
            <ScopePicker scopes={c.scopes} onToggleScope={toggleScope} onToggleGroup={setGroupSelection} />
          </Box>
        </>
      )}

      <Link
        component="button"
        type="button"
        onClick={() => setShowManual((v) => !v)}
        sx={{ fontSize: 12.5, display: 'block', mb: 1.75 }}
      >
        {showManual ? '− Hide manual entry' : '+ Add scope manually'}
      </Link>

      {showManual && (
        <Box sx={{ mb: 2.5 }}>
          <Alert severity="warning" sx={{ mb: 1.5, fontSize: 12.5 }}>
            Adding scopes manually isn't recommended. Scope names must match the server's exact
            spelling and casing. A mistyped scope won't be caught here and will cause authentication
            or authorization errors later.
          </Alert>
          <TextField
            multiline
            minRows={3}
            fullWidth
            placeholder="Enter one scope per line, e.g. sf/manual_test_role"
            value={c.manualScopesText}
            onChange={(e) => update('connectivity', { manualScopesText: e.target.value })}
          />
        </Box>
      )}
    </Box>
  )
}
