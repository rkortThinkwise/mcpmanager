import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  TextField,
  Typography
} from '@mui/material'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import RefreshIcon from '@mui/icons-material/Refresh'
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined'
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline'
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew'
import StatusBadge from '../components/StatusBadge'
import StatusRow from '../components/StatusRow'
import ScopePicker from '../components/ScopePicker'
import ReopenAuthorizationButton from '../components/ReopenAuthorizationButton'
import DialogCloseButton from '../components/DialogCloseButton'
import ProjectScopeWarning from '../components/ProjectScopeWarning'
import ErrorDetail from '../components/ErrorDetail'
import { useConnections } from '../state/ConnectionsContext'
import {
  TARGET_SCOPE_LABELS,
  applicationOf,
  baseUrlOf,
  isApplicationScope
} from '../../../shared/mcp'
import { brand } from '../theme'
import { formatLastVerified, pluralize } from '../format'

function Row({ label, children }) {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 2,
        py: 1,
        borderBottom: `1px solid ${brand.border}`,
        '&:last-of-type': { borderBottom: 'none' },
        fontSize: 13
      }}
    >
      <Typography sx={{ fontSize: 13, color: brand.textSecondary, flexShrink: 0 }}>
        {label}
      </Typography>
      <Box sx={{ fontSize: 13, fontWeight: 500, textAlign: 'right', maxWidth: '60%', wordBreak: 'break-all' }}>
        {children}
      </Box>
    </Box>
  )
}

