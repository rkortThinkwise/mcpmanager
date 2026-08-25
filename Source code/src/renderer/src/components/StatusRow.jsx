import { Box, CircularProgress, Typography } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ErrorIcon from '@mui/icons-material/Error'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import { brand } from '../theme'

// The shared icon + label + status row used by every automatic step (4, 6, 7,
// 8). `status` is one of: pending | running | success | error.
export default function StatusRow({ status, title, subtitle }) {
  let icon
  if (status === 'running') {
    icon = <CircularProgress size={18} thickness={5} />
  } else if (status === 'success') {
    icon = <CheckCircleIcon sx={{ color: 'success.main', fontSize: 20 }} />
  } else if (status === 'error') {
    icon = <ErrorIcon sx={{ color: 'error.main', fontSize: 20 }} />
  } else {
    icon = <RadioButtonUncheckedIcon sx={{ color: brand.textMuted, fontSize: 20 }} />
  }

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 1.75,
        py: 1.25,
        border: `1px solid ${brand.border}`,
        borderRadius: 2
      }}
    >
      <Box sx={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: 13.5, fontWeight: 500 }}>{title}</Typography>
        {subtitle && (
          // `component="div"`, not the default `<p>`: subtitle is sometimes a
          // rich node (e.g. ErrorDetail, which renders its own block markup
          // for the expandable raw-error case) rather than plain text, and a
          // block element nested in a `<p>` is invalid HTML.
          <Typography
            component="div"
            sx={{ fontSize: 12, color: brand.textSecondary, mt: '1px', wordBreak: 'break-word' }}
          >
            {subtitle}
          </Typography>
        )}
      </Box>
    </Box>
  )
}
