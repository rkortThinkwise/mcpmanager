import { useEffect, useState } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  TextField,
  Typography
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import StatusRow from '../components/StatusRow'
import ScopeList from '../components/ScopeList'
import ScopePicker from '../components/ScopePicker'
import ReopenAuthorizationButton from '../components/ReopenAuthorizationButton'
import DialogCloseButton from '../components/DialogCloseButton'
import ProjectScopeWarning from '../components/ProjectScopeWarning'
import { useConnections } from '../state/ConnectionsContext'
import { applicationOf } from '../../../shared/mcp'
import { brand } from '../theme'

const COUNT_STYLES = {
  added: { bg: brand.successBg, color: brand.success },
  removed: { bg: brand.dangerBg, color: brand.danger },
  unchanged: { bg: brand.chipBg, color: brand.chipInk }
}

/**
 * Read-only group for scopes the picker can't offer a checkbox for — only
 * "Removed" uses this now, since the server no longer advertises them at all.
 */
function ScopeGroup({ title, scopes, variant, defaultExpanded }) {
  const style = COUNT_STYLES[variant]
  return (
    <Accordion
      defaultExpanded={defaultExpanded}
      disableGutters
      elevation={0}
      sx={{
        border: `1px solid ${brand.border}`,
        // See ScopePicker.jsx: MUI's Accordion variant sets `borderRadius: 0`
        // and only restores it on `:first-of-type`/`:last-of-type`, so plain
        // sx loses that tie — force it so rounding never depends on position.
        borderRadius: '16px !important',
        mb: 1.25,
        '&:before': { display: 'none' },
        '&.Mui-expanded': { mb: 1.25 }
      }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ fontSize: 18 }} />}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{title}</Typography>
          <Box
            component="span"
            sx={{
              fontSize: 10.5,
              fontWeight: 700,
              borderRadius: 20,
              px: 1,
              py: '1px',
              bgcolor: style.bg,
              color: style.color
            }}
          >
            {scopes.length}
          </Box>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        <ScopeList scopes={scopes} variant={variant === 'unchanged' ? 'plain' : variant} />
      </AccordionDetails>
    </Accordion>
  )
}

// Build the checkable picker state from a diff: currently-active scopes start
// checked, and a newly-advertised scope also starts checked only if another
// scope in the same application is already active — an application this
// connection has never turned on stays off by default. Anything the
// connection previously excluded (but the server still advertises) starts
// unchecked so the user can opt back in without retyping it.
function pickerScopesFrom(diff) {
  const activeApps = new Set(diff.unchanged.map(applicationOf))
  const checked = new Set(diff.unchanged)
  for (const name of diff.added) {
    if (activeApps.has(applicationOf(name))) checked.add(name)
  }
  return diff.advertised
    .filter((name) => !diff.removed.includes(name))
    .map((name) => ({ name, selected: checked.has(name) }))
}

