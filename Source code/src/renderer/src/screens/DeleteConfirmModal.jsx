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
 * Reached only from a card's delete icon. The confirm button is solid danger
 * red rather than an outlined danger button, because this is the actual
 * destructive commit (PLAN.md, "Delete confirmation modal").
 */
export default function DeleteConfirmModal({ connection, open, onClose }) {
  const { remove } = useConnections()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (open) setError(null)
  }, [open, connection?.id])

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await window.api.connections.remove(connection.id)
      remove(connection.id)
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
      <DialogTitle
        sx={{ pb: 0.5, pr: 5, fontSize: 15.5, fontWeight: 600, color: brand.danger, position: 'relative' }}
      >
        Delete connection?
        <DialogCloseButton onClose={onClose} disabled={busy} />
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 13, color: brand.textSecondary, lineHeight: 1.55 }}>
          This removes <strong>{connection.name}</strong> from the Claude Code configuration. Claude
          Code loses access to this server immediately. This can't be undone from here.
        </Typography>
        {/* Project scope isn't personal: it lives in a .mcp.json that's
            committed to the repo, so deleting it edits a file the whole team
            shares. That's a materially different act from removing your own
            user- or local-scoped entry, and it shouldn't look identical. */}
        {connection.installScope === 'project' && (
          <Alert severity="warning" sx={{ mt: 2, fontSize: 12.5 }}>
            This is a <strong>project-scoped</strong> connection: it's defined in the{' '}
            <code>.mcp.json</code> in {connection.projectPath}, which is shared with everyone
            working on that project. Deleting it here edits that file, and committing the change
            removes the server for your whole team.
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
        <Button
          variant="contained"
          color="error"
          onClick={confirm}
          disabled={busy}
          sx={{ '&:hover': { bgcolor: '#a82121' } }}
        >
          {busy ? 'Deleting…' : 'Delete connection'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
