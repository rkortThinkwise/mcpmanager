import { IconButton } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { brand } from '../theme'

/**
 * Same top-right close affordance on every screen (the wizard's header already
 * used this exact position/icon) so dismissing anything is always found in the
 * same place, rather than hunting among the footer's action buttons.
 */
export default function DialogCloseButton({ onClose, disabled }) {
  return (
    <IconButton
      onClick={onClose}
      disabled={disabled}
      size="small"
      aria-label="Close"
      sx={{ position: 'absolute', right: 12, top: 12, color: brand.textSecondary }}
    >
      <CloseIcon sx={{ fontSize: 20 }} />
    </IconButton>
  )
}
