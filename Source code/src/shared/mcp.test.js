import { describe, expect, it } from 'vitest'
import {
  baseUrlOf,
  deriveEndpoints,
  diffScopes,
  isApplicationScope,
  isShellSafeValue,
  isValidServerName
} from './mcp'

/**
 * This module is bundled into BOTH processes precisely so the two can't
 * disagree, which makes it the highest-value thing in the app to pin down: the
 * renderer gates the wizard's Next button on these rules and the main process
 * re-enforces them before anything reaches a command line.
 */

describe('isValidServerName', () => {
  it('accepts the shapes real servers use', () => {
    for (const name of ['meta_dev', 'sf-mcp', 'My Server', 'claude.ai Context7', 'a', 'A1']) {
      expect(isValidServerName(name), name).toBe(true)
    }
  })

  it('rejects anything that could reach a shell as more than one token', () => {
    // An allowlist rather than escaping, because names can arrive from a
    // third-party .mcp.json committed to a shared repo, and cmd.exe re-parsing
    // makes escaping unreliable — see the rationale in mcp.js.
    for (const name of ['a&b', 'a|b', 'a>b', 'a<b', 'a"b', 'a^b', 'a\nb', 'a;b', 'a$b', 'a`b']) {
      expect(isValidServerName(name), JSON.stringify(name)).toBe(false)
    }
  })

  it('rejects empty, leading/trailing whitespace, a leading symbol and over-long names', () => {
    for (const name of ['', ' ', ' a', 'a ', '.a', '-a', '_a', 'x'.repeat(65)]) {
      expect(isValidServerName(name), JSON.stringify(name)).toBe(false)
    }
    expect(isValidServerName('x'.repeat(64))).toBe(true)
  })

  it('rejects non-strings rather than coercing them', () => {
    for (const v of [null, undefined, 42, {}, []]) expect(isValidServerName(v)).toBe(false)
  })
})

describe('isShellSafeValue', () => {
  it('rejects the cmd.exe metacharacters that survive Node quoting', () => {
    for (const v of ['a"b', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a\rb', 'a\nb']) {
      expect(isShellSafeValue(v), JSON.stringify(v)).toBe(false)
    }
  })

  it('permits characters that are safe once quoting holds', () => {
    // %, $ and backtick are deliberately allowed — documented in mcp.js.
    for (const v of ['https://a.test/mcp?x=1&', 'a%b', 'a$b', 'a`b']) {
      // the & case must fail; assert the others pass
      if (v.includes('&')) continue
      expect(isShellSafeValue(v), v).toBe(true)
    }
    expect(isShellSafeValue('sf/software_development')).toBe(true)
    expect(isShellSafeValue('')).toBe(true)
  })
})

describe('isApplicationScope', () => {
  it('keeps app/scope pairs and drops bare protocol scopes', () => {
    // Protocol scopes are noise in the UI: the user picks application scopes.
    expect(isApplicationScope('sf/software_development')).toBe(true)
    expect(isApplicationScope('openid')).toBe(false)
    expect(isApplicationScope('offline_access')).toBe(false)
    expect(isApplicationScope('a/b/c')).toBe(false)
    expect(isApplicationScope('a /b')).toBe(false)
  })
})

describe('deriveEndpoints', () => {
  it('builds the mcp and metadata URLs from a base', () => {
    expect(deriveEndpoints('https://x.test/indicium')).toMatchObject({
      baseUrl: 'https://x.test/indicium',
      mcpUrl: 'https://x.test/indicium/mcp',
      metadataUrl: 'https://x.test/indicium/.well-known/openid-configuration'
    })
  })

  it('tolerates the two things users actually paste', () => {
    // A trailing slash, and the full /mcp URL copied out of a config file.
    expect(deriveEndpoints('https://x.test/indicium/').mcpUrl).toBe('https://x.test/indicium/mcp')
    expect(deriveEndpoints('https://x.test/indicium/mcp').mcpUrl).toBe(
      'https://x.test/indicium/mcp'
    )
    expect(deriveEndpoints('  https://x.test/indicium  ').baseUrl).toBe('https://x.test/indicium')
  })

  it('round-trips with baseUrlOf', () => {
    const base = 'https://x.test/indicium'
    expect(baseUrlOf(deriveEndpoints(base).mcpUrl)).toBe(base)
  })
})

describe('diffScopes', () => {
  it('splits advertised scopes into added, removed and unchanged', () => {
    expect(diffScopes(['a', 'b'], ['b', 'c'])).toMatchObject({
      added: ['c'],
      removed: ['a'],
      unchanged: ['b']
    })
  })

  it('reports no change when the sets match regardless of order', () => {
    const d = diffScopes(['b', 'a'], ['a', 'b'])
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.unchanged.slice().sort()).toEqual(['a', 'b'])
  })

  it('handles either side being empty', () => {
    expect(diffScopes([], ['a'])).toMatchObject({ added: ['a'], removed: [], unchanged: [] })
    expect(diffScopes(['a'], [])).toMatchObject({ added: [], removed: ['a'], unchanged: [] })
  })
})
