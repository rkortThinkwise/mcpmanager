import { describe, expect, it } from 'vitest'
import { parseMcpGetOutput } from './mcpGetOutput'

/**
 * Recorded verbatim from `claude mcp get` on CLI 2.1.202. Keeping real output
 * here is the point: this parser reads prose, so the only way to notice the CLI
 * changing shape is to pin down what it looked like when this was written.
 */
const CONNECTED = `meta_dev:
  Scope: User config (available in all your projects)
  Status: ✔ Connected
  Type: http
  URL: https://meta_dev.thinkwise.app/indicium/mcp
  OAuth: client_id configured, client_secret configured, callback_port 8080

To remove this server, run: claude mcp remove meta_dev -s user`

const NEEDS_AUTH = `some_server:
  Scope: User config (available in all your projects)
  Status: ! Needs authentication
  Type: http
  URL: https://example.test/mcp
  OAuth: client_id configured, client_secret configured, callback_port 8080`

const PUBLIC_CLIENT = `pkce_server:
  Scope: Local config
  Status: ✔ Connected
  Type: http
  URL: https://example.test/mcp
  OAuth: client_id configured, callback_port 8080`

describe('a connected server', () => {
  it('is recognised as authenticated with both credentials stored', () => {
    expect(parseMcpGetOutput(CONNECTED)).toMatchObject({
      authenticated: true,
      needsAuth: false,
      unrecognized: false,
      clientIdConfigured: true,
      clientSecretConfigured: true
    })
  })

  it('does not depend on the ✔ glyph surviving the console codepage', () => {
    // A non-UTF8 console can mangle the glyph; the words must carry the meaning.
    const mangled = CONNECTED.replace('✔', '?')
    expect(parseMcpGetOutput(mangled).authenticated).toBe(true)
  })

  it('tolerates CRLF line endings', () => {
    expect(parseMcpGetOutput(CONNECTED.split('\n').join('\r\n')).authenticated).toBe(true)
  })
})

describe('a server awaiting sign-in', () => {
  it('is not authenticated, and says so specifically', () => {
    expect(parseMcpGetOutput(NEEDS_AUTH)).toMatchObject({
      authenticated: false,
      needsAuth: true,
      unrecognized: false
    })
  })
})

describe('a public (PKCE) client', () => {
  it('reports no client secret without that meaning unauthenticated', () => {
    // Codex-style and public Claude clients legitimately have no secret; this
    // must not read as a broken registration.
    expect(parseMcpGetOutput(PUBLIC_CLIENT)).toMatchObject({
      authenticated: true,
      clientIdConfigured: true,
      clientSecretConfigured: false
    })
  })
})

describe('output this app does not understand', () => {
  // The important behaviour: refuse to guess. Reporting `authenticated: false`
  // for an unparseable response would show a healthy connection as broken the
  // day the CLI changes its wording.
  it('flags a shape with neither Status: nor OAuth:', () => {
    const changed = `some_server:\n  state: connected\n  transport: http`
    const res = parseMcpGetOutput(changed)
    expect(res.unrecognized).toBe(true)
    expect(res.authenticated).toBe(false)
  })

  it('flags empty output rather than calling it unauthenticated', () => {
    expect(parseMcpGetOutput('').unrecognized).toBe(true)
    expect(parseMcpGetOutput(undefined).unrecognized).toBe(true)
  })

  it('does not flag output that has only one of the two lines', () => {
    // One line is enough to read; only losing both means the shape changed.
    expect(parseMcpGetOutput('  Status: ✔ Connected').unrecognized).toBe(false)
    expect(parseMcpGetOutput('  OAuth: client_id configured').unrecognized).toBe(false)
  })
})
