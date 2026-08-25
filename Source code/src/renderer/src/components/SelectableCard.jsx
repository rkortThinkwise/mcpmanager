import { Box, Paper, Radio, Checkbox, Typography } from '@mui/material'
import { brand } from '../theme'

/**
 * A clickable outlined card with a leading Radio or Checkbox, used everywhere
 * the wizard offers a small set of mutually-exclusive or independently
 * toggleable choices (client type, install scope, target application) — one
 * definition so all of them look and behave the same.
 */
export default function SelectableCard({ selected, title, desc, onClick, multiSelect = false }) {
  const Control = multiSelect ? Checkbox : Radio
  return (
    <Paper
      variant="outlined"
      onClick={onClick}
      sx={{
        flex: 1,
        p: 1.5,
        cursor: 'pointer',
        borderColor: selected ? brand.blue : brand.border,
        bgcolor: selected ? '#EAF2FA' : brand.panelBg
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Control checked={selected} size="small" sx={{ p: 0 }} />
        <Typography sx={{ fontSize: 13.5, fontWeight: 500 }}>{title}</Typography>
      </Box>
      {desc && (
        <Typography sx={{ fontSize: 12, color: brand.textSecondary, mt: 0.5 }}>{desc}</Typography>
      )}
    </Paper>
  )
}
