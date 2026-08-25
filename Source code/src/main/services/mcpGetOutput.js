/**
 * Parse the text `claude mcp get <name>` prints.
 *
 * Pure and on its own so it can be tested against recorded CLI output: this is
 * the most version-fragile thing in the app. The CLI has no --json for `mcp
 * get`, so a connection's authorization state is read out of prose that could
 * change shape in any release — and the app's whole status column depends on it.
 *
 * Note the matching is on words (`Status:`, `needs authentication`), never on
 * the ✔/✘/! glyphs the CLI decorates them with, so a console codepage that
 * mangles those still parses correctly.
 */
export function parseMcpGetOutput(raw) {
  const text = String(raw || '')
  const lines = text.split(/\r?\n/)
  const oauthLine = (lines.find((l) => l.trim().startsWith('OAuth:')) || '').trim()
  const statusLine = (lines.find((l) => l.trim().startsWith('Status:')) || '').trim()

  // The CLI reports "! Needs authentication" until the OAuth flow completes;
  // anything else (e.g. "✔ Connected") means we're signed in.
  const needsAuth = /needs authentication/i.test(statusLine)

  // Neither line present, on an otherwise successful call, means the output
  // shape changed — every version this app has run against produces at least
  // one of the two. Falling through to `authenticated: false` would report a
  // perfectly healthy connection as unauthorized, so flag it distinctly and let
  // deriveStatus say "couldn't understand the response" instead of guessing.
  const unrecognized = !oauthLine && !statusLine

  return {
    oauthLine,
    statusLine,
    needsAuth,
    unrecognized,
    authenticated: statusLine.length > 0 && !needsAuth,
    clientIdConfigured: /client_id configured/.test(oauthLine),
    clientSecretConfigured: /client_secret configured/.test(oauthLine)
  }
}