function parseManualScopes(text) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function sameScopes(a, b) {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

/**
 * The only place a connection's scopes can be viewed *and edited*.
 *
 * There is deliberately no delete here: deleting stays on the card's own icon,
 * so it can't be triggered by accident while someone is just checking scopes
 * (PLAN.md, "Connection details modal").
 */
export default function ConnectionDetailsModal({
  connection,
  open,
  onClose,
  onRefresh,
  onReauthorize,
  onToggle,
  onRename
}) {
  const { replace, waitForAuthorization } = useConnections()
  const [phase, setPhase] = useState('loading') // loading | ready | saving | done | failed
  const [scopes, setScopes] = useState([])
  const [showManual, setShowManual] = useState(false)
  const [manualScopesText, setManualScopesText] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState(null)
  const [menuAnchor, setMenuAnchor] = useState(null)

  const id = connection?.id
  const needsSecret =
    connection && !connection.hasStoredSecret && connection.clientType !== 'public'

  // Keyed on the id, not the connection object: the list re-creates that
  // object on every update, and re-running this mid-save would reset the
  // modal back to "loading".
  useEffect(() => {
    if (!open || !id || !connection) return
    let active = true
    setPhase('loading')
    setScopes([])
    setShowManual(false)
    setManualScopesText('')
    setSecret('')
    setError(null)
    // Scope editing is Claude-Code-only for now (see services/connections.js —
    // applyScopeRefresh refuses a Codex connection) — nothing to discover.
    if (connection.target === 'codex') {
      setPhase('ready')
      return
    }
    ;(async () => {
      try {
        const base = baseUrlOf(connection.url)
        const meta = base ? await window.api.connectivity.metadata(base) : { ok: false }
        const appScopes = (meta.ok && meta.scopes ? meta.scopes : []).filter(isApplicationScope)
        // Fall back to the connection's current scopes if discovery fails, so
        // editing (at least disabling something) is still possible offline.
        const names = appScopes.length ? appScopes : connection.scopes
        if (!active) return
        // A rediscovered scope this connection doesn't have yet still defaults
        // checked if another scope in the same application is already active —
        // an application never turned on for this connection stays off.
        const activeApps = new Set(connection.scopes.map(applicationOf))
        setScopes(
          names.map((n) => ({
            name: n,
            selected: connection.scopes.includes(n) || activeApps.has(applicationOf(n))
          }))
        )
        setPhase('ready')
      } catch (e) {
        if (!active) return
        setError(e.message)
        setPhase('ready')
      }
    })()
    return () => {
      active = false
    }
    // Deliberately keyed on the connection's id, not the object: the list
    // replaces connection objects as statuses refresh, and depending on the
    // object would re-run this and wipe whatever the user has typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id])

  if (!connection) return null
  const c = connection
  const disabled = c.status === 'disabled'
  const isCodex = c.target === 'codex'

  const toggleScope = (name) => {
    setScopes((list) => list.map((s) => (s.name === name ? { ...s, selected: !s.selected } : s)))
  }

  const toggleGroup = (application, selected) => {
    setScopes((list) =>
      list.map((s) => (s.name.startsWith(`${application}/`) ? { ...s, selected } : s))
    )
  }

  const finalScopes = Array.from(
    new Set([...scopes.filter((s) => s.selected).map((s) => s.name), ...parseManualScopes(manualScopesText)])
  )
  const pendingChanges = !sameScopes(finalScopes, c.scopes)
  const showSave = (phase === 'ready' || phase === 'failed') && pendingChanges

  async function saveScopes() {
    setPhase('saving')
    setError(null)
    try {
      const { connection: pending, launchId } = await window.api.connections.applyScopeRefresh(
        c.id,
        { scopes: finalScopes, providedSecret: needsSecret ? secret : undefined }
      )
      replace({ ...c, ...pending })
      await waitForAuthorization(c.id, launchId)
      setPhase('done')
    } catch (e) {
      setError(e.message)
      setPhase('failed')
    }
  }

  const busy = phase === 'loading' || phase === 'saving'

  function runTask(fn) {
    setMenuAnchor(null)
    fn(c)
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 0.5, pr: 9, fontSize: 15.5, fontWeight: 600, position: 'relative' }}>
        {c.name}
        {/* The same tasks and icons ConnectionCard offers for this connection
            (RefreshIcon/VpnKeyOutlinedIcon/PowerSettingsNewIcon), gathered here
            instead of spread across the footer's buttons. Refresh, reauthorize
            and disable only apply while enabled; the only thing to do while
            disabled is Enable, which stays the footer's primary action below —
            but Rename applies either way, so the menu itself always shows. */}
        <IconButton
          size="small"
          aria-label="Connection tasks"
          onClick={(e) => setMenuAnchor(e.currentTarget)}
          sx={{ position: 'absolute', right: 44, top: 12, color: brand.textSecondary }}
        >
          <MoreVertIcon sx={{ fontSize: 20 }} />
        </IconButton>
        <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
          {/* Rename, refresh-scopes and enable/disable are Claude-Code-only for
              now — Codex's CLI has no rename/duplicate primitive and no
              user-facing enable/disable (see services/connections.js). */}
          {!isCodex && (
            <MenuItem disabled={busy} onClick={() => runTask(onRename)}>
              <ListItemIcon>
                <DriveFileRenameOutlineIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Rename</ListItemText>
            </MenuItem>
          )}
          {!isCodex && !disabled && (
            <MenuItem disabled={busy} onClick={() => runTask(onRefresh)}>
              <ListItemIcon>
                <RefreshIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Refresh scopes</ListItemText>
            </MenuItem>
          )}
          {/* Only relevant when reauthorization is actually needed. */}
          {!disabled && c.status === 'warn' && (
            <MenuItem disabled={busy} onClick={() => runTask(onReauthorize)}>
              <ListItemIcon>
                <VpnKeyOutlinedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Reauthorize</ListItemText>
            </MenuItem>
          )}
          {!isCodex && !disabled && (
            <MenuItem disabled={busy} onClick={() => runTask(onToggle)}>
              <ListItemIcon>
                <PowerSettingsNewIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Disable</ListItemText>
            </MenuItem>
          )}
        </Menu>
        <DialogCloseButton onClose={onClose} disabled={busy} />
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ fontFamily: brand.mono, fontSize: 12, color: brand.textSecondary, mb: 2, wordBreak: 'break-all' }}>
          {c.url}
        </Typography>

        <Paper variant="outlined" sx={{ px: 2.25, py: 0.5, mb: 2.5, borderColor: brand.border }}>
          <Row label="Status">
            <StatusBadge status={c.status} />
          </Row>
          <Row label="Last verified">{formatLastVerified(c.lastVerified)}</Row>
          <Row label="Scopes checked">
            {c.scopesCheckedAt ? formatLastVerified(c.scopesCheckedAt) : 'Not yet'}
          </Row>
          <Row label="Scope">{TARGET_SCOPE_LABELS[c.target]?.[c.installScope]?.label || c.installScope}</Row>
          <Row label="Available in">
            {c.installScope === 'user' ? 'All projects' : c.projectPath}
          </Row>
          <Row label="Client ID">{c.clientId || '—'}</Row>
          {isCodex ? (
            <Row label="Client type">Public (PKCE) — Codex never stores a secret</Row>
          ) : (
            <>
              <Row label="Callback port">{c.callbackPort}</Row>
              <Row label="Client secret">
                {c.hasStoredSecret ? 'Stored on this machine' : 'Not stored — asked for on refresh'}
              </Row>
            </>
          )}
        </Paper>

        {c.status !== 'connected' && c.statusDetail && phase !== 'done' && (
          <Alert
            severity={c.status === 'error' ? 'error' : c.status === 'warn' ? 'warning' : 'info'}
            sx={{ mb: 2.5, fontSize: 12.5 }}
          >
            {c.statusDetail}
          </Alert>
        )}

        {/* Recorded by the periodic scope-drift sweep when it couldn't reach
            this connection's server — sent to the renderer all along, but
            never actually shown anywhere until now. Independent of `status`
            above: authorization can be perfectly healthy while the last
            drift check itself failed for an unrelated reason (e.g. the
            server was briefly unreachable). */}
        {c.driftError && (
          <Alert severity="warning" sx={{ mb: 2.5, fontSize: 12.5 }}>
            <ErrorDetail summary="The last scope check failed." detail={c.driftError} />
          </Alert>
        )}

        {isCodex ? (
          <Alert severity="info" sx={{ fontSize: 12.5 }}>
            Scope changes aren't supported for Codex connections yet — delete and re-add it to
            request a different set. Codex requested whatever was checked in the wizard's
            connectivity step at sign-in.
          </Alert>
        ) : (
          <>
            <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 1 }}>
              Scopes ({pluralize(finalScopes.length, 'scope')})
            </Typography>

            {phase === 'loading' && <StatusRow status="running" title="Fetching current scopes from the server" />}
          </>
        )}

        {!isCodex && (phase === 'ready' || phase === 'saving' || phase === 'failed') && (
          <>
            <ScopePicker scopes={scopes} onToggleScope={toggleScope} onToggleGroup={toggleGroup} />

            <Link
              component="button"
              type="button"
              onClick={() => setShowManual((v) => !v)}
              sx={{ fontSize: 12.5, display: 'block', mt: 1, mb: showManual ? 1.5 : 0 }}
            >
              {showManual ? '− Hide manual entry' : '+ Add scope manually'}
            </Link>

            {showManual && (
              <Box sx={{ mb: 1.5 }}>
                <Alert severity="warning" sx={{ mb: 1.5, fontSize: 12.5 }}>
                  Adding scopes manually isn't recommended. Scope names must match the server's exact
                  spelling and casing. A mistyped scope won't be caught here and will cause
                  authentication or authorization errors later.
                </Alert>
                <TextField
                  multiline
                  minRows={3}
                  fullWidth
                  placeholder="Enter one scope per line, e.g. sf/manual_test_role"
                  value={manualScopesText}
                  onChange={(e) => setManualScopesText(e.target.value)}
                />
              </Box>
            )}

            {needsSecret && showSave && (
              <Paper variant="outlined" sx={{ p: 2, mt: 1.5, borderColor: brand.border }}>
                <Typography sx={{ fontSize: 12.5, color: brand.textSecondary, mb: 1.5, lineHeight: 1.55 }}>
                  The OAuth client secret for this connection isn't stored on this machine. Saving
                  scope changes re-registers the connection, which needs the secret again. Claude
                  Code won't hand its copy back, so it has to be entered once here —{' '}
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

            {showSave && phase === 'ready' && (
              <>
                <ProjectScopeWarning
                  connection={c}
                  action="Saving scope changes re-registers the server, which"
                  sx={{ mt: 1.5 }}
                />
                <Typography sx={{ fontSize: 11.5, color: brand.textSecondary, mt: 1.5, lineHeight: 1.5 }}>
                  Saving re-authorizes the connection with the scopes checked above. A terminal
                  window opens briefly and your browser opens the sign-in page.
                </Typography>
              </>
            )}
          </>
        )}

        {phase === 'saving' && (
          <Box sx={{ mt: 1.75, display: 'flex', flexDirection: 'column', gap: 1.75 }}>
            <StatusRow
              status="running"
              title="Waiting for authorization in the browser"
              subtitle="Complete the sign-in. This updates automatically."
            />
            <Box>
              <ReopenAuthorizationButton
                name={c.name}
                scope={c.installScope}
                projectPath={c.projectPath}
                onError={setError}
              />
            </Box>
          </Box>
        )}

        {phase === 'done' && (
          <Alert severity="success" sx={{ mt: 1.75 }}>
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
          Close
        </Button>
        {/* A disabled server can only be turned back on here — refresh,
            reauthorize and scope editing don't apply while it's off, so those
            live in the header's tasks menu instead once enabled. Enabling and
            disabling both route through onToggle, which asks for confirmation
            before disabling but not before enabling. */}
        {disabled ? (
          <Button variant="contained" color="success" onClick={() => onToggle(c)}>
            Enable
          </Button>
        ) : (
          showSave && (
            <Button
              variant="contained"
              onClick={saveScopes}
              disabled={busy || (needsSecret && secret.length === 0)}
            >
              {phase === 'failed' ? 'Try again' : 'Save scopes'}
            </Button>
          )
        )}
      </DialogActions>
    </Dialog>
  )
}
