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
  TextField,
  Typography
} from '@mui/material'
import StatusRow from '../components/StatusRow'
import ReopenAuthorizationButton from '../components/ReopenAuthorizationButton'
import DialogCloseButton from '../components/DialogCloseButton'
import ProjectScopeWarning from '../components/ProjectScopeWarning'
import { useConnections } from '../state/ConnectionsContext'
import { isValidServerName } from '../../../shared/mcp'
import { brand } from '../theme'

/**
 * Renames a connection. Claude Code keys the OAuth token by server name, so
 * this re-registers under the new name — needing the client secret and (for
 * an enabled connection) a fresh authorization, same as Duplicate. A disabled
 * connection is re-parked under the new name instead, with no reauthorization.
 *
 * The rename goes through the same Claude Code config the VS Code extension
 * reads, so the new name shows up there automatically — nothing extra to sync.
 */
export default function RenameConnectionModal({ connection, open, onClose }) {
  const { reload, waitForAuthorization } = useConnections()
  const [phase, setPhase] = useState('form') // form | working | done | failed
  const [name, setName] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState(null)

  const needsSecret =
    connection && !connection.hasStoredSecret && connection.clientType !== 'public'
  const wasDisabled = connection && connection.status === 'disabled'

  useEffect(() => {
    if (!open || !connection) return
    setPhase('form')
    setName(connection.name)
    setSecret('')
    setError(null)
    // Deliberately keyed on the connection's id, not the object: the list
    // replaces connection objects as statuses refresh, and depending on the
    // object would re-run this and wipe whatever the user has typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connection?.id])

  if (!connection) return null

  const trimmed = name.trim()
  // The new name reaches a command line, so it has to satisfy the same rule the
  // main process enforces — see isValidServerName in shared/mcp.js.
  const nameValid = isValidServerName(trimmed)
  const changed = trimmed !== connection.name
  const canSubmit = nameValid && changed && (!needsSecret || secret.length > 0) && phase === 'form'
  const busy = phase === 'working'

  async function submit() {
    setPhase('working')
    setError(null)
    try {
      const {
        connection: renamed,
        authorizationStarted,
        launchId
      } = await window.api.connections.rename(connection.id, {
        name: trimmed,
        providedSecret: needsSecret ? secret : undefined
      })
      await reload()
      if (authorizationStarted) {
        await waitForAuthorization(renamed.id, launchId)
      }
      setPhase('done')
    } catch (e) {
      setError(e.message)
      setPhase('failed')
    }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 0.5, pr: 5, fontSize: 15.5, fontWeight: 600, position: 'relative' }}>
        Rename connection
        <DialogCloseButton onClose={onClose} disabled={busy} />
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 13, color: brand.textSecondary, mb: 2, lineHeight: 1.55 }}>
          Renaming re-registers <strong>{connection.name}</strong> under the new name
          {wasDisabled
            ? '. It stays disabled.'
            : ' and requires reauthorizing.'} This is the same configuration Claude Code's VS Code
          extension reads, so the new name appears there too.
        </Typography>

        <ProjectScopeWarning
          connection={connection}
          action="Renaming it"
          sx={{ mb: 2 }}
        />

        {(phase === 'form' || phase === 'failed') && (
          <>
            <TextField
              label="Name"
              size="small"
              fullWidth
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) submit()
              }}
              error={!nameValid}
              helperText={
                trimmed.length === 0
                  ? 'A name is required.'
                  : !nameValid
                    ? 'Use letters, digits, spaces, dot, dash or underscore only, starting with ' +
                      'a letter or digit (max 64 characters).'
                    : ' '
              }
              sx={{ mb: needsSecret ? 2 : 0 }}
            />

            {needsSecret && (
              <Paper variant="outlined" sx={{ p: 2, borderColor: brand.border }}>
                <Typography sx={{ fontSize: 12.5, color: brand.textSecondary, mb: 1.5, lineHeight: 1.55 }}>
                  The OAuth client secret isn't stored on this machine. Renaming needs it again —{' '}
                  <strong>it's then stored encrypted for the new name</strong>.
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

        {phase === 'working' && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75 }}>
            <StatusRow
              status="running"
              title={wasDisabled ? 'Renaming' : 'Renaming and waiting for authorization'}
              subtitle={
                wasDisabled
                  ? undefined
                  : 'A terminal window opens briefly and your browser opens the sign-in page.'
              }
            />
            {!wasDisabled && (
              <Box>
                <ReopenAuthorizationButton
                  name={trimmed}
                  scope={connection.installScope}
                  projectPath={connection.projectPath}
                  onError={setError}
                />
              </Box>
            )}
          </Box>
        )}

        {phase === 'done' && (
          <Alert severity="success">
            "{connection.name}" is now "{trimmed}".
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
        {phase !== 'done' && (
          <Button variant="contained" onClick={submit} disabled={!canSubmit}>
            {phase === 'failed' ? 'Try again' : 'Rename'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
