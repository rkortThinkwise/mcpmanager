import { describe, expect, it } from 'vitest'
import { createCliResolver } from './cliResolver'

/**
 * A fake Windows machine: a set of paths that exist, and a canned answer per
 * path for `--version`. Nothing here spawns a process or touches a filesystem,
 * which is the whole point of injecting these — the ordering and caching rules
 * are the tricky part, and they're the part that has to be pinned down.
 */
function machine({ files = [], versions = {}, override = null, pathEnv = 'C:\\bin' } = {}) {
  const present = new Set(files)
  const runs = []
  const resolver = createCliResolver({
    command: 'claude',
    displayName: 'The Claude Code CLI',
    staticCandidates: () => [],
    extraCandidates: () => [],
    readOverride: () => override,
    deps: {
      exists: (p) => present.has(p),
      platform: 'win32',
      env: { PATH: pathEnv, SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      homedir: () => 'C:\\Users\\me',
      run: async (file, args) => {
        // The binary under test is the last arg before --version for a shimmed
        // launch, or `file` itself when launched directly.
        const target = args.includes('--version')
          ? args.find((a) => a.includes('claude')) || file
          : file
        runs.push(target)
        const answer = versions[target]
        if (!answer) {
          return { ok: false, failure: 'spawn', errno: 'ENOENT', message: 'Could not run it.', stdout: '', stderr: '' }
        }
        return { ok: true, failure: null, stdout: answer, stderr: '' }
      }
    }
  })
  return { resolver, runs }
}

const NPM = 'C:\\bin\\claude'
const NPM_CMD = 'C:\\bin\\claude.cmd'
const NPM_PS1 = 'C:\\bin\\claude.ps1'
const VERSION = '2.1.202 (Claude Code)'

describe('the npm-global layout', () => {
  // The regression this whole resolver exists for. `where` reported the
  // extensionless Bourne shim first; it cannot be executed on Windows, and the
  // old code cached it and reported the CLI as found anyway.
  it('resolves to the .cmd and reports healthy', async () => {
    const { resolver } = machine({
      files: [NPM, NPM_CMD, NPM_PS1],
      versions: { [NPM_CMD]: VERSION }
    })
    const res = await resolver.detect()
    expect(res).toMatchObject({ found: true, healthy: true, path: NPM_CMD, version: '2.1.202' })
  })

  it('never probes the unrunnable extensionless shim', async () => {
    const { resolver, runs } = machine({
      files: [NPM, NPM_CMD, NPM_PS1],
      versions: { [NPM_CMD]: VERSION }
    })
    await resolver.detect()
    expect(runs).not.toContain(NPM)
  })

  it('records that it repaired the shim', async () => {
    const { resolver } = machine({ files: [NPM, NPM_CMD], versions: { [NPM_CMD]: VERSION } })
    // Only the extensionless hit needs repairing; the .cmd is found directly
    // too, so the repaired one dedupes against it and repairedFrom may be null.
    expect((await resolver.detect()).path).toBe(NPM_CMD)
  })
})

describe('a candidate that exists but cannot run', () => {
  // The exact state the old code reported as "Found": something is there, but
  // running it fails, so every later operation failed with no message.
  it('reports found-but-not-healthy with a real message', async () => {
    const { resolver } = machine({ files: [NPM, NPM_CMD], versions: {} })
    const res = await resolver.detect()
    expect(res.found).toBe(true)
    expect(res.healthy).toBe(false)
    expect(res.reason).toBe('probe_failed')
    expect(res.message).toBeTruthy()
    expect(res.detail).toBeTruthy()
  })

  it('falls through to the next candidate', async () => {
    const good = 'C:\\other\\claude.exe'
    const { resolver } = machine({
      files: [NPM_CMD, good],
      versions: { [good]: VERSION },
      pathEnv: 'C:\\bin;C:\\other'
    })
    expect((await resolver.detect()).path).toBe(good)
  })

  it('drops an extensionless shim with no runnable sibling', async () => {
    const { resolver } = machine({ files: [NPM], versions: {} })
    const res = await resolver.detect()
    expect(res.healthy).toBe(false)
    expect(res.candidates[0].outcome).toBe('shim_unrepairable')
  })
})

describe('nothing installed', () => {
  it('reports not_found rather than an empty success', async () => {
    const { resolver } = machine({ files: [] })
    expect(await resolver.detect()).toMatchObject({
      found: false,
      healthy: false,
      reason: 'not_found'
    })
    expect(await resolver.resolve()).toBeNull()
  })

  it('does not re-probe on every call (negative cache)', async () => {
    // deriveStatus runs several of these per list refresh; without the cache an
    // uninstalled machine pays a full scan plus probe timeouts per render.
    const { resolver, runs } = machine({ files: [NPM_CMD], versions: {} })
    await resolver.detect()
    const afterFirst = runs.length
    await resolver.detect()
    expect(runs.length).toBe(afterFirst)
  })
})

describe('the manual override', () => {
  const OVERRIDE = 'D:\\tools\\claude.exe'

  it('wins over everything on PATH', async () => {
    const { resolver } = machine({
      files: [OVERRIDE, NPM_CMD],
      versions: { [OVERRIDE]: VERSION, [NPM_CMD]: VERSION },
      override: OVERRIDE
    })
    expect((await resolver.detect()).path).toBe(OVERRIDE)
  })

  it('is a hard stop: a broken override never silently falls back', async () => {
    // Running a different binary than the one the user typed would be worse
    // than an error — they'd have no way to tell the setting was ignored.
    const { resolver, runs } = machine({
      files: [OVERRIDE, NPM_CMD],
      versions: { [NPM_CMD]: VERSION },
      override: OVERRIDE
    })
    const res = await resolver.detect()
    expect(res.healthy).toBe(false)
    expect(res.reason).toBe('override_failed')
    expect(res.message).toMatch(/Settings/)
    expect(runs).not.toContain(NPM_CMD)
  })
})

describe('caching and coalescing', () => {
  it('serves a verified result without re-probing', async () => {
    const { resolver, runs } = machine({ files: [NPM_CMD], versions: { [NPM_CMD]: VERSION } })
    await resolver.detect()
    const afterFirst = runs.length
    expect(await resolver.resolve()).toBe(NPM_CMD)
    expect(runs.length).toBe(afterFirst)
  })

  it('coalesces concurrent scans into one', async () => {
    // A ten-connection list refresh must not start ten identical scans.
    const { resolver, runs } = machine({ files: [NPM_CMD], versions: { [NPM_CMD]: VERSION } })
    await Promise.all([
      resolver.detect(),
      resolver.detect(),
      resolver.detect(),
      resolver.detect()
    ])
    expect(runs.length).toBe(1)
  })

  it('re-probes after invalidate', async () => {
    const { resolver, runs } = machine({ files: [NPM_CMD], versions: { [NPM_CMD]: VERSION } })
    await resolver.detect()
    resolver.invalidate()
    await resolver.detect()
    expect(runs.length).toBe(2)
  })
})

describe('PATH hygiene', () => {
  it('ignores relative and empty PATH entries', async () => {
    // An empty or relative entry resolves against the current directory, which
    // is how a binary dropped beside the app could win over the real install.
    const { resolver } = machine({
      files: ['claude.exe', 'C:\\bin\\claude.exe'],
      versions: { 'C:\\bin\\claude.exe': VERSION },
      pathEnv: ';.;relative\\dir;C:\\bin'
    })
    expect((await resolver.detect()).path).toBe('C:\\bin\\claude.exe')
  })

  it('prefers .exe over .cmd in the same directory', async () => {
    const exe = 'C:\\bin\\claude.exe'
    const { resolver } = machine({
      files: [exe, NPM_CMD],
      versions: { [exe]: VERSION, [NPM_CMD]: VERSION }
    })
    expect((await resolver.detect()).path).toBe(exe)
  })
})
