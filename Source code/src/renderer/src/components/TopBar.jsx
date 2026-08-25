import { Box, Typography } from '@mui/material'
import { brand } from '../theme'
import Logo from './Logo'

// App bar: the app mark at small size, top-left, beside the app name and
// a one-line description of what the app is for. Spans the full width of the
// window (its parent isn't constrained to the centered content column).
export default function TopBar() {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.75,
        px: 3.5,
        py: 2.25,
        bgcolor: brand.panelBg,
        borderBottom: `1px solid ${brand.border}`,
        flexShrink: 0
      }}
    >
      <Logo width={32} />
      <Box sx={{ borderLeft: `1px solid ${brand.border}`, alignSelf: 'stretch' }} />
      <Box sx={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
        <Typography sx={{ fontSize: 16, fontWeight: 600, color: brand.ink }}>
          MCP Manager
        </Typography>
        <Typography sx={{ fontSize: 12, color: brand.textSecondary }}>
          Manage MCP server connections for Claude Code
        </Typography>
      </Box>
    </Box>
  )
}
