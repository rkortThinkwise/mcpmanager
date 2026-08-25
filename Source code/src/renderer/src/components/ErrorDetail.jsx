import { useState } from 'react'
import { Box, Collapse, IconButton, Link, Tooltip, Typography } from '@mui/material'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import CheckIcon from '@mui/icons-material/Check'
import { brand } from '../theme'

/**
 * A short summary line plus an optional "Show details" toggle that expands
 * the full/raw error text in a monospace, scrollable, copyable block.
 *
 * Used wherever an error could be long or technical (raw CLI stderr, a JSON
 * parse error with position info, a multi-line CLI response) — everywhere
 * else a short, already-human-readable message is shown inline as before,
 * unwrapped.
 *
 * `detail` is optional: if it's missing, or identical to `summary`, there's
 * nothing extra to reveal, so no toggle renders at all.
 */
export default function ErrorDetail({ summary, detail, sx }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const hasDetail = Boolean(detail) && detail !== summary

  async function copy() {
    try {
      await navigator.clipboard.writeText(detail)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied by the OS; not worth its own error UI.
    }
  }

  return (
    <Box sx={sx}>
      <Typography sx={{ fontSize: 'inherit', color: 'inherit' }}>{summary}</Typography>
      {hasDetail && (
        <>
          <Link
            component="button"
            type="button"
            onClick={() => setOpen((v) => !v)}
            sx={{ fontSize: 12, display: 'block', mt: 0.5 }}
          >
            {open ? '− Hide details' : '+ Show details'}
          </Link>
          <Collapse in={open}>
            <Box
              sx={{
                position: 'relative',
                mt: 1,
                p: 1.25,
                pr: 4.5,
                maxHeight: 200,
                overflow: 'auto',
                bgcolor: brand.panelBg,
                border: `1px solid ${brand.border}`,
                borderRadius: 1
              }}
            >
              <Typography
                component="pre"
                sx={{
                  m: 0,
                  fontFamily: brand.mono,
                  fontSize: 11.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: brand.textSecondary
                }}
              >
                {detail}
              </Typography>
              <Tooltip title={copied ? 'Copied' : 'Copy to clipboard'}>
                <IconButton
                  size="small"
                  onClick={copy}
                  sx={{ position: 'absolute', top: 4, right: 4 }}
                  aria-label="Copy error details"
                >
                  {copied ? (
                    <CheckIcon sx={{ fontSize: 15, color: 'success.main' }} />
                  ) : (
                    <ContentCopyIcon sx={{ fontSize: 15 }} />
                  )}
                </IconButton>
              </Tooltip>
            </Box>
          </Collapse>
        </>
      )}
    </Box>
  )
}
