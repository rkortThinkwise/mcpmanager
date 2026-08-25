import { describe, expect, it } from 'vitest'
import { optionalCliPath, launchId } from './validate'

// A fake stat: anything in `dirs` is a directory, anything in `files` is a file,
// everything else doesn't exist.
const stat = ({ files = [], dirs = [] } = {}) => (p) => {
  if (dirs.includes(p)) return { isDirectory: () => true }
  if (files.includes(p)) return { isDirectory: () => false }
  const e = new Error('ENOENT')
  e.code = 'ENOENT'
  throw e
}

describe('optionalCliPath', () => {
  const WIN = 'C:\\Users\\me\\.local\\bin\\claude.exe'
  const UNC = '\\\\fileserver\\tools\\claude.exe'
  const POSIX = '/usr/local/bin/claude'

  it('accepts an absolute Windows path', () => {
    // Regression: the absolute-path test once required a forward slash after
    // the drive letter, so every ordinary Windows path was rejected as
    // relative — which would have made this setting impossible to use.
    expect(optionalCliPath(WIN, { statSync: stat({ files: [WIN] }) })).toBe(WIN)
  })

  it('accepts a forward-slash Windows path, a UNC path and a POSIX path', () => {
    const fwd = 'C:/tools/claude.exe'
    expect(optionalCliPath(fwd, { statSync: stat({ files: [fwd] }) })).toBe(fwd)
    expect(optionalCliPath(UNC, { statSync: stat({ files: [UNC] }) })).toBe(UNC)
    expect(optionalCliPath(POSIX, { statSync: stat({ files: [POSIX] }) })).toBe(POSIX)
  })

  it('treats empty as "detect automatically" rather than an error', () => {
    // Clearing the field has to be allowed, or the override can't be undone.
    for (const empty of ['', null, undefined, '   ']) {
      expect(optionalCliPath(empty, { statSync: stat() })).toBeNull()
    }
  })

  it('strips quotes picked up from a copy-paste', () => {
    const quoted = `"${WIN}"`
    expect(optionalCliPath(quoted, { statSync: stat({ files: [WIN] }) })).toBe(WIN)
  })

  it('rejects a relative path with an actionable message', () => {
    expect(() => optionalCliPath('bin/claude', { statSync: stat() })).toThrow(/full path/i)
  })

  it('rejects a path that does not exist, naming it', () => {
    expect(() => optionalCliPath(WIN, { statSync: stat() })).toThrow(/no file at/i)
  })

  it('rejects a folder, since the CLI itself is what has to be named', () => {
    const dir = 'C:\\Users\\me\\.local\\bin'
    expect(() => optionalCliPath(dir, { statSync: stat({ dirs: [dir] }) })).toThrow(/folder/i)
  })

  it('rejects a non-string and an absurdly long value', () => {
    expect(() => optionalCliPath(42, { statSync: stat() })).toThrow()
    expect(() => optionalCliPath(`C:\\${'a'.repeat(5000)}`, { statSync: stat() })).toThrow(/too long/i)
  })
})

describe('launchId', () => {
  // The token stands in for filesystem paths that never cross IPC, so anything
  // that isn't exactly the generated shape has to be refused.
  it('accepts a 32-character hex token', () => {
    const id = 'a'.repeat(32)
    expect(launchId(id)).toBe(id)
  })

  it('rejects anything else, including path-shaped input', () => {
    for (const bad of ['', 'xyz', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), null, 7, '../../etc/passwd']) {
      expect(() => launchId(bad), String(bad)).toThrow()
    }
  })
})
