import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography
} from '@mui/material'
import StatusRow from '../components/StatusRow'
import ReopenAuthorizationButton from '../components/ReopenAuthorizationButton'
import DialogCloseButton from '../components/DialogCloseButton'
import { useConnections } from '../state/ConnectionsContext'
import { brand } from '../theme'

/**
 * Fresh token, same configuration.
 *
 * This flow deliberately does not touch scopes. If different scopes are what's
 * actually needed, that's the refresh-scopes flow — the two aren't merged even
 * though both end in a fresh token (PLAN.md, "Reauthorize modal").
 */
export default function ReauthorizeModal({ connection, open, onClose }) {
  const { waitForAuthorization } = useConnections()
  const [phase, setPhase] = useState('idle') // idle | waiting | done | failed
  const [error, setError] = useState(null)

  // Keyed on the id, not the connection object: the list re-creates that object
  // on every update, and re-running this mid-authorization would reset the
  // modal back to its idle state.
  useEffect(() => {
    if (!open) return
    setPhase('idle')
    setError(null)
  }, [open, connection?.id])

  async function start() {
    setPhase('waiting')
    setError(null)
    try {
      const { launchId } = await window.api.connections.reauthorize(connection.id)
      await waitForAuthorization(connection.id, launchId)
      setPhase('done')
    } catch (e) {
      setError(e.message)
      setPhase('failed')
    }
  }

  if (!connection) return null
  const busy = phase === 'waiting'

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 0.5, pr: 5, fontSize: 15.5, fontWeight: 600, position: 'relative' }}>
        Reauthorize connection
        <DialogCloseButton onClose={onClose} disabled={busy} />
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 13, color: brand.textSecondary, mb: 2, lineHeight: 1.55 }}>
          This opens a browser window to sign in again for <strong>{connection.name}</strong>.
          Current access continues working until the new authorization completes.
        </Typography>

        {phase === 'waiting' && (
          <>
            <StatusRow
              status="running"
              title="Waiting for authorization in the browser"
              subtitle="A terminal window is running the sign-in. This updates automatically."
            />
            <Box sx={{ mt: 1.75 }}>
              <ReopenAuthorizationButton
                name={connection.name}
                scope={connection.installScope}
                projectPath={connection.projectPath}
                onError={setError}
              />
            </Box>
          </>
        )}

        {phase === 'done' && (
          <Alert severity="success">Reauthorized. This connection is active again.</Alert>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: phase === 'failed' ? 0 : 1.75 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button variant="outlined" onClick={onClose} disabled={busy}>
          {phase === 'done' ? 'Close' : 'Cancel'}
        </Button>
        {(phase === 'idle' || phase === 'failed') && (
          <Button variant="contained" onClick={start}>
            {phase === 'failed' ? 'Try again' : 'Start reauthorization'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
