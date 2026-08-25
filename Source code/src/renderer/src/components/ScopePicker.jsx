import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Checkbox,
  Chip,
  Typography
} from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { brand } from '../theme'
import { groupScopesByApplication } from '../../../shared/mcp'

const BADGE_STYLES = {
  added: { bgcolor: brand.successBg, color: brand.success },
  removed: { bgcolor: brand.dangerBg, color: brand.danger }
}

/**
 * Checkbox-style scope picker, grouped by application with a per-group bulk
 * toggle. Shared by the Add Connection wizard, Refresh Scopes, and Duplicate.
 */
export default function ScopePicker({ scopes, onToggleScope, onToggleGroup, getBadge }) {
  const groups = groupScopesByApplication(scopes)

  return (
    <Box>
      {groups.map((g) => {
        const selectedCount = g.scopes.filter((s) => s.selected).length
        const allSelected = selectedCount === g.scopes.length
        return (
          <Accordion
            key={g.application}
            defaultExpanded={false}
            disableGutters
            elevation={0}
            sx={{
              border: `1px solid ${brand.border}`,
              // MUI's Accordion `square={false}` variant sets `borderRadius: 0`
              // unconditionally and only adds it back on the top corners of
              // `:first-of-type` and the bottom corners of `:last-of-type` —
              // so a plain sx override loses on specificity ties for every
              // middle item in a stack, leaving them square. `!important`
              // guarantees uniform rounding regardless of position.
              borderRadius: '16px !important',
              mb: 1,
              '&:before': { display: 'none' },
              '&.Mui-expanded': { mb: 1 }
            }}
          >
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  pr: 1
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  {/* Stops propagation so clicking the checkbox toggles the group
                      instead of also expanding/collapsing the accordion. */}
                  <Checkbox
                    checked={allSelected}
                    indeterminate={selectedCount > 0 && !allSelected}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => onToggleGroup(g.application, !allSelected)}
                    size="small"
                    sx={{ p: 0, mr: 1 }}
                  />
                  <Typography sx={{ fontSize: 13.5, fontWeight: 500 }}>{g.application}</Typography>
                </Box>
                <Typography sx={{ fontSize: 12, color: brand.textSecondary }}>
                  {selectedCount} of {g.scopes.length} selected
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ pt: 0 }}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {g.scopes.map((s) => {
                  const badge = getBadge ? getBadge(s.name) : undefined
                  const badgeSx = badge ? BADGE_STYLES[badge] : null
                  return (
                    <Chip
                      key={s.name}
                      label={s.name.split('/')[1]}
                      onClick={() => onToggleScope(s.name)}
                      variant={s.selected ? 'filled' : 'outlined'}
                      color={s.selected ? 'primary' : 'default'}
                      icon={s.selected ? <CheckIcon sx={{ fontSize: 16 }} /> : undefined}
                      sx={{
                        borderRadius: 4,
                        ...(badgeSx && !s.selected
                          ? { borderColor: badgeSx.color, color: badgeSx.color }
                          : {}),
                        ...(badgeSx && s.selected ? badgeSx : {})
                      }}
                    />
                  )
                })}
              </Box>
            </AccordionDetails>
          </Accordion>
        )
      })}
    </Box>
  )
}
