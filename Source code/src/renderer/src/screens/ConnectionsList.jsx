import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  Switch,
  Tooltip,
  Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import ConnectionCard from '../components/ConnectionCard'
import ErrorDetail from '../components/ErrorDetail'
import EmptyState from './EmptyState'
import { useConnections } from '../state/ConnectionsContext'
import { TARGETS, TARGET_LABELS, TARGET_SCOPES, TARGET_SCOPE_LABELS } from '../../../shared/mcp'
import { brand } from '../theme'
import { pluralize } from '../format'

// One heading per scope within a target. Rendered in each target's own scope
// order (see TARGET_SCOPES) — broadest reach to narrowest, which is how
// you'd reason about where a server is available.
function ScopeSection({ scope, scopeLabels, connections, projectGrouped, ...handlers }) {
  const meta = scopeLabels[scope]
  return (
    <Box sx={{ mb: 3.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1.25 }}>
        <Typography
          sx={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.8,
            textTransform: 'uppercase',
            color: brand.textSecondary
          }}
        >
          {meta.label}
        </Typography>
        <Typography sx={{ fontSize: 11.5, color: brand.textMuted }}>
          {meta.description} · {pluralize(connections.length, 'connection')}
        </Typography>
      </Box>

      {projectGrouped ? (
        // local and project scope are both per-project, so the path is the
        // useful sub-heading; showing it once beats repeating it on every card.
        Object.entries(projectGrouped).map(([projectPath, list]) => (
          <Box key={projectPath} sx={{ mb: 2 }}>
            <Tooltip title={projectPath}>
              <Typography
                sx={{
                  fontSize: 11,
                  fontFamily: brand.mono,
                  color: brand.textMuted,
                  mb: 0.75,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {projectPath}
              </Typography>
            </Tooltip>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              {list.map((c) => (
                <ConnectionCard key={c.id} connection={c} {...handlers} />
              ))}
            </Box>
          </Box>
        ))
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {connections.map((c) => (
            <ConnectionCard key={c.id} connection={c} {...handlers} />
          ))}
        </Box>
      )}
    </Box>
  )
}

// Disabled connections sink to the bottom of their group — they're the ones you
// act on least often. Array.prototype.sort is stable, so the order among enabled
// (and among disabled) connections is otherwise preserved.
function enabledFirst(list) {
  return [...list].sort((a, b) => (a.status === 'disabled' ? 1 : 0) - (b.status === 'disabled' ? 1 : 0))
}

export default function ConnectionsList({ onAdd, onSettings, ...handlers }) {
  const { connections, loading, error, checkingScopes, codexListError } = useConnections()
  // Disabled connections are the ones acted on least, so they're hidden by
  // default to keep the list focused on what's actually in use; the toggle
  // brings them back for the occasional "did I turn that off?" check.
  const [showDisabled, setShowDisabled] = useState(false)

  const disabledCount = connections.filter((c) => c.status === 'disabled').length
  const visible = showDisabled ? connections : connections.filter((c) => c.status !== 'disabled')

  // Group by target first (Claude Code, Codex), then by that target's own
  // scope vocabulary within each — Codex only has one (its global config), so
  // its section is always a single flat list.
  const byTarget = TARGETS.map((target) => {
    const targetConns = visible.filter((c) => c.target === target)
    if (targetConns.length === 0) return null

    const byScope = TARGET_SCOPES[target].map((scope) => {
      const list = enabledFirst(targetConns.filter((c) => c.installScope === scope))
      if (list.length === 0) return null
      // user scope isn't tied to a project, so it gets a flat list.
      if (scope === 'user') return { scope, connections: list, projectGrouped: null }
      const projectGrouped = {}
      for (const c of list) {
        const key = c.projectPath || 'Unknown project'
        ;(projectGrouped[key] ||= []).push(c)
      }
      return { scope, connections: list, projectGrouped }
    }).filter(Boolean)

    return { target, byScope }
  }).filter(Boolean)

  return (
    <Box sx={{ flex: 1, px: 3.5, pt: 4, pb: 7.5 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 1.5,
          mb: 2.75
        }}
      >
        <Box>
          <Typography component="h1" sx={{ fontSize: 22, fontWeight: 600, mb: 0.5 }}>
            Connections
          </Typography>
          <Typography sx={{ fontSize: 13.5, color: brand.textSecondary }}>
            Every MCP server connected to Claude Code or Codex, in one place.
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {checkingScopes && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mr: 0.5 }}>
              <CircularProgress size={13} thickness={5} />
              <Typography sx={{ fontSize: 11.5, color: brand.textSecondary }}>
                Checking scopes…
              </Typography>
            </Box>
          )}
          {disabledCount > 0 && (
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={showDisabled}
                  onChange={(e) => setShowDisabled(e.target.checked)}
                />
              }
              label={`Show disabled${showDisabled ? '' : ` (${disabledCount})`}`}
              sx={{
                mr: 0.5,
                '& .MuiFormControlLabel-label': { fontSize: 12.5, color: brand.textSecondary }
              }}
            />
          )}
          <Tooltip title="Settings">
            <Button variant="outlined" onClick={onSettings} sx={{ minWidth: 0, px: 1.5 }}>
              <SettingsOutlinedIcon sx={{ fontSize: 18 }} />
            </Button>
          </Tooltip>
          <Button variant="contained" startIcon={<AddIcon />} onClick={onAdd}>
            Add connection
          </Button>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Set when `codex mcp list --json` couldn't be parsed (e.g. a Codex
          CLI update changing its output format, or a corrupted
          ~/.codex/config.toml) — Codex connections would otherwise just
          silently disappear from the list below with nothing to explain why. */}
      {codexListError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <ErrorDetail
            summary="Codex connections could not be loaded — some may be missing from the list below."
            detail={codexListError}
          />
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
          <CircularProgress size={26} />
        </Box>
      ) : connections.length === 0 ? (
        <EmptyState onAdd={onAdd} />
      ) : visible.length === 0 ? (
        // Every connection exists but all of them are disabled and hidden —
        // distinct from the true empty state, which pushes toward adding one.
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography sx={{ fontSize: 13.5, color: brand.textSecondary, mb: 1.5 }}>
            {pluralize(disabledCount, 'connection')} disabled and hidden.
          </Typography>
          <Button variant="outlined" size="small" onClick={() => setShowDisabled(true)}>
            Show disabled connections
          </Button>
        </Box>
      ) : (
        byTarget.map(({ target, byScope }) => (
          <Box key={target} sx={{ mb: 4 }}>
            {byTarget.length > 1 && (
              <Typography
                sx={{
                  fontSize: 13,
                  fontWeight: 700,
                  mb: 1.5,
                  pb: 0.75,
                  borderBottom: `1px solid ${brand.border}`
                }}
              >
                {TARGET_LABELS[target].label}
              </Typography>
            )}
            {byScope.map((s) => (
              <ScopeSection
                key={s.scope}
                scope={s.scope}
                scopeLabels={TARGET_SCOPE_LABELS[target]}
                connections={s.connections}
                projectGrouped={s.projectGrouped}
                {...handlers}
              />
            ))}
          </Box>
        ))
      )}

      {/* Claude Code also lists connectors managed at claude.ai, which live in
          the account rather than in ~/.claude.json and aren't configurable
          through the CLI. This app reads the config file, so they can't appear
          here — saying so beats looking like connections have gone missing. */}
      <Typography sx={{ fontSize: 11.5, color: brand.textMuted, mt: 4, lineHeight: 1.6 }}>
        Connectors you enabled at claude.ai aren't shown here — they're stored in your Claude
        account rather than in this computer's configuration, so Claude Code manages them itself.
      </Typography>
    </Box>
  )
}
