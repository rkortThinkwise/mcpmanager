import { useEffect, useRef, useState } from 'react'
import { Box } from '@mui/material'
import TopBar from './components/TopBar'
import ConnectionsList from './screens/ConnectionsList'
import ConnectionDetailsModal from './screens/ConnectionDetailsModal'
import RefreshScopesModal from './screens/RefreshScopesModal'
import ReauthorizeModal from './screens/ReauthorizeModal'
import DuplicateConnectionModal from './screens/DuplicateConnectionModal'
import RenameConnectionModal from './screens/RenameConnectionModal'
import DeleteConfirmModal from './screens/DeleteConfirmModal'
import DisableConfirmModal from './screens/DisableConfirmModal'
import SettingsModal from './screens/SettingsModal'
import AddConnectionWizard from './screens/AddConnectionWizard'
import { useConnections } from './state/ConnectionsContext'
import { brand } from './theme'

// Only one modal is ever open at a time, so the whole overlay layer is one
// piece of state: which flow, against which connection.
const NONE = { kind: null, connection: null }

export default function App() {
  const { connections, reload, setEnabled } = useConnections()
  const [modal, setModal] = useState(NONE)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Enabling is instant with no confirmation dialog (see `toggle` below), so
  // a failure has nowhere to show up unless the card itself carries it —
  // keyed by connection id since more than one card could fail independently.
  const [enableErrors, setEnableErrors] = useState({})

  const open = (kind) => (connection) => setModal({ kind, connection })
  const close = () => setModal(NONE)

  // The list is the source of truth: re-read the target from it so a modal
  // opened before an action always renders the updated connection.
  const target = modal.connection
    ? connections.find((c) => c.id === modal.connection.id) || modal.connection
    : null

  // Details hands off to the refresh / reauthorize flows for the same
  // connection, closing itself on the way out.
  const handoff = (kind) => (connection) => setModal({ kind, connection })

  // The power toggle is asymmetric on purpose: disabling asks first (it can
  // interrupt a live session), enabling is immediate (nothing to lose).
  const toggle = (connection) => {
    if (connection.status === 'disabled') {
      setEnableErrors((m) => ({ ...m, [connection.id]: null }))
      setEnabled(connection.id, true).catch((e) => {
        setEnableErrors((m) => ({ ...m, [connection.id]: e.message }))
      })
    } else {
      setModal({ kind: 'disable', connection })
    }
  }

  // The wizard is a custom full-screen overlay, not an MUI Dialog, so it has no
  // built-in focus trap: without this, the list, its card actions, and Settings
  // stay reachable by Tab underneath it even though they're visually covered.
  // `inert` (native in Electron's Chromium) removes them from the accessibility
  // tree and tab order entirely while the wizard is open.
  const mainRef = useRef(null)
  useEffect(() => {
    if (mainRef.current) mainRef.current.inert = wizardOpen
  }, [wizardOpen])

  return (
    <Box sx={{ height: '100vh', overflowY: 'auto', bgcolor: brand.windowBg }}>
      <Box ref={mainRef} sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <TopBar />
        <Box sx={{ maxWidth: 1040, mx: 'auto', width: '100%', flex: 1, display: 'flex', flexDirection: 'column' }}>
          <ConnectionsList
            onAdd={() => setWizardOpen(true)}
            onSettings={() => setSettingsOpen(true)}
            onOpen={open('details')}
            onRefresh={open('refresh')}
            onReauthorize={open('reauth')}
            onToggle={toggle}
            onDuplicate={open('duplicate')}
            onRename={open('rename')}
            onDelete={open('delete')}
            enableErrors={enableErrors}
          />
        </Box>

        <ConnectionDetailsModal
          connection={target}
          open={modal.kind === 'details'}
          onClose={close}
          onRefresh={handoff('refresh')}
          onReauthorize={handoff('reauth')}
          onToggle={toggle}
          onRename={handoff('rename')}
        />
        <RefreshScopesModal connection={target} open={modal.kind === 'refresh'} onClose={close} />
        <ReauthorizeModal connection={target} open={modal.kind === 'reauth'} onClose={close} />
        <DuplicateConnectionModal connection={target} open={modal.kind === 'duplicate'} onClose={close} />
        <RenameConnectionModal connection={target} open={modal.kind === 'rename'} onClose={close} />
        <DeleteConfirmModal connection={target} open={modal.kind === 'delete'} onClose={close} />
        <DisableConfirmModal connection={target} open={modal.kind === 'disable'} onClose={close} />
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </Box>

      <AddConnectionWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onAdded={reload}
      />
    </Box>
  )
}
