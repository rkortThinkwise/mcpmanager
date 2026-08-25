import { Box } from '@mui/material'
import { statusMeta } from '../theme'

/** The pill next to a connection name. Colour and label come from one map. */
export default function StatusBadge({ status }) {
  const m = statusMeta[status] || statusMeta.error
  return (
    <Box
      component="span"
      sx={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '.2px',
        px: 1,
        py: '2px',
        borderRadius: 20,
        bgcolor: m.bg,
        color: m.color,
        whiteSpace: 'nowrap'
      }}
    >
      {m.label}
    </Box>
  )
}

/** The small coloured dot on the left edge of a connection card. */
export function StatusDot({ status }) {
  const m = statusMeta[status] || statusMeta.error
  return (
    <Box sx={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, bgcolor: m.color }} />
  )
}
