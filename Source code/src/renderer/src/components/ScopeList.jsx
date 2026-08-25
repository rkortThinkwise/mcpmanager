import { Box, Typography } from '@mui/material'
import ScopeChip from './ScopeChip'
import { groupScopeNamesByApplication } from '../../../shared/mcp'
import { brand } from '../theme'

/**
 * Scope chips grouped under their application heading.
 *
 * Application scopes are named `application_name/scope_name`, and a real
 * connection carries dozens across a handful of applications — an ungrouped
 * chip wall is unreadable. The application prefix is dropped from each chip
 * since the heading already carries it.
 */
export default function ScopeList({ scopes, variant = 'plain', emptyLabel = 'None' }) {
  if (!scopes || scopes.length === 0) {
    return <Typography sx={{ fontSize: 11.5, color: brand.textSecondary }}>{emptyLabel}</Typography>
  }

  const groups = groupScopeNamesByApplication(scopes)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {groups.map((g) => (
        <Box key={g.application}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75 }}>
            <Typography
              sx={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                color: brand.textSecondary
              }}
            >
              {g.application}
            </Typography>
            <Typography sx={{ fontSize: 10.5, color: brand.textMuted }}>
              {g.names.length}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
            {g.names.map((name) => (
              <ScopeChip
                key={name}
                // The heading carries the application, so the chip shows only
                // the scope half of `application/scope`.
                label={name.slice(g.application.length + 1) || name}
                variant={variant}
              />
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
