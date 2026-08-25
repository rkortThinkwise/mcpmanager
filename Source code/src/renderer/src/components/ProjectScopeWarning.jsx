import { Alert } from '@mui/material'

/**
 * Shown before any action that rewrites a project-scoped connection.
 *
 * A project connection is defined in a `.mcp.json` committed to the repository.
 * Rename and a scope change are both carried out by re-registering the server,
 * which rewrites that shared file — a consequence the action's own wording
 * ("rename", "apply scopes") gives no hint of. Delete has warned about this
 * from the start; these paths reach the same file by a less obvious route.
 *
 * Creating a *new* entry there isn't warned about, it's refused outright — see
 * assertNotCreatingInProjectScope in services/connections.js.
 */
export default function ProjectScopeWarning({ connection, action, sx }) {
  if (!connection || connection.installScope !== 'project') return null
  return (
    <Alert severity="warning" sx={{ fontSize: 12.5, ...sx }}>
      This is a <strong>project-scoped</strong> connection, defined in the <code>.mcp.json</code> in{' '}
      {connection.projectPath}, which is shared with everyone working on that project. {action} edits
      that file, and committing the change affects your whole team.
    </Alert>
  )
}
