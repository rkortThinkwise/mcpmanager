import { useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import WizardStepper from './Stepper'
import StepPrerequisites from './StepPrerequisites'
import StepServerDetails from './StepServerDetails'
import StepConnectivity from './StepConnectivity'
import StepReview from './StepReview'
import StepWriteAndAuthorize from './StepWriteAndAuthorize'
import StepFinish from './StepFinish'
import {
  WizardProvider,
  useWizard,
  serverDetailsValid,
  LAST_STEP,
  TARGETS
} from '../../state/WizardContext'
import { brand } from '../../theme'

const SCREENS = {
  1: StepPrerequisites,
  2: StepServerDetails,
  3: StepConnectivity,
  4: StepReview,
  5: StepWriteAndAuthorize,
  6: StepFinish
}

/**
 * What gates the footer's Next button on each step. Kept here rather than in the
 * steps because the footer is a fixed bar outside the scrolling content column,
 * so it can't be rendered by the step it belongs to.
 */
function gateFor(step, state) {
  const selectedTargets = TARGETS.filter((t) => state.targets[t])
  switch (step) {
    case 1:
      // At least one target has to be picked, or there's nothing to write.
      return selectedTargets.length > 0
    case 2:
      return serverDetailsValid(state.server, state.targets)
    case 3:
      // Reachability must pass: everything downstream depends on it.
      return state.connectivity.reachStatus === 'success'
    case 4:
      // Codex has no config file to locate — global scope only, no picker.
      if (!state.targets.claude) return true
      return (
        state.config.valid &&
        Boolean(state.config.configPath) &&
        (state.config.installScope === 'user' || Boolean(state.config.projectPath))
      )
    case 5:
      // Every selected target has to finish authorizing, not just one.
      return selectedTargets.every((t) => state.install[t].authStatus === 'success')
    default:
      return true
  }
}

/**
 * Asks before discarding an in-progress connection. Reaching step 2 means the
 * user has moved past the informational first step, and step 2's fields start
 * blank (see WizardContext's initialState), so anything entered from here on is
 * deliberate and worth confirming before it's thrown away.
 */
function DiscardConfirm({ open, onCancel, onDiscard }) {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ pb: 0.5, fontSize: 15.5, fontWeight: 600, color: brand.danger }}>
        Discard this connection?
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 13, color: brand.textSecondary, lineHeight: 1.55 }}>
          Closing now discards everything entered so far, including the client secret.
          Nothing has been written to the Claude Code configuration yet.
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button variant="outlined" onClick={onCancel}>
          Keep editing
        </Button>
        <Button variant="contained" color="error" onClick={onDiscard}>
          Discard
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function WizardShell({ onClose, onAdded }) {
  const { state, goNext, goBack } = useWizard()
  const step = state.step
  const Screen = SCREENS[step]
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const canProceed = gateFor(step, state)

  function next() {
    if (step < LAST_STEP) {
      goNext()
      return
    }
    // Finish: reload() takes no argument, it just re-reads the list — one or
    // two connections may have just been written, depending on the targets.
    onAdded()
    onClose()
  }

  // Past step 1 there's something worth losing, so ask first; on step 1 there's
  // nothing entered yet, so just close.
  function requestClose() {
    if (step > 1) {
      setConfirmDiscard(true)
    } else {
      onClose()
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      requestClose()
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (canProceed) next()
    }
  }

  const nextLabel = step === LAST_STEP ? 'Finish' : step === 5 ? 'Continue' : 'Next'

  return (
    <Box
      onKeyDown={handleKeyDown}
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 1300,
        bgcolor: brand.pageBg,
        display: 'flex',
        flexDirection: 'column',
        animation: 'twFadeIn .18s ease-out',
        '@keyframes twFadeIn': { from: { opacity: 0.5 }, to: { opacity: 1 } }
      }}
    >
      <Box
        sx={{
          px: 5,
          py: 2.5,
          bgcolor: brand.panelBg,
          borderBottom: `1px solid ${brand.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0
        }}
      >
        <Typography sx={{ fontSize: 16, fontWeight: 600 }}>Add connection</Typography>
        <IconButton onClick={requestClose} size="small" aria-label="Close">
          <CloseIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Box>

      <Box sx={{ bgcolor: brand.panelBg, borderBottom: `1px solid ${brand.border}`, flexShrink: 0 }}>
        <WizardStepper current={step} />
      </Box>

      <Box sx={{ flex: 1, overflowY: 'auto', px: 5, py: 4 }}>
        <Box sx={{ maxWidth: 640, mx: 'auto' }}>
          <Screen />
        </Box>
      </Box>

      <Box
        sx={{
          px: 5,
          py: 2,
          bgcolor: brand.panelBg,
          borderTop: `1px solid ${brand.border}`,
          display: 'flex',
          justifyContent: 'center',
          flexShrink: 0
        }}
      >
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            maxWidth: 640,
            width: '100%'
          }}
        >
          <Button variant="outlined" onClick={requestClose}>
            Cancel
          </Button>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              variant="text"
              onClick={goBack}
              sx={{ visibility: step === 1 ? 'hidden' : 'visible' }}
            >
              Back
            </Button>
            <Button variant="contained" onClick={next} disabled={!canProceed}>
              {nextLabel}
            </Button>
          </Box>
        </Box>
      </Box>

      <DiscardConfirm
        open={confirmDiscard}
        onCancel={() => setConfirmDiscard(false)}
        onDiscard={() => {
          setConfirmDiscard(false)
          onClose()
        }}
      />
    </Box>
  )
}

/**
 * Full-screen add-connection flow. Mounted only while open, so each run starts
 * from clean state and the entered client secret doesn't outlive the wizard.
 */
export default function AddConnectionWizard({ open, onClose, onAdded }) {
  if (!open) return null
  return (
    <WizardProvider>
      <WizardShell onClose={onClose} onAdded={onAdded} />
    </WizardProvider>
  )
}
