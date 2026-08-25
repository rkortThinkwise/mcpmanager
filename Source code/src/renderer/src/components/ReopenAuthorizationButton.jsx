import { useState } from 'react'
import { Alert, Box, Button, Link, Typography } from '@mui/material'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import { brand } from '../theme'

const IAM_CHECKS = [
  'Does the application have "Allow access delegation" enabled?',
  'Does the user have access delegation enabled?',
  'Does the user have rights to all the required roles?',
  'Are all of those roles enabled for access delegation?',
  'Are all desired roles made available in this client application?'
]

/**
 * Relaunches the sign-in terminal for a connection that's mid-authorization.
 * Shared by every flow that starts a login (wizard step 5, Reauthorize,
 * Refresh scopes, connection details, Duplicate, Rename) so there's always a
 * reliable way back in if the terminal window was closed by accident.
 *
 * Also the one place to surface IAM troubleshooting hints, since it's the
 * single component every authorization-in-progress screen already renders:
 * a rejected or stuck sign-in is most often a role/delegation setting in IAM
 * rather than anything this app got wrong.
 */
export default function ReopenAuthorizationButton({
  target = 'claude',
  name,
  scope,
  projectPath,
  scopes,
  onError
}) {
  const [showHints, setShowHints] = useState(false)

  async function reopen() {
    try {
      if (target === 'codex') {
        await window.api.codex.startLogin({ name, scopes })
      } else {
        await window.api.claude.startLogin({ name, scope, projectPath })
      }
    } catch (e) {
      onError?.(e.message)
    }
  }

  return (
    <Box>
      <Button variant="outlined" startIcon={<OpenInNewIcon />} onClick={reopen} size="small">
        Reopen authorization window
      </Button>

      <Link
        component="button"
        type="button"
        onClick={() => setShowHints((v) => !v)}
        sx={{ fontSize: 12.5, display: 'block', mt: 1.25 }}
      >
        {showHints ? '− Hide' : '+ '}Missing roles, or can't authorize?
      </Link>

      {showHints && (
        <Alert severity="info" sx={{ mt: 1 }}>
          <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 0.75 }}>
            In IAM, check:
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.25, fontSize: 12.5, lineHeight: 1.7, color: brand.textSecondary }}>
            {IAM_CHECKS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </Box>
        </Alert>
      )}
    </Box>
  )
}
