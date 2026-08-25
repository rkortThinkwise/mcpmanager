import { useEffect, useState } from 'react'
import { Box, InputAdornment, IconButton, TextField, Typography } from '@mui/material'
import Visibility from '@mui/icons-material/Visibility'
import VisibilityOff from '@mui/icons-material/VisibilityOff'
import { useWizard, isValidUrl, isValidPort, isValidServerName } from '../../state/WizardContext'
import SelectableCard from '../../components/SelectableCard'
import { brand } from '../../theme'

// A titled box grouping related fields, so the form reads as three distinct
// concerns rather than one long column.
function FieldGroup({ title, caption, children }) {
  return (
    <Box sx={{ mb: 2.5 }}>
      <Typography
        sx={{
          fontSize: 11.5,
          fontWeight: 700,
          color: brand.textSecondary,
          textTransform: 'uppercase',
          letterSpacing: 0.7,
          mb: 1
        }}
      >
        {title}
      </Typography>
      <Box
        sx={{
          border: `1px solid ${brand.border}`,
          borderRadius: 2,
          bgcolor: brand.panelBg,
          p: 2,
          display: 'flex',
          flexDirection: 'column',
          gap: 2.25
        }}
      >
        {caption && (
          <Typography sx={{ fontSize: 12, color: brand.textSecondary, mt: -0.5 }}>
            {caption}
          </Typography>
        )}
        {children}
      </Box>
    </Box>
  )
}

