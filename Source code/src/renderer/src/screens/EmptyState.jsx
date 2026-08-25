import { Box, Button, Paper, Typography } from '@mui/material'
import HubOutlinedIcon from '@mui/icons-material/HubOutlined'
import { brand } from '../theme'

/**
 * Shown in place of the list when there are no connections. Every element is
 * centered in its own box, not just the container: `text-align: center` on the
 * text itself and `margin: 0 auto` on the icon tile, because centering only the
 * flex parent leaves wrapped multi-line text left-aligned inside its own box
 * (PLAN.md, "Empty state splash").
 */
export default function EmptyState({ onAdd }) {
  return (
    <Paper
      variant="outlined"
      sx={{
        mt: 5,
        px: 2.5,
        py: 10,
        borderRadius: 4,
        borderColor: brand.border,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center'
      }}
    >
      <Box
        sx={{
          width: 64,
          height: 64,
          borderRadius: 4,
          background: `linear-gradient(135deg, ${brand.blue}, ${brand.navy})`,
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          mx: 'auto',
          mb: 2.75
        }}
      >
        <HubOutlinedIcon sx={{ fontSize: 30 }} />
      </Box>

      <Typography
        sx={{ width: '100%', textAlign: 'center', fontSize: 19, fontWeight: 600, mb: 1 }}
      >
        No connections yet
      </Typography>

      <Typography
        sx={{
          width: '100%',
          maxWidth: 340,
          mx: 'auto',
          mb: 3,
          textAlign: 'center',
          fontSize: 13.5,
          lineHeight: 1.6,
          color: brand.textSecondary
        }}
      >
        Connect an MCP server to give Claude Code access to it. It only takes a few steps.
      </Typography>

      <Button variant="contained" onClick={onAdd}>
        Add your first connection
      </Button>
    </Paper>
  )
}
