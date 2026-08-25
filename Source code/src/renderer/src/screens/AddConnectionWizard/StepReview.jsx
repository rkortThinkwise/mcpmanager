import { useEffect, useState } from 'react'
import { Alert, Box, Button, Paper, Radio, Typography } from '@mui/material'
import StatusRow from '../../components/StatusRow'
import { SCOPE_LABELS, TARGET_LABELS } from '../../../../shared/mcp'
import { brand } from '../../theme'
import { useWizard } from '../../state/WizardContext'

function Row({ label, value }) {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 2,
        py: 1,
        borderBottom: `1px solid ${brand.border}`,
        '&:last-of-type': { borderBottom: 'none' }
      }}
    >
      <Typography sx={{ fontSize: 13, color: brand.textSecondary, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography
        sx={{ fontSize: 13, fontWeight: 500, textAlign: 'right', maxWidth: '60%', wordBreak: 'break-all' }}
      >
        {value}
      </Typography>
    </Box>
  )
}

function InstallScopeCard({ selected, title, desc, onClick }) {
  return (
    <Paper
      variant="outlined"
      onClick={onClick}
      sx={{
        flex: 1,
        p: 2,
        cursor: 'pointer',
        borderColor: selected ? brand.blue : brand.border,
        bgcolor: selected ? '#EAF2FA' : brand.panelBg
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Radio checked={selected} size="small" sx={{ p: 0 }} />
        <Typography sx={{ fontSize: 13.5, fontWeight: 500 }}>{title}</Typography>
      </Box>
      <Typography sx={{ fontSize: 12, color: brand.textSecondary, mt: 0.5 }}>{desc}</Typography>
    </Paper>
  )
}

/**
 * Last point to go back and change anything before writing.
 *
 * The install-scope choice lives here rather than in the write step: the plan
 * has step 5 running automatically with no input, and where a connection gets
 * installed is part of what's about to be written, so it belongs in the review.
 *
 * Claude Code and Codex are reviewed as two independent sub-sections: Claude
 * Code needs a config file located and a scope/project chosen, Codex doesn't
 * (global config only, driven entirely by the CLI — see codexCli.js), so its
 * section is a single informational line.
 */
export default function StepReview() {
  const { state, update, selectedScopes, endpoints } = useWizard()
  const { server, connectivity, config, targets } = state
  const wantsClaude = targets.claude
  const wantsCodex = targets.codex
  const [error, setError] = useState(null)

  const metadataUrl = connectivity.metadata?.metadataUrl || endpoints.metadataUrl

  // Locate the Claude config on entry, so a project can be picked below.
  // Nothing to locate for Codex — it has no config file this app reads.
  useEffect(() => {
    if (!wantsClaude || config.located) return
    ;(async () => {
      try {
        const located = await window.api.config.locate()
        if (located.found) {
          const v = await window.api.config.validate(located.path)
          update('config', { located, configPath: v.valid ? v.path : null, valid: v.valid })
        } else {
          update('config', { located, valid: false })
        }
      } catch (e) {
        setError(e.message)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load the project list once we have a valid config path.
  useEffect(() => {
    if (!wantsClaude || !config.configPath || !config.valid) return
    ;(async () => {
      try {
        const projects = await window.api.config.listProjects(config.configPath)
        const patch = { projects }
        // Auto-select the sole project (still shown, not silently applied).
        if (config.installScope === 'local' && !config.projectPath && projects.length === 1) {
          patch.projectPath = projects[0]
        }
        update('config', patch)
      } catch (e) {
        setError(e.message)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.configPath, config.valid, config.installScope])

  async function pickFile() {
    try {
      const res = await window.api.config.pickFile()
      if (res.canceled) return
      if (!res.valid) {
        setError(res.error || 'Selected file is not a valid Claude config.')
        return
      }
      setError(null)
      update('config', {
        configPath: res.path,
        valid: true,
        located: { found: true, path: res.path }
      })
    } catch (e) {
      setError(e.message)
    }
  }

  function selectScope(scope) {
    update('config', {
      installScope: scope,
      projectPath: scope === 'user' ? null : config.projectPath
    })
  }

  return (
    <Box>
      <Typography sx={{ fontSize: 13, color: brand.textSecondary, mb: 2 }}>
        This is what will be written
        {wantsClaude && wantsCodex
          ? ' to Claude Code and Codex.'
          : wantsClaude
            ? ' to the Claude Code configuration.'
            : ' to Codex.'}
      </Typography>

      <Paper variant="outlined" sx={{ px: 2.25, py: 0.5, mb: 2.5, borderColor: brand.border }}>
        <Row label="Install into" value={[wantsClaude && 'Claude Code', wantsCodex && 'Codex'].filter(Boolean).join(' + ')} />
        <Row label="Server name" value={server.name} />
        <Row label="Indicium base URL" value={endpoints.baseUrl} />
        <Row label="MCP endpoint" value={endpoints.mcpUrl} />
        <Row label="Client ID" value={server.clientId} />
        {wantsClaude && (
          <Row
            label="Client type (Claude Code)"
            value={server.clientType === 'public' ? 'Public (no secret)' : 'Confidential'}
          />
        )}
        {wantsClaude && <Row label="Callback port (Claude Code)" value={server.callbackPort} />}
        <Row label="Metadata URL" value={metadataUrl} />
        <Row label="Scopes" value={`${selectedScopes.length} selected`} />
      </Paper>

      {wantsClaude && (
        <>
          <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1.5 }}>Claude Code</Typography>

          {config.located?.found ? (
            <Box sx={{ mb: 1.5 }}>
              <StatusRow
                status="success"
                title="Config located"
                subtitle={config.configPath || config.located.path}
              />
            </Box>
          ) : (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              Couldn't find <code>~/.claude.json</code> automatically. Choose it manually below.
            </Alert>
          )}
          <Button variant="outlined" onClick={pickFile} sx={{ mb: 2.75 }}>
            Choose a different file…
          </Button>

          <Typography sx={{ fontSize: 12.5, fontWeight: 500, color: brand.textSecondary, mb: 1 }}>
            Install scope
          </Typography>
          {/* Claude Code's own scope names. Its third scope, `project`, writes to a
              .mcp.json that's committed to the repo and isn't offered here: that
              file is shared with the team, and this flow collects a client secret. */}
          <Box sx={{ display: 'flex', gap: 2, mb: 2.25 }}>
            <InstallScopeCard
              selected={config.installScope === 'user'}
              title={SCOPE_LABELS.user.label}
              desc={SCOPE_LABELS.user.description}
              onClick={() => selectScope('user')}
            />
            <InstallScopeCard
              selected={config.installScope === 'local'}
              title={SCOPE_LABELS.local.label}
              desc={SCOPE_LABELS.local.description}
              onClick={() => selectScope('local')}
            />
          </Box>

          {config.installScope === 'local' && (
            <Box sx={{ mb: 2.25 }}>
              <Typography sx={{ fontSize: 12.5, fontWeight: 500, color: brand.textSecondary, mb: 1 }}>
                Select project
              </Typography>
              {config.projects.length === 0 ? (
                <Alert severity="info">
                  No existing projects were found in this config. Choose Global scope, or open the
                  project in Claude Code first so it appears here.
                </Alert>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {config.projects.map((p) => {
                    const sel = config.projectPath === p
                    return (
                      <Paper
                        key={p}
                        variant="outlined"
                        onClick={() => update('config', { projectPath: p })}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1.25,
                          px: 1.75,
                          py: 1.25,
                          cursor: 'pointer',
                          borderColor: sel ? brand.blue : brand.border,
                          bgcolor: sel ? '#EAF2FA' : brand.panelBg
                        }}
                      >
                        <Radio checked={sel} size="small" sx={{ p: 0 }} />
                        <Typography sx={{ fontSize: 13, wordBreak: 'break-all' }}>{p}</Typography>
                      </Paper>
                    )
                  })}
                </Box>
              )}
            </Box>
          )}
        </>
      )}

      {wantsCodex && (
        <Box sx={{ mb: 1 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1.5 }}>Codex</Typography>
          <StatusRow
            status="success"
            title="Global — ~/.codex/config.toml"
            subtitle={TARGET_LABELS.codex.description}
          />
        </Box>
      )}

      {error && <Alert severity="error">{error}</Alert>}
    </Box>
  )
}