export default function StepServerDetails() {
  const { state, update, endpoints } = useWizard()
  const { server, targets } = state
  const wantsClaude = targets.claude
  const wantsCodex = targets.codex
  const [showSecret, setShowSecret] = useState(false)
  const [touched, setTouched] = useState({})

  const set = (field) => (e) => update('server', { [field]: e.target.value })
  const blur = (field) => () => setTouched((t) => ({ ...t, [field]: true }))

  // Every field is mandatory. The name additionally has to satisfy the rule the
  // main process enforces before it reaches a command line, so an unusable name
  // is caught here rather than at the write step.
  const nameEmpty = server.name.trim().length === 0
  const nameValid = isValidServerName(server.name.trim())
  const urlValid = isValidUrl(server.baseUrl)
  const clientIdValid = server.clientId.trim().length > 0
  // Codex is always a public (PKCE) client — see services/codexCli.js — so
  // the confidential/public choice below only ever governs Claude Code's own
  // registration, and only matters at all when Claude Code is a target.
  const isPublic = !wantsClaude || server.clientType === 'public'
  const secretValid = isPublic || server.secret.length > 0
  const portValid = isValidPort(server.callbackPort)

  const setClientType = (clientType) => update('server', { clientType })

  // Show a required-field error only once the user has left the field empty.
  const emptyError = (field, valid) => touched[field] && !valid

  // As soon as the URL is well-formed, check that Indicium actually resolves
  // and its OAuth well-known configuration is accessible — the same probe
  // step 3 later runs as a hard gate, surfaced here early so a typo or an
  // unreachable server is caught before the user fills in the rest of the
  // form. This is informational only: it doesn't block Next, since step 3
  // re-checks and gates on it for real.
  const [wellKnownCheck, setWellKnownCheck] = useState('idle') // idle | checking | ok | error
  const [wellKnownMessage, setWellKnownMessage] = useState('')
  useEffect(() => {
    setWellKnownCheck('idle')
    setWellKnownMessage('')
    if (!urlValid) return
    let cancelled = false
    const timer = setTimeout(async () => {
      setWellKnownCheck('checking')
      try {
        const meta = await window.api.connectivity.metadata(endpoints.baseUrl)
        if (cancelled) return
        if (meta.ok) {
          setWellKnownCheck('ok')
          setWellKnownMessage('Indicium resolved and its OAuth configuration is accessible.')
        } else {
          setWellKnownCheck('error')
          setWellKnownMessage(meta.message || 'Could not read the well-known OAuth configuration.')
        }
      } catch (e) {
        if (!cancelled) {
          setWellKnownCheck('error')
          setWellKnownMessage(e.message)
        }
      }
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [urlValid, endpoints.baseUrl])

  return (
    <Box>
      <FieldGroup title="MCP server">
        <TextField
          label="MCP server name"
          value={server.name}
          onChange={set('name')}
          onBlur={blur('name')}
          error={emptyError('name', nameValid) || (!nameEmpty && !nameValid)}
          helperText={
            touched.name && nameEmpty
              ? 'An MCP server name is required.'
              : !nameEmpty && !nameValid
                ? 'Use letters, digits, spaces, dot, dash or underscore only, starting with a ' +
                  'letter or digit (max 64 characters).'
                : 'The name this server appears under in /mcp.'
          }
          size="small"
          fullWidth
        />
        <Box>
          <TextField
            label="Indicium base URL"
            value={server.baseUrl}
            onChange={set('baseUrl')}
            onBlur={blur('baseUrl')}
            error={
              emptyError('baseUrl', urlValid) ||
              (server.baseUrl.length > 0 && !urlValid) ||
              wellKnownCheck === 'error'
            }
            helperText={
              server.baseUrl.length === 0 && touched.baseUrl
                ? 'An Indicium base URL is required.'
                : server.baseUrl.length > 0 && !urlValid
                  ? 'Enter a valid http(s) URL.'
                  : wellKnownCheck === 'checking'
                    ? 'Checking that Indicium resolves and its OAuth configuration is accessible…'
                    : wellKnownCheck === 'ok' || wellKnownCheck === 'error'
                      ? wellKnownMessage
                      : 'The MCP and OAuth endpoints are added automatically.'
            }
            FormHelperTextProps={{
              sx: { color: wellKnownCheck === 'ok' ? brand.success : undefined }
            }}
            size="small"
            fullWidth
          />
          {urlValid && (
            <Box
              sx={{
                mt: 1,
                px: 1.5,
                py: 1.25,
                border: `1px solid ${brand.border}`,
                borderRadius: 1.5,
                bgcolor: '#F5F7FA'
              }}
            >
              <Typography sx={{ fontSize: 11.5, color: brand.textSecondary, mb: 0.25 }}>
                Derived endpoints
              </Typography>
              <Typography sx={{ fontSize: 12, fontFamily: brand.mono, wordBreak: 'break-all' }}>
                MCP server&nbsp;&nbsp;&nbsp;&nbsp;{endpoints.mcpUrl}
              </Typography>
              <Typography sx={{ fontSize: 12, fontFamily: brand.mono, wordBreak: 'break-all' }}>
                OAuth metadata&nbsp;&nbsp;{endpoints.metadataUrl}
              </Typography>
            </Box>
          )}
        </Box>
      </FieldGroup>

      <FieldGroup
        title="OAuth client"
        caption="The credentials of the OAuth client registered in Indicium."
      >
        {wantsClaude && (
          <Box sx={{ display: 'flex', gap: 1.5 }}>
            <SelectableCard
              selected={server.clientType !== 'public'}
              title="Confidential client"
              desc="Authenticates with a client ID and secret."
              onClick={() => setClientType('confidential')}
            />
            <SelectableCard
              selected={server.clientType === 'public'}
              title="Public client"
              desc="Authenticates with a client ID only (PKCE), no secret."
              onClick={() => setClientType('public')}
            />
          </Box>
        )}
        <TextField
          label="Client ID"
          value={server.clientId}
          onChange={set('clientId')}
          onBlur={blur('clientId')}
          error={emptyError('clientId', clientIdValid)}
          helperText={
            emptyError('clientId', clientIdValid)
              ? 'A client ID is required.'
              : !wantsClaude
                ? 'Registered as a public (PKCE) OAuth client — Codex never uses a client secret.'
                : ' '
          }
          size="small"
          fullWidth
        />
        {!wantsClaude ? (
          <Typography sx={{ fontSize: 12, color: brand.textSecondary }}>
            No secret — Codex always authenticates with PKCE using only the Client ID above.
          </Typography>
        ) : isPublic ? (
          <Typography sx={{ fontSize: 12, color: brand.textSecondary }}>
            No secret — this client authenticates with PKCE using only the Client ID above.
            {wantsCodex && ' Codex always uses PKCE regardless of this setting.'}
          </Typography>
        ) : (
          <>
            <TextField
              label="Client secret"
              type={showSecret ? 'text' : 'password'}
              value={server.secret}
              onChange={set('secret')}
              onBlur={blur('secret')}
              error={emptyError('secret', secretValid)}
              helperText={
                emptyError('secret', secretValid)
                  ? 'A client secret is required.'
                  : 'Stored in your OS keychain by Claude Code, never in the config file.'
              }
              size="small"
              fullWidth
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label={showSecret ? 'Hide client secret' : 'Show client secret'}
                      onClick={() => setShowSecret((s) => !s)}
                      edge="end"
                      size="small"
                    >
                      {showSecret ? (
                        <VisibilityOff fontSize="small" />
                      ) : (
                        <Visibility fontSize="small" />
                      )}
                    </IconButton>
                  </InputAdornment>
                )
              }}
            />
            {wantsCodex && (
              <Typography sx={{ fontSize: 12, color: brand.textSecondary, mt: -1.5 }}>
                Codex ignores this — it always uses PKCE with only the Client ID above.
              </Typography>
            )}
          </>
        )}
      </FieldGroup>

      {wantsClaude && (
        <FieldGroup
          title="OAuth callback"
          caption="Must match the redirect URI registered for this client, in the form http://localhost:PORT/callback."
        >
          <TextField
            label="Callback port"
            value={server.callbackPort}
            onChange={set('callbackPort')}
            onBlur={blur('callbackPort')}
            error={!portValid}
            helperText={
              server.callbackPort.length === 0
                ? 'A callback port is required.'
                : !portValid
                  ? 'Port must be between 1 and 65535.'
                  : `Redirect URI: http://localhost:${server.callbackPort}/callback`
            }
            size="small"
            sx={{ maxWidth: 260 }}
          />
        </FieldGroup>
      )}
    </Box>
  )
}
