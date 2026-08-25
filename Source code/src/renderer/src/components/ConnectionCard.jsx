import { useState } from 'react'
import {
  Box,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Tooltip,
  Typography
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline'
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import StatusBadge, { StatusDot } from './StatusBadge'
import { brand } from '../theme'
import { formatLastVerified, pluralize } from '../format'

/**
 * One connection in the list. Scopes are deliberately not shown here — the card
 * carries a scope *count*, and the full list lives behind a click, in the
 * details modal (PLAN.md, "Connections list").
 *
 * Only the actions worth a glance at all times (refresh, reauthorize, enable)
 * stay as standalone icons. Rename, duplicate, disable and delete are less
 * frequent and one of them is destructive, so they're grouped behind a single
 * overflow menu instead of adding four more icons to every row.
 */
export default function ConnectionCard({
  connection,
  onOpen,
  onRefresh,
  onReauthorize,
  onToggle,
  onDuplicate,
  onRename,
  onDelete,
  enableErrors
}) {
  const c = connection
  const disabled = c.status === 'disabled'
  const enableError = enableErrors?.[c.id]
  // Sent by the main process whenever the periodic scope-drift check failed
  // for this connection (see connections.js's checkAllScopeDrift) — was
  // already on the connection object but never rendered anywhere. Only shown
  // when the status isn't already 'error': that's a more urgent problem and
  // stacking two warning indicators would just be noise.
  const showDriftError = Boolean(c.driftError) && c.status !== 'error'
  // Codex support is add + authorize + delete only for now (see
  // services/connections.js) — Codex's CLI has no rename/duplicate primitive
  // and no user-facing enable/disable, so those actions simply aren't offered.
  const isCodex = c.target === 'codex'
  const [menuAnchor, setMenuAnchor] = useState(null)

  // Each action button stops propagation so it doesn't also open the details
  // modal underneath it.
  const action = (fn) => (e) => {
    e.stopPropagation()
    fn(c)
  }

  const openMenu = (e) => {
    e.stopPropagation()
    setMenuAnchor(e.currentTarget)
  }
  const closeMenu = (e) => {
    e?.stopPropagation?.()
    setMenuAnchor(null)
  }
  // Same stop-propagation as the standalone icons, plus closing the menu
  // before the action's own modal opens.
  const menuAction = (fn) => (e) => {
    e.stopPropagation()
    setMenuAnchor(null)
    fn(c)
  }

  return (
    <Paper
      variant="outlined"
      onClick={() => onOpen(c)}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 2.25,
        py: 2,
        borderColor: brand.border,
        boxShadow: brand.shadow,
        cursor: 'pointer',
        transition: 'box-shadow .15s, border-color .15s',
        '&:hover': { borderColor: brand.lightBlue, boxShadow: brand.shadowHover }
      }}
    >
      {/* The identity dims when disabled so the list reads at a glance; the
          action buttons stay full-strength so Enable/Delete remain easy to hit. */}
      <Box sx={{ display: 'flex', opacity: disabled ? 0.5 : 1, flexShrink: 0 }}>
        <StatusDot status={c.status} />
      </Box>

      <Box sx={{ flex: 1, minWidth: 0, opacity: disabled ? 0.5 : 1 }}>
        {/* No scope badge here: the list groups by scope, so the section
            heading above the card already says which one this is. */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.125, flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: 14.5, fontWeight: 600 }}>{c.name}</Typography>
          <StatusBadge status={c.status} />
          {showDriftError && (
            <Tooltip title={`The last scope check failed: ${c.driftError}`}>
              <WarningAmberIcon sx={{ fontSize: 15, color: brand.warn }} />
            </Tooltip>
          )}
        </Box>

        <Typography
          sx={{
            fontSize: 12,
            color: brand.textSecondary,
            fontFamily: brand.mono,
            mt: '2px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {c.url}
        </Typography>

        <Typography sx={{ fontSize: 11.5, color: brand.textSecondary, mt: 1 }}>
          {pluralize(c.scopes.length, 'scope')} · Last verified: {formatLastVerified(c.lastVerified)}
          {/* Says when the drift status was last established, so a
              "Scope refresh needed" badge can be trusted or discounted. */}
          {c.scopesCheckedAt && ` · Scopes checked: ${formatLastVerified(c.scopesCheckedAt)}`}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', gap: 0.75, flexShrink: 0, alignItems: 'center' }}>
        {/* Refresh and reauthorize don't apply while a server is off, so a
            disabled card offers only Enable plus the overflow menu. */}
        {disabled ? (
          <Tooltip title={enableError ? `Could not enable: ${enableError} — click to retry` : 'Enable'}>
            <IconButton
              onClick={action(onToggle)}
              sx={enableError ? errorIconBtnSx : enableIconBtnSx}
            >
              <PlayArrowIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        ) : (
          <>
            {!isCodex && (
              <Tooltip title="Refresh scopes">
                <IconButton onClick={action(onRefresh)} sx={iconBtnSx}>
                  <RefreshIcon sx={{ fontSize: 17 }} />
                </IconButton>
              </Tooltip>
            )}
            {/* Only offered when it would actually do something: reauthorizing a
                connection that's already connected has no effect. */}
            {c.status === 'warn' && (
              <Tooltip title="Reauthorize">
                <IconButton onClick={action(onReauthorize)} sx={iconBtnSx}>
                  <VpnKeyOutlinedIcon sx={{ fontSize: 17 }} />
                </IconButton>
              </Tooltip>
            )}
          </>
        )}

        <Tooltip title="More">
          <IconButton onClick={openMenu} sx={iconBtnSx}>
            <MoreVertIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
        <Menu
          anchorEl={menuAnchor}
          open={Boolean(menuAnchor)}
          onClose={closeMenu}
          onClick={(e) => e.stopPropagation()}
        >
          {!isCodex && (
            <MenuItem onClick={menuAction(onRename)}>
              <ListItemIcon>
                <DriveFileRenameOutlineIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Rename</ListItemText>
            </MenuItem>
          )}
          {!isCodex && (
            <MenuItem onClick={menuAction(onDuplicate)}>
              <ListItemIcon>
                <ContentCopyIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Duplicate</ListItemText>
            </MenuItem>
          )}
          {/* Enabling has its own always-visible button above; only offer the
              toggle here for the direction that needs a confirmation. */}
          {!isCodex && !disabled && (
            <MenuItem onClick={menuAction(onToggle)}>
              <ListItemIcon>
                <PowerSettingsNewIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Disable</ListItemText>
            </MenuItem>
          )}
          <MenuItem onClick={menuAction(onDelete)} sx={{ color: brand.danger }}>
            <ListItemIcon sx={{ color: 'inherit' }}>
              <DeleteOutlineIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Delete</ListItemText>
          </MenuItem>
        </Menu>
      </Box>
    </Paper>
  )
}

const iconBtnSx = {
  width: 34,
  height: 34,
  borderRadius: 2,
  border: `1px solid ${brand.border}`,
  color: brand.textSecondary,
  '&:hover': { bgcolor: brand.hoverBg, color: brand.blue, borderColor: brand.blue }
}

// The Enable button carries a positive tint so it reads as the way back on,
// not just another neutral icon.
const enableIconBtnSx = {
  ...iconBtnSx,
  color: brand.success,
  borderColor: brand.success,
  '&:hover': { bgcolor: brand.successBg, color: brand.success, borderColor: brand.success }
}

// Swapped in for the Enable button when the last attempt failed (see
// `enableError` in App.jsx's `toggle`) — same button, same click handler
// (clicking it retries), but tinted to say "this didn't work" rather than
// failing with no visible trace at all.
const errorIconBtnSx = {
  ...iconBtnSx,
  color: brand.danger,
  borderColor: brand.danger,
  '&:hover': { bgcolor: brand.dangerBg, color: brand.danger, borderColor: brand.danger }
}
