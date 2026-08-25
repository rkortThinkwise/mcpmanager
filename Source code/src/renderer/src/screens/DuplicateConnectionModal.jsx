import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Radio,
  TextField,
  Typography
} from '@mui/material'
import StatusRow from '../components/StatusRow'
import ScopePicker from '../components/ScopePicker'
import ReopenAuthorizationButton from '../components/ReopenAuthorizationButton'
import DialogCloseButton from '../components/DialogCloseButton'
import { useConnections } from '../state/ConnectionsContext'
import { brand } from '../theme'
import {
  SCOPE_LABELS,
  applicationOf,
  baseUrlOf,
  isApplicationScope,
  isValidServerName
} from '../../../shared/mcp'

function InstallScopeCard({ selected, title, desc, onClick }) {
  return (
    <Paper
      variant="outlined"
      onClick={onClick}
      sx={{
        flex: 1,
        p: 2,
        cursor: 'pointer',
        borderColor: selected ? brand.blue : brand.border,
        bgcolor: selected ? '#EAF2FA' : brand.panelBg
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Radio checked={selected} size="small" sx={{ p: 0 }} />
        <Typography sx={{ fontSize: 13.5, fontWeight: 500 }}>{title}</Typography>
      </Box>
      <Typography sx={{ fontSize: 12, color: brand.textSecondary, mt: 0.5 }}>{desc}</Typography>
    </Paper>
  )
}

const EMPTY_FORM = {
  name: '',
  installScope: 'user',
  projectPath: null,
  projects: [],
  scopes: []
}

export default function DuplicateConnectionModal({ connection, open, onClose }) {
  const { reload, waitForAuthorization } = useConnections()
  const [phase, setPhase] = useState('loading') // loading | form | authorizing | done | failed
  const [form, setForm] = useState(EMPTY_FORM)
  const [secret, setSecret] = useState('')
  const [error, setError] = useState(null)

  const needsSecret =
    connection && !connection.hasStoredSecret && connection.clientType !== 'public'

  useEffect(() => {
    if (!open || !connection) return
    let active = true
    setPhase('loading')
    setForm({ ...EMPTY_FORM, name: `${connection.name} copy` })
    setSecret('')
    setError(null)
    ;(async () => {
      try {
        const base = baseUrlOf(connection.url)
        const meta = base ? await window.api.connectivity.metadata(base) : { ok: false }
        const appScopes = (meta.ok && meta.scopes ? meta.scopes : []).filter(isApplicationScope)
        // Fall back to the source's current scopes if rediscovery fails, so the
        // picker isn't just empty.
        const names = appScopes.length ? appScopes : connection.scopes
        // A scope the source doesn't have yet still defaults checked if another
        // scope in the same application is already active on the source — an
        // application the source never turned on stays off for the duplicate too.
        const activeApps = new Set(connection.scopes.map(applicationOf))
        const scopes = names.map((n) => ({
          name: n,
          selected: connection.scopes.includes(n) || activeApps.has(applicationOf(n))
        }))

        let installScope = connection.installScope === 'local' ? 'local' : 'user'
        let projectPath = null
        let projects = []
        const located = await window.api.config.locate()
        if (located.found) {
          const v = await window.api.config.validate(located.path)
          if (v.valid) {
            projects = await window.api.config.listProjects(v.path)
            if (installScope === 'local') {
              projectPath = projects.includes(connection.projectPath) ? connection.projectPath : null
            }
          }
        }

        if (!active) return
        setForm({ name: `${connection.name} copy`, installScope, projectPath, projects, scopes })
        setPhase('form')
      } catch (e) {
        if (!active) return
        setError(e.message)
        setPhase('failed')
      }
    })()
    return () => {
      active = false
    }
    // Deliberately keyed on the connection's id, not the object: the list
    // replaces connection objects as statuses refresh, and depending on the
    // object would re-run this and wipe whatever the user has typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connection?.id])

  const toggleScope = (name) => {
    setForm((f) => ({
      ...f,
      scopes: f.scopes.map((s) => (s.name === name ? { ...s, selected: !s.selected } : s))
    }))
  }

  const toggleGroup = (application, selected) => {
    setForm((f) => ({
      ...f,
      scopes: f.scopes.map((s) => (s.name.startsWith(`${application}/`) ? { ...s, selected } : s))
    }))
  }

  const selectInstallScope = (installScope) => {
    setForm((f) => ({ ...f, installScope, projectPath: installScope === 'user' ? null : f.projectPath }))
  }

  // Same rule the main process enforces before the name reaches a command line.
  const nameValid = isValidServerName(form.name.trim())
  const locationValid = form.installScope === 'user' || Boolean(form.projectPath)
  const canSubmit =
    nameValid && locationValid && (!needsSecret || secret.length > 0) && phase === 'form'

  async function submit() {
    setPhase('authorizing')
    setError(null)
    try {
      const checkedNames = form.scopes.filter((s) => s.selected).map((s) => s.name)
      const { connection: created, launchId } = await window.api.connections.duplicate(connection.id, {
        name: form.name.trim(),
        installScope: form.installScope,
        projectPath: form.installScope === 'local' ? form.projectPath : undefined,
        scopes: checkedNames,
        providedSecret: needsSecret ? secret : undefined
      })
      await reload()
      await waitForAuthorization(created.id, launchId)
      setPhase('done')
    } catch (e) {
      setError(e.message)
      setPhase('failed')
    }
  }

  if (!connection) return null
  const busy = phase === 'loading' || phase === 'authorizing'

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 0.5, pr: 5, fontSize: 15.5, fontWeight: 600, position: 'relative' }}>
        Duplicate connection
        <DialogCloseButton onClose={onClose} disabled={busy} />
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 13, color: brand.textSecondary, mb: 2, lineHeight: 1.55 }}>
          Registers a second connection against the same server as{' '}
          <strong>{connection.name}</strong>, under a new name and its own scope selection.
        </Typography>

        {phase === 'loading' && (
          <StatusRow status="running" title="Reading the server's current scopes" />
        )}

        {phase === 'form' && (
          <>
            <TextField
              label="Name"
              size="small"
              fullWidth
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              error={!nameValid}
              helperText={
                form.name.trim().length === 0
                  ? 'A name is required.'
                  : !nameValid
                    ? 'Use letters, digits, spaces, dot, dash or underscore only, starting with ' +
                      'a letter or digit (max 64 characters).'
                    : ' '
              }
              sx={{ mb: 2 }}
            />

            <Typography sx={{ fontSize: 12.5, fontWeight: 500, color: brand.textSecondary, mb: 1 }}>
              Install scope
            </Typography>
            <Box sx={{ display: 'flex', gap: 2, mb: 2.25 }}>
              <InstallScopeCard
                selected={form.installScope === 'user'}
                title={SCOPE_LABELS.user.label}
                desc={SCOPE_LABELS.user.description}
                onClick={() => selectInstallScope('user')}
              />
              <InstallScopeCard
                selected={form.installScope === 'local'}
                title={SCOPE_LABELS.local.label}
                desc={SCOPE_LABELS.local.description}
                onClick={() => selectInstallScope('local')}
              />
            </Box>

            {form.installScope === 'local' && (
              <Box sx={{ mb: 2.25 }}>
                <Typography sx={{ fontSize: 12.5, fontWeight: 500, color: brand.textSecondary, mb: 1 }}>
                  Select project
                </Typography>
                {form.projects.length === 0 ? (
                  <Alert severity="info">
                    No existing projects were found. Choose User scope instead, or open the project
                    in Claude Code first so it appears here.
                  </Alert>
                ) : (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {form.projects.map((p) => {
                      const sel = form.projectPath === p
                      return (
                        <Paper
                          key={p}
                          variant="outlined"
                          onClick={() => setForm((f) => ({ ...f, projectPath: p }))}
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1.25,
                            px: 1.75,
                            py: 1.25,
                            cursor: 'pointer',
                            borderColor: sel ? brand.blue : brand.border,
                            bgcolor: sel ? '#EAF2FA' : brand.panelBg
                          }}
                        >
                          <Radio checked={sel} size="small" sx={{ p: 0 }} />
                          <Typography sx={{ fontSize: 13, wordBreak: 'break-all' }}>{p}</Typography>
                        </Paper>
                      )
                    })}
                  </Box>
                )}
              </Box>
            )}

            <Typography sx={{ fontSize: 12.5, fontWeight: 500, color: brand.textSecondary, mb: 1 }}>
              Scopes
            </Typography>
            <Box sx={{ mb: needsSecret ? 2 : 0 }}>
              <ScopePicker
                scopes={form.scopes}
                onToggleScope={toggleScope}
                onToggleGroup={toggleGroup}
              />
            </Box>

            {needsSecret && (
              <Paper variant="outlined" sx={{ p: 2, borderColor: brand.border }}>
                <Typography sx={{ fontSize: 12.5, color: brand.textSecondary, mb: 1.5, lineHeight: 1.55 }}>
                  The OAuth client secret isn't stored on this machine. Registering the duplicate
                  needs it again — <strong>it's then stored encrypted for the new connection</strong>.
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
          </>
        )}

        {phase === 'authorizing' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75 }}>
            <StatusRow
              status="running"
              title="Registering and waiting for authorization"
              subtitle="A terminal window opens briefly and your browser opens the sign-in page."
            />
            <Box>
              <ReopenAuthorizationButton
                name={form.name}
                scope={form.installScope}
                projectPath={form.projectPath}
                onError={setError}
              />
            </Box>
          </Box>
        )}

        {phase === 'done' && (
          <Alert severity="success">
            "{form.name}" was created and authorized.
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
          {phase === 'done' ? 'Close' : 'Cancel'}
        </Button>
        {(phase === 'form' || (phase === 'failed' && form.scopes.length > 0)) && (
          <Button variant="contained" onClick={submit} disabled={!canSubmit}>
            {phase === 'failed' ? 'Try again' : 'Duplicate'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
