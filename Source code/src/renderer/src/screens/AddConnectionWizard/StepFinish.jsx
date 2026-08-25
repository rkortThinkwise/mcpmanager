import { Alert, Box, Typography } from '@mui/material'
import { brand } from '../../theme'
import { useWizard } from '../../state/WizardContext'

// Purely informational close-out. The connection(s) are already written and
// authorized by this point; "Finish" in the footer closes the wizard and
// reloads the list.
export default function StepFinish() {
  const { state, selectedTargets } = useWizard()
  const { config } = state

  return (
    <Box>
      <Alert severity="success" sx={{ mb: 2 }}>
        {selectedTargets.length > 1 ? 'Connections added.' : 'Connection added.'}
      </Alert>

      {selectedTargets.includes('claude') && (
        <Box sx={{ mb: selectedTargets.includes('codex') ? 2 : 0 }}>
          <Typography sx={{ fontSize: 13.5, lineHeight: 1.7 }}>
            Open a new chat session in Claude Code to get started using your MCP connection.
          </Typography>
          <Typography sx={{ fontSize: 12.5, color: brand.textSecondary, mt: 1.5 }}>
            {config.installScope === 'user'
              ? 'Available to you in all your projects.'
              : `Available to you in ${config.projectPath}.`}
          </Typography>
        </Box>
      )}

      {selectedTargets.includes('codex') && (
        <Box>
          <Typography sx={{ fontSize: 13.5, lineHeight: 1.7 }}>
            Run <code>codex</code> to get started using your MCP connection.
          </Typography>
          <Typography sx={{ fontSize: 12.5, color: brand.textSecondary, mt: 1.5 }}>
            Available to you in every project — Codex's global configuration isn't per-project yet.
          </Typography>
        </Box>
      )}
    </Box>
  )
}
