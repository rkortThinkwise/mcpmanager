import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography
} from '@mui/material'
import DialogCloseButton from '../components/DialogCloseButton'
import { useConnections } from '../state/ConnectionsContext'
import { brand } from '../theme'

/**
 * Confirmation shown before disabling. Modeled on DeleteConfirmModal but
 * deliberately NOT destructive-styled: neutral title, primary (not danger)
 * confirm button. Disabling is fully reversible — the point of the dialog is
 * that turning a server off can interrupt an in-progress Claude Code session,
 * not that anything is lost. Enabling has no such side effect, so it skips the
 * dialog entirely.
 */
export default function DisableConfirmModal({ connection, open, onClose }) {
  const { setEnabled } = useConnections()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (open) setError(null)
  }, [open, connection?.id])

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await setEnabled(connection.id, false)
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (!connection) return null

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ pb: 0.5, pr: 5, fontSize: 15.5, fontWeight: 600, position: 'relative' }}>
        Disable connection?
        <DialogCloseButton onClose={onClose} disabled={busy} />
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 13, color: brand.textSecondary, lineHeight: 1.55 }}>
          Claude Code will stop using <strong>{connection.name}</strong>, which could interrupt a
          session that's relying on it right now. Nothing is deleted — its configuration, scopes, and
          sign-in are kept, and you can enable it again at any time with no browser sign-in.
        </Typography>
        {connection.installScope === 'project' && (
          <Alert severity="info" sx={{ mt: 2, fontSize: 12.5 }}>
            This only affects your machine. It's recorded in a local, gitignored{' '}
            <code>.claude/settings.local.json</code> — the shared <code>.mcp.json</code> isn't
            touched, so teammates are unaffected.
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button variant="outlined" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={confirm} disabled={busy}>
          {busy ? 'Disabling…' : 'Disable'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
