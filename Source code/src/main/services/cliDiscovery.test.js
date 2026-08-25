import { describe, expect, it } from 'vitest'
import {
  classifyCandidate,
  compareSemver,
  comSpec,
  launchSpecFor,
  parseVersion,
  repairExtensionlessShim,
  sortVersionedDirs
} from './cliDiscovery'

/** A stand-in for fs.existsSync over a fixed set of paths. */
const existsIn = (paths) => (p) => new Set(paths).has(p)

describe('classifyCandidate', () => {
  it('recognises the Windows launch kinds, case-insensitively', () => {
    expect(classifyCandidate('C:\\x\\claude.exe', 'win32')).toBe('exe')
    expect(classifyCandidate('C:\\x\\claude.cmd', 'win32')).toBe('cmd')
    expect(classifyCandidate('C:\\x\\claude.CMD', 'win32')).toBe('cmd')
    expect(classifyCandidate('C:\\x\\claude.bat', 'win32')).toBe('cmd')
    expect(classifyCandidate('C:\\x\\claude.ps1', 'win32')).toBe('ps1')
  })

  it('calls an extensionless Windows path a shim', () => {
    // This is what `where claude` returns first for a global npm install.
    expect(classifyCandidate('C:\\Users\\me\\AppData\\Roaming\\npm\\claude', 'win32')).toBe('shim')
  })

  it('treats every POSIX path as directly executable', () => {
    expect(classifyCandidate('/usr/local/bin/claude', 'linux')).toBe('posix')
    expect(classifyCandidate('/usr/local/bin/claude', 'darwin')).toBe('posix')
  })
})

describe('repairExtensionlessShim', () => {
  // The regression this whole change exists for: `npm install -g
  // @anthropic-ai/claude-code` writes claude, claude.cmd and claude.ps1 side by
  // side, and `where` returns the extensionless Bourne script first. Neither
  // execFile nor cmd.exe can run it.
  it('repairs the npm layout to the .cmd shim', () => {
    const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude'
    const exists = existsIn([npm, `${npm}.cmd`, `${npm}.ps1`])
    expect(repairExtensionlessShim(npm, exists)).toBe(`${npm}.cmd`)
  })

  it('prefers a real executable over a batch shim', () => {
    const base = 'C:\\tools\\claude'
    const exists = existsIn([base, `${base}.cmd`, `${base}.exe`])
    expect(repairExtensionlessShim(base, exists)).toBe(`${base}.exe`)
  })

  it('prefers .cmd over .ps1, so the strict PowerShell path stays unreachable', () => {
    const base = 'C:\\tools\\claude'
    const exists = existsIn([base, `${base}.ps1`, `${base}.cmd`])
    expect(repairExtensionlessShim(base, exists)).toBe(`${base}.cmd`)
  })

  it('returns null when the shim stands alone', () => {
    // Better to drop the candidate than cache something that can never run.
    const base = 'C:\\tools\\claude'
    expect(repairExtensionlessShim(base, existsIn([base]))).toBeNull()
  })
})

describe('launchSpecFor', () => {
  const env = { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }

  it('runs an .exe directly', () => {
    const spec = launchSpecFor('C:\\x\\claude.exe', 'win32', env)
    expect(spec).toEqual({ file: 'C:\\x\\claude.exe', prefix: [], kind: 'exe' })
  })

  it('routes a .cmd through cmd.exe', () => {
    const spec = launchSpecFor('C:\\x\\claude.cmd', 'win32', env)
    expect(spec.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(spec.prefix).toEqual(['/c', 'C:\\x\\claude.cmd'])
  })

  it('neutralises profile and execution policy on the .ps1 route', () => {
    // npm's PowerShell shim would otherwise be blocked by the default
    // Restricted execution policy on a stock machine.
    const spec = launchSpecFor('C:\\x\\claude.ps1', 'win32', env)
    expect(spec.prefix).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\x\\claude.ps1'
    ])
  })

  it('runs POSIX binaries directly', () => {
    expect(launchSpecFor('/usr/local/bin/claude', 'linux', {}).prefix).toEqual([])
  })
})

describe('comSpec', () => {
  it('prefers ComSpec but never falls back to a bare PATH lookup', () => {
    expect(comSpec({ ComSpec: 'D:\\cmd.exe' })).toBe('D:\\cmd.exe')
    // A bare "cmd.exe" would be resolvable via PATH, which is exactly the
    // hijack this avoids.
    expect(comSpec({ SystemRoot: 'C:\\Windows' })).toContain('System32')
  })
})

describe('parseVersion', () => {
  it('handles both CLIs, which put the number in different places', () => {
    expect(parseVersion('2.1.202 (Claude Code)')).toBe('2.1.202')
    expect(parseVersion('codex-cli 0.146.0')).toBe('0.146.0')
  })

  it('reads only the first line', () => {
    expect(parseVersion('2.1.202 (Claude Code)\nsomething 9.9.9')).toBe('2.1.202')
  })

  it('returns null when there is nothing version-shaped', () => {
    // A null version is how a broken candidate is recognised, so this must not
    // fall back to returning the first token as the old code did.
    expect(parseVersion('claude')).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion(undefined)).toBeNull()
  })
})

describe('compareSemver / sortVersionedDirs', () => {
  it('compares numerically, not lexicographically', () => {
    expect(compareSemver('1.0.10', '1.0.9')).toBe(1)
    expect(compareSemver('2.0.0', '10.0.0')).toBe(-1)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })

  it('sorts VS Code extension directories newest-first', () => {
    // readdirSync order would put 1.0.9 above 1.0.10 and hand back an older
    // bundled binary than the one actually installed.
    const dirs = [
      'anthropic.claude-code-1.0.9',
      'anthropic.claude-code-1.0.10',
      'ms-python.python-2024.1.0'
    ]
    expect(sortVersionedDirs(dirs, 'anthropic.claude-code-')).toEqual([
      'anthropic.claude-code-1.0.10',
      'anthropic.claude-code-1.0.9'
    ])
  })
})