export default function RefreshScopesModal({ connection, open, onClose }) {
  const { replace, waitForAuthorization } = useConnections()
  const [phase, setPhase] = useState('checking') // checking | diff | uptodate | authorizing | done | failed
  const [diff, setDiff] = useState(null)
  const [scopes, setScopes] = useState([])
  const [error, setError] = useState(null)
  const [secret, setSecret] = useState('')

  const needsSecret =
    connection && !connection.hasStoredSecret && connection.clientType !== 'public'
  const id = connection?.id

  // Keyed on the id, not the connection object: the list re-creates that object
  // on every update, and re-running this mid-authorization would reset the
  // modal back to "checking".
  useEffect(() => {
    if (!open || !id) return
    let active = true
    setPhase('checking')
    setDiff(null)
    setScopes([])
    setError(null)
    setSecret('')
    ;(async () => {
      try {
        const res = await window.api.connections.refreshScopes(id)
        if (!active) return
        setDiff(res)
        setScopes(pickerScopesFrom(res))
        // No differences at all: don't show three empty groups, just say so.
        const changed = res.added.length > 0 || res.removed.length > 0
        setPhase(changed ? 'diff' : 'uptodate')
      } catch (e) {
        if (!active) return
        setError(e.message)
        setPhase('failed')
      }
    })()
    return () => {
      active = false
    }
  }, [open, id])

  const toggleScope = (name) => {
    setScopes((list) => list.map((s) => (s.name === name ? { ...s, selected: !s.selected } : s)))
  }

  const toggleGroup = (application, selected) => {
    setScopes((list) =>
      list.map((s) => (s.name.startsWith(`${application}/`) ? { ...s, selected } : s))
    )
  }

  const getBadge = (name) => (diff && diff.added.includes(name) ? 'added' : undefined)

  async function apply() {
    setPhase('authorizing')
    setError(null)
    try {
      const checkedNames = scopes.filter((s) => s.selected).map((s) => s.name)
      // The main process re-runs the diff itself before writing, so what gets
      // applied is checked against the server's current scope set, not this
      // possibly-stale one.
      const { connection: pending, launchId } = await window.api.connections.applyScopeRefresh(
        connection.id,
        { scopes: checkedNames, providedSecret: needsSecret ? secret : undefined }
      )
      replace({ ...connection, ...pending })
      await waitForAuthorization(connection.id, launchId)
      setPhase('done')
    } catch (e) {
      setError(e.message)
      setPhase('failed')
    }
  }

  if (!connection) return null

  const busy = phase === 'checking' || phase === 'authorizing'

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 0.5, pr: 5, fontSize: 15.5, fontWeight: 600, position: 'relative' }}>
        Refresh scopes
        <DialogCloseButton onClose={onClose} disabled={busy} />
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 13, color: brand.textSecondary, mb: 2, lineHeight: 1.55 }}>
          {phase === 'checking' ? (
            <>
              Checking <strong>{connection.name}</strong> for scope changes…
            </>
          ) : (
            <>
              Comparing <strong>{connection.name}</strong> against the scopes the server advertises
              now.
            </>
          )}
        </Typography>

        {phase === 'checking' && (
          <StatusRow status="running" title="Fetching current scopes from the server" />
        )}

        {phase === 'uptodate' && (
          <Alert severity="success">
            Scopes are already up to date. Nothing to apply.
          </Alert>
        )}

        {(phase === 'diff' || phase === 'authorizing' || phase === 'failed') && diff && (
          <>
            {phase === 'diff' && (
              <ProjectScopeWarning
                connection={connection}
                action="Applying new scopes re-registers the server, which"
                sx={{ mb: 1.75 }}
              />
            )}

            {phase === 'diff' && (
              <Alert severity="warning" sx={{ mb: 1.75, fontSize: 12.5 }}>
                Scopes have changed since this connection was last set up. A new scope is checked by
                default only if another scope in the same application is already active; anything for
                an application this connection has never used starts unchecked. Adjust as needed — it'll
                stay excluded on future refreshes until you check it again here.
              </Alert>
            )}

            {diff.removed.length > 0 && (
              <ScopeGroup title="Removed" scopes={diff.removed} variant="removed" defaultExpanded />
            )}

            <ScopePicker
              scopes={scopes}
              onToggleScope={toggleScope}
              onToggleGroup={toggleGroup}
              getBadge={getBadge}
            />

            {needsSecret && phase === 'diff' && (
              <Paper variant="outlined" sx={{ p: 2, mt: 1.5, borderColor: brand.border }}>
                <Typography sx={{ fontSize: 12.5, color: brand.textSecondary, mb: 1.5, lineHeight: 1.55 }}>
                  The OAuth client secret for this connection isn't stored on this machine. Applying
                  new scopes re-registers the connection, which needs the secret again. Claude Code
                  won't hand its copy back, so it has to be entered once here —{' '}
                  <strong>it's then stored encrypted and you won't be asked again</strong>.
                </Typography>
                <TextField
                  label="Client secret"
                  type="password"
                  size="small"
                  fullWidth
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </Paper>
            )}

            {phase === 'diff' && (
              <Typography sx={{ fontSize: 11.5, color: brand.textSecondary, mt: 1.5, lineHeight: 1.5 }}>
                Applying this update re-authorizes the connection with the scopes checked above. A
                terminal window opens briefly and your browser opens the sign-in page.
              </Typography>
            )}
          </>
        )}

        {phase === 'authorizing' && (
          <Box sx={{ mt: 1.75, display: 'flex', flexDirection: 'column', gap: 1.75 }}>
            <StatusRow
              status="running"
              title="Waiting for authorization in the browser"
              subtitle="Complete the sign-in. This updates automatically."
            />
            <Box>
              <ReopenAuthorizationButton
                name={connection.name}
                scope={connection.installScope}
                projectPath={connection.projectPath}
                onError={setError}
              />
            </Box>
          </Box>
        )}

        {phase === 'done' && (
          <Alert severity="success">
            Scopes updated and reauthorized. This connection is active again.
          </Alert>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 1.75 }}>
            {error}
          </Alert>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button variant="outlined" onClick={onClose} disabled={busy}>
          {phase === 'done' || phase === 'uptodate' ? 'Close' : 'Cancel'}
        </Button>
        {(phase === 'diff' || (phase === 'failed' && diff)) && (
          <Button
            variant="contained"
            onClick={apply}
            disabled={needsSecret && secret.length === 0}
          >
            {phase === 'failed' ? 'Try again' : 'Apply and reauthorize'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
