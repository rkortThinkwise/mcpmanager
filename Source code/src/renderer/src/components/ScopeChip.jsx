import { Box } from '@mui/material'
import { brand } from '../theme'

// Scope chips in three variants: plain (unchanged / current), added (green) and
// removed (struck-through red), per wireframe.html.
const VARIANTS = {
  plain: { bg: brand.chipBg, color: brand.chipInk, border: brand.border, strike: false },
  added: { bg: brand.successBg, color: brand.success, border: 'transparent', strike: false },
  removed: { bg: brand.dangerBg, color: brand.danger, border: 'transparent', strike: true }
}

export default function ScopeChip({ label, variant = 'plain' }) {
  const v = VARIANTS[variant] || VARIANTS.plain
  return (
    <Box
      component="span"
      sx={{
        fontSize: 11,
        px: 1.125,
        py: '3px',
        borderRadius: 20,
        bgcolor: v.bg,
        color: v.color,
        border: `1px solid ${v.border}`,
        textDecoration: v.strike ? 'line-through' : 'none',
        wordBreak: 'break-all'
      }}
    >
      {label}
    </Box>
  )
}
