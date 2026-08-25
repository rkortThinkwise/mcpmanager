import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  TextField,
  Typography
} from '@mui/material'
import DialogCloseButton from '../components/DialogCloseButton'
import ErrorDetail from '../components/ErrorDetail'
import { useConnections } from '../state/ConnectionsContext'
import { brand } from '../theme'
import { formatLastVerified } from '../format'

export default function SettingsModal({ open, onClose }) {
  const {
    settings,
    settingsLoadError,
    saveSettings,
    checkScopesNow,
    checkingScopes,
    system,
    systemError
  } = useConnections()
  const [error, setError] = useState(null)
  // Held locally while typing: committing per keystroke would rewrite
  // settings.json and throw away the resolver's cache on every character.
  const [cliPathDraft, setCliPathDraft] = useState(null)
  const [cliTest, setCliTest] = useState(null)

  if (!settings) return null

  const cliPathValue = cliPathDraft ?? settings.claudeCliPath ?? ''

  function commitCliPath(value) {
    setCliPathDraft(null)
    setCliTest(null)
    // '' clears the override and returns to automatic detection.
    if ((value || '') === (settings.claudeCliPath || '')) return
    set({ claudeCliPath: value || null })
  }

  async function browseCliPath() {
    setError(null)
    try {
      const res = await window.api.settings.pickCliPath()
      if (res.canceled) return
      setCliPathDraft(null)
      setCliTest(null)
      set({ claudeCliPath: res.path })
    } catch (e) {
      setError(e.message)
    }
  }

  async function revealLogs() {
    setError(null)
    try {
      await window.api.settings.revealLogs()
    } catch (e) {
      setError(e.message)
    }
  }

  async function testCli() {
    setCliTest({ running: true })
    try {
      setCliTest({ running: false, result: await window.api.claude.detect() })
    } catch (e) {
      setCliTest({ running: false, error: e.message })
    }
  }

  const set = (patch) => {
    setError(null)
    saveSettings(patch).catch((e) => setError(e.message))
  }

  async function checkNow() {
    setError(null)
    try {
      await checkScopesNow()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 0.5, pr: 5, fontSize: 15.5, fontWeight: 600, position: 'relative' }}>
        Settings
        <DialogCloseButton onClose={onClose} />
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 1 }}>Scope checks</Typography>
        <Typography sx={{ fontSize: 12.5, color: brand.textSecondary, mb: 2, lineHeight: 1.55 }}>
          The manager re-reads each server's OAuth metadata endpoint on this schedule and compares
          the scopes it advertises against what each connection is configured with. Connections that
          differ are flagged as needing a scope refresh. This only reads — nothing is changed and no
          authorization is triggered.
        </Typography>

        <TextField
          select
          label="Check for scope changes"
          size="small"
          fullWidth
          value={settings.scopeCheckIntervalMinutes}
          onChange={(e) => set({ scopeCheckIntervalMinutes: Number(e.target.value) })}
          sx={{ mb: 1.5 }}
        >
          {settings.intervalOptions.map((o) => (
            <MenuItem key={o.minutes} value={o.minutes}>
              {o.label}
            </MenuItem>
          ))}
        </TextField>

        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={Boolean(settings.checkOnStartup)}
              onChange={(e) => set({ checkOnStartup: e.target.checked })}
            />
          }
          label={
            <Typography sx={{ fontSize: 13 }}>Also check shortly after the app starts</Typography>
          }
        />

        <Paper
          variant="outlined"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            px: 2,
            py: 1.5,
            mt: 1.5,
            borderColor: brand.border
          }}
        >
          <Box>
            <Typography sx={{ fontSize: 13, fontWeight: 500 }}>Last checked</Typography>
            <Typography sx={{ fontSize: 12, color: brand.textSecondary }}>
              {settings.lastCheckAt ? formatLastVerified(settings.lastCheckAt) : 'Never'}
            </Typography>
          </Box>
          <Button variant="outlined" onClick={checkNow} disabled={checkingScopes}>
            {checkingScopes ? 'Checking…' : 'Check now'}
          </Button>
        </Paper>

        {settings.scopeCheckIntervalMinutes === 0 && (
          <Alert severity="info" sx={{ mt: 1.5, fontSize: 12.5 }}>
            Automatic checks are off. Scope changes on the server won't be flagged until you use
            "Check now" or open a connection's refresh-scopes dialog.
          </Alert>
        )}

        {/* Set by scopeWatcher.js when a whole sweep failed outright, not
            just one connection's own drift check (which shows on its own
            card instead) — recorded next to lastCheckAt so it doesn't need
            its own storage or UI surface. */}
        {settings.lastCheckError && (
          <Alert severity="warning" sx={{ mt: 1.5, fontSize: 12.5 }}>
            <ErrorDetail summary="The last scope check failed to run." detail={settings.lastCheckError} />
          </Alert>
        )}

        {settings.settingsCorrupted && (
          <Alert severity="warning" sx={{ mt: 1.5, fontSize: 12.5 }}>
            <ErrorDetail
              summary="Your saved settings file appears unreadable — showing defaults instead."
              detail={settings.settingsError}
            />
          </Alert>
        )}

        {settingsLoadError && (
          <Alert severity="error" sx={{ mt: 1.5, fontSize: 12.5 }}>
            <ErrorDetail summary="Settings could not be loaded." detail={settingsLoadError} />
          </Alert>
        )}

        <Typography sx={{ fontSize: 12.5, fontWeight: 600, mt: 3, mb: 1 }}>
          Claude Code CLI
        </Typography>
        <Typography sx={{ fontSize: 12.5, color: brand.textSecondary, lineHeight: 1.55 }}>
          This app registers connections and starts sign-in through the Claude Code CLI, which it
          normally finds on its own. Set a path here only if it can't — an unusual install location,
          or a PATH this app doesn't inherit. Leave it empty to detect automatically.
        </Typography>

        <Box sx={{ display: 'flex', gap: 1, mt: 1.5, alignItems: 'flex-start' }}>
          <TextField
            size="small"
            fullWidth
            label="Claude CLI path (optional)"
            placeholder="Detected automatically"
            value={cliPathValue}
            onChange={(e) => setCliPathDraft(e.target.value)}
            onBlur={(e) => commitCliPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCliPath(e.target.value)
            }}
            inputProps={{ spellCheck: false }}
          />
          <Button variant="outlined" onClick={browseCliPath} sx={{ flexShrink: 0, mt: 0.25 }}>
            Browse…
          </Button>
          <Button
            variant="outlined"
            onClick={testCli}
            disabled={cliTest?.running}
            sx={{ flexShrink: 0, mt: 0.25 }}
          >
            {cliTest?.running ? 'Testing…' : 'Test'}
          </Button>
        </Box>

        {cliTest && !cliTest.running && cliTest.error && (
          <Alert severity="error" sx={{ mt: 1.5, fontSize: 12.5 }}>
            <ErrorDetail summary="Could not check the CLI." detail={cliTest.error} />
          </Alert>
        )}
        {cliTest?.result?.healthy && (
          <Alert severity="success" sx={{ mt: 1.5, fontSize: 12.5 }}>
            {`Working — v${cliTest.result.version} at ${cliTest.result.path}`}
          </Alert>
        )}
        {cliTest?.result && !cliTest.result.healthy && (
          <Alert severity="error" sx={{ mt: 1.5, fontSize: 12.5 }}>
            {/* The candidate list is the useful part here: it says exactly where
                the app looked, which is what turns "not found" into something
                the user can act on. */}
            <ErrorDetail summary={cliTest.result.message} detail={cliTest.result.detail} />
          </Alert>
        )}

        <Typography sx={{ fontSize: 12.5, fontWeight: 600, mt: 3, mb: 1 }}>
          Client secrets
        </Typography>
        <Typography sx={{ fontSize: 12.5, color: brand.textSecondary, lineHeight: 1.55 }}>
          Updating a connection's scopes requires re-registering it with Claude Code, which needs
          its OAuth client secret again. Claude Code won't hand its copy back, so this app keeps its
          own encrypted with your operating system's key store and reuses it — you're asked for a
          secret at most once per connection.
        </Typography>

        {system && !system.encryptionAvailable && (
          <Alert severity="warning" sx={{ mt: 1.5, fontSize: 12.5 }}>
            OS-level encryption isn't available on this machine, so stored secrets would be kept in
            plain text. On Linux this usually means no keyring service (GNOME Keyring / KWallet) is
            running.
          </Alert>
        )}

        {system?.secretsCorrupted && (
          <Alert severity="warning" sx={{ mt: 1.5, fontSize: 12.5 }}>
            <ErrorDetail
              summary="Your stored secrets file appears unreadable — connections will ask for their
              client secret again when needed."
              detail={system.secretsError}
            />
          </Alert>
        )}

        {systemError && (
          <Alert severity="error" sx={{ mt: 1.5, fontSize: 12.5 }}>
            <ErrorDetail summary="Could not check this machine's security settings." detail={systemError} />
          </Alert>
        )}

        <Typography sx={{ fontSize: 12.5, fontWeight: 600, mt: 3, mb: 1 }}>
          Diagnostics
        </Typography>
        <Typography sx={{ fontSize: 12.5, color: brand.textSecondary, lineHeight: 1.55 }}>
          The app keeps a log of what it tried — which CLI it found, which
          configuration files it read, and anything that failed. Include it when
          reporting a problem.
        </Typography>
        <Button variant="outlined" onClick={revealLogs} sx={{ mt: 1.5 }}>
          Open logs folder
        </Button>

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button variant="contained" onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}
