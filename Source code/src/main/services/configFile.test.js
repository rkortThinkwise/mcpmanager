import { describe, expect, it } from 'vitest'
import { buildEntry, casingCheck, listProjects } from './configFile'

/**
 * buildEntry writes into ~/.claude.json, which Claude Code itself reads — so the
 * exact key names matter more than they look. Two of them have bitten this app
 * before and are asserted explicitly below.
 */
describe('buildEntry', () => {
  const base = {
    url: 'https://x.test/mcp',
    clientId: 'cid',
    callbackPort: 8080,
    metadataUrl: 'https://x.test/.well-known/openid-configuration'
  }

  it('writes `type`, not `transport`', () => {
    // A url with no `type` makes Claude Code skip the server entirely.
    const e = buildEntry({ ...base, scopes: ['a/b'] })
    expect(e.type).toBe('http')
    expect(e).not.toHaveProperty('transport')
  })

  it('joins scopes into a single space-separated string', () => {
    expect(buildEntry({ ...base, scopes: ['a/b', 'c/d'] }).oauth.scopes).toBe('a/b c/d')
  })

  it('OMITS the scopes key entirely when nothing is selected', () => {
    // Sending scopes: '' is rejected by the CLI with a generic
    // "Invalid configuration: : Invalid input", so an empty selection must not
    // produce the key at all.
    for (const empty of [[], '', null, undefined]) {
      const oauth = buildEntry({ ...base, scopes: empty }).oauth
      expect(oauth, JSON.stringify(empty)).not.toHaveProperty('scopes')
    }
  })

  it('coerces the callback port to a number', () => {
    // The wizard holds it as text; the CLI rejects a quoted port.
    const e = buildEntry({ ...base, callbackPort: '8080', scopes: ['a/b'] })
    expect(e.oauth.callbackPort).toBe(8080)
  })

  it('uses the key name Claude Code expects for the metadata URL', () => {
    expect(buildEntry({ ...base, scopes: ['a/b'] }).oauth.authServerMetadataUrl).toBe(
      base.metadataUrl
    )
  })
})

describe('listProjects', () => {
  it('returns the project keys, and copes with the key being absent', () => {
    expect(listProjects({ projects: { 'C:/a': {}, 'C:/b': {} } }).sort()).toEqual(['C:/a', 'C:/b'])
    expect(listProjects({})).toEqual([])
  })
})

/**
 * Windows lets the same directory appear under different casing and separators,
 * and Claude Code keys projects by the literal string it was given — so one
 * project can end up with two entries whose servers don't see each other.
 */
describe('casingCheck', () => {
  const config = {
    projects: {
      'C:/Users/me/Repo': {},
      'c:\\users\\me\\repo': {},
      'C:/Users/me/Other': {}
    }
  }

  it('spots keys that differ only by case or separator', () => {
    const res = casingCheck(config)
    expect(res.hasMismatch).toBe(true)
    expect(res.variants).toHaveLength(1)
    expect(res.variants[0].keys.sort()).toEqual(['C:/Users/me/Repo', 'c:\\users\\me\\repo'])
  })

  it('reports nothing when every project key is distinct', () => {
    expect(casingCheck({ projects: { 'C:/a': {}, 'C:/b': {} } }).hasMismatch).toBe(false)
  })

  it('narrows to the chosen project when one is given', () => {
    // The wizard only cares about the path the user picked.
    expect(casingCheck(config, 'C:/Users/me/Other').hasMismatch).toBe(false)
    expect(casingCheck(config, 'C:/Users/me/Repo').hasMismatch).toBe(true)
    // Matching is on the normalised form, so the other casing finds it too.
    expect(casingCheck(config, 'c:\\users\\me\\repo').hasMismatch).toBe(true)
  })

  it('ignores a trailing separator when comparing', () => {
    const withSlash = { projects: { 'C:/a': {}, 'C:/a/': {} } }
    expect(casingCheck(withSlash).hasMismatch).toBe(true)
  })
})
