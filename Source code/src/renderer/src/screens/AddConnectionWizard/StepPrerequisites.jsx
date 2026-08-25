import { useEffect, useState } from 'react'
import { Box, Link, Paper, Typography } from '@mui/material'
import StatusRow from '../../components/StatusRow'
import SelectableCard from '../../components/SelectableCard'
import ErrorDetail from '../../components/ErrorDetail'
import { brand } from '../../theme'
import { useWizard, TARGETS } from '../../state/WizardContext'
import { TARGET_LABELS } from '../../../../shared/mcp'

const CLAUDE_CLI_INSTALL_URL = 'https://code.claude.com/docs/en/setup'
const CODEX_CLI_INSTALL_URL = 'https://developers.openai.com/codex/cli'

// One entry per target's checklist. `check` names the detector below; targets
// with no checklist item (none, currently) simply omit it.
const PREREQS = {
  claude: [
    {
      title: 'Thinkwise Platform 2026.3 or higher',
      desc: 'The MCP endpoint on the target server requires at least this platform version.'
    },
    {
      title: 'A Claude license with Claude Code access',
      desc: 'Pro, Max, or Enterprise. Not available on the Free plan.'
    },
    {
      title: 'The Claude Code CLI installed',
      desc: 'This app registers the server through the Claude Code CLI, which is also the only way to store the OAuth client secret securely.',
      linkLabel: 'How to install the Claude Code CLI',
      linkUrl: CLAUDE_CLI_INSTALL_URL,
      check: 'claude'
    },
    {
      title: 'Visual Studio Code with the Claude Code extension',
      desc: 'Both need to already be installed. The final step covers finishing the connection there. This only checks for VS Code itself — the extension is confirmed in the last step.',
      check: 'vscode'
    }
  ],
  codex: [
    {
      title: 'The Codex CLI installed',
      desc: 'This app registers the server, and starts sign-in, through the Codex CLI. Codex authenticates as a public (PKCE) client — no client secret is ever stored.',
      linkLabel: 'How to install the Codex CLI',
      linkUrl: CODEX_CLI_INSTALL_URL,
      check: 'codex'
    }
  ]
}

function useDetection(fn, active) {
  const [state, setState] = useState({ status: 'running' })
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setState({ status: 'running' })
    fn()
      .then((res) => {
        // `healthy` means the binary was found AND actually ran. The CLI
        // detectors report it; vscode.detect() doesn't, so fall back to `found`
        // for those rather than treating a missing field as unhealthy.
        const ok = res.healthy === undefined ? res.found : res.healthy
        if (!cancelled) setState({ status: ok ? 'success' : 'error', result: res })
      })
      .catch((e) => {
        if (!cancelled) setState({ status: 'error', result: { found: false, error: e.message } })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  return state
}

/**
 * Turns one `useDetection` result into a status/title/subtitle triple.
 *
 * `result.error` is only set when the detection call itself threw (a spawn
 * failure, a permission error) — genuinely distinct from "ran fine and just
 * didn't find it" (`result.found === false`, no error). Showing the same
 * fixed "Not found" text for both used to hide that distinction entirely.
 */
function describeDetection(label, detection) {
  const { status, result } = detection
  if (status === 'running') {
    return { title: 'Checking…', subtitle: `Checking for ${label}…` }
  }
  if (status === 'success') {
    return {
      title: 'Found',
      subtitle: `Found${result.version ? ` — v${result.version}` : ''} at ${result.path}`
    }
  }
  // Found on disk but not runnable — the case a global npm install on Windows
  // lands in, where the PATH entry is a shell script Windows can't execute.
  // This used to be reported as "Found", and then every later step failed.
  if (result?.found && result?.healthy === false) {
    return {
      title: 'Found, but it could not be run',
      subtitle: <ErrorDetail summary={result.message} detail={result.detail} />
    }
  }
  if (result?.error) {
    return {
      title: 'Could not check',
      subtitle: (
        <ErrorDetail summary={`Could not check whether ${label} is installed.`} detail={result.error} />
      )
    }
  }
  return { title: 'Not found', subtitle: 'Not found on this computer. Install it, then relaunch this app.' }
}

export default function StepPrerequisites() {
  const { state, update } = useWizard()
  const { targets } = state

  const claude = useDetection(() => window.api.claude.detect(), targets.claude)
  const vscode = useDetection(() => window.api.vscode.detect(), targets.claude)
  const codex = useDetection(() => window.api.codex.detect(), targets.codex)

  const toggleTarget = (t) => update('targets', { [t]: !targets[t] })

  const checks = {
    claude: { status: claude.status, ...describeDetection('the Claude Code CLI', claude) },
    vscode: { status: vscode.status, ...describeDetection('Visual Studio Code', vscode) },
    codex: { status: codex.status, ...describeDetection('the Codex CLI', codex) }
  }

  return (
    <Box>
      <Typography sx={{ fontSize: 12.5, fontWeight: 500, color: brand.textSecondary, mb: 1 }}>
        Install into
      </Typography>
      <Box sx={{ display: 'flex', gap: 1.5, mb: 2.75 }}>
        {TARGETS.map((t) => (
          <SelectableCard
            key={t}
            multiSelect
            selected={targets[t]}
            title={TARGET_LABELS[t].label}
            desc={TARGET_LABELS[t].description}
            onClick={() => toggleTarget(t)}
          />
        ))}
      </Box>

      <Typography sx={{ fontSize: 13, color: brand.textSecondary, mb: 2 }}>
        Check these before connecting a new server.
      </Typography>
      {TARGETS.filter((t) => targets[t]).flatMap((t) => PREREQS[t]).map((p) => (
        <Paper
          key={p.title}
          variant="outlined"
          sx={{ px: 2.25, py: 2, mb: 1.75, borderColor: brand.border, bgcolor: brand.panelBg }}
        >
          <Typography sx={{ fontSize: 13.5, fontWeight: 600, mb: 0.5 }}>{p.title}</Typography>
          <Typography sx={{ fontSize: 12.5, color: brand.textSecondary, lineHeight: 1.5, mb: p.check ? 1.25 : 0 }}>
            {p.desc}
          </Typography>
          {p.check && (
            <StatusRow
              status={checks[p.check].status}
              title={checks[p.check].title}
              subtitle={checks[p.check].subtitle}
            />
          )}
          {p.linkUrl && (
            <Link
              component="button"
              type="button"
              onClick={() => window.api.openExternal(p.linkUrl)}
              sx={{ fontSize: 12.5, mt: 1, display: 'inline-block' }}
            >
              {p.linkLabel} →
            </Link>
          )}
        </Paper>
      ))}
    </Box>
  )
}
