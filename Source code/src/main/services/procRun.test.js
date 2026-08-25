import { describe, expect, it } from 'vitest'
import { classifyRunFailure, cliError, describeRunFailure, run } from './procRun'

/**
 * Node's execFile reports these five failures in five different shapes, and the
 * previous implementation flattened all of them to `{ code: 1 }`. These are
 * synthetic versions of the real errors — the only practical way to cover them
 * without arranging four separately broken machines.
 */
const spawnEnoent = Object.assign(new Error('spawn C:\\npm\\claude ENOENT'), {
  code: 'ENOENT',
  syscall: 'spawn C:\\npm\\claude'
})
const spawnEacces = Object.assign(new Error('spawn EACCES'), {
  code: 'EACCES',
  syscall: 'spawn /usr/local/bin/claude'
})
const timedOut = Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' })
const overflow = Object.assign(new Error('stdout maxBuffer length exceeded'), {
  code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
})
const nonZeroExit = Object.assign(new Error('Command failed'), { code: 2 })

describe('classifyRunFailure', () => {
  it('reports no failure for a clean run', () => {
    expect(classifyRunFailure(null)).toMatchObject({ failure: null, code: 0 })
  })

  it('distinguishes a failed spawn and carries the errno', () => {
    // This is the case that made a global npm install look healthy: the binary
    // could not be launched at all, and the old code called it exit code 1.
    const r = classifyRunFailure(spawnEnoent)
    expect(r.failure).toBe('spawn')
    expect(r.errno).toBe('ENOENT')
    expect(classifyRunFailure(spawnEacces)).toMatchObject({ failure: 'spawn', errno: 'EACCES' })
  })

  it('keeps a spawn failure truthy for existing `code !== 0` call sites', () => {
    // Every caller predates this change and tests `res.code !== 0`; -1 keeps
    // them working while still being distinguishable from a real exit code.
    const r = classifyRunFailure(spawnEnoent)
    expect(r.code).not.toBe(0)
    expect(r.code).toBe(-1)
  })

  it('separates a timeout kill from a plain non-zero exit', () => {
    expect(classifyRunFailure(timedOut, { elapsedMs: 20000, timeoutMs: 20000 })).toMatchObject({
      failure: 'timeout',
      signal: 'SIGTERM'
    })
    expect(classifyRunFailure(nonZeroExit)).toMatchObject({ failure: 'exit', code: 2 })
  })

  it('flags an output overflow as truncated rather than as an exit code', () => {
    expect(classifyRunFailure(overflow)).toMatchObject({ failure: 'maxBuffer', truncated: true })
  })

  it('preserves a real exit code', () => {
    expect(classifyRunFailure({ code: 127 }).code).toBe(127)
  })
})

describe('describeRunFailure', () => {
  it('says nothing when nothing failed', () => {
    expect(describeRunFailure({ failure: null })).toBeNull()
  })

  // The guarantee that stops an empty error message reaching the UI: a new
  // failure kind cannot be added without also giving it a sentence.
  it('produces a non-empty sentence for every failure kind', () => {
    for (const failure of ['spawn', 'timeout', 'maxBuffer', 'signal', 'exit']) {
      const msg = describeRunFailure({
        failure,
        file: 'claude',
        errno: 'ENOENT',
        signal: 'SIGKILL',
        code: 1,
        timeoutMs: 20000,
        stdout: '',
        stderr: ''
      })
      expect(msg, `failure=${failure}`).toBeTruthy()
      expect(msg.length, `failure=${failure}`).toBeGreaterThan(10)
    }
  })

  it('explains ENOENT in terms a user can act on', () => {
    const msg = describeRunFailure({ failure: 'spawn', errno: 'ENOENT', file: 'claude' })
    expect(msg).toMatch(/could not be started|moved or removed/i)
  })

  it('prefers the CLI\u2019s own words when it exited cleanly with a complaint', () => {
    const msg = describeRunFailure({ failure: 'exit', code: 1, stderr: 'No such server: foo' })
    expect(msg).toBe('No such server: foo')
  })
})

describe('cliError', () => {
  it('never builds an empty message from an empty failed spawn', () => {
    // The exact shape behind the original bug: stdout and stderr are both
    // empty, so `stderr || stdout || fallback` produced nothing useful.
    const res = {
      failure: 'spawn',
      errno: 'ENOENT',
      file: 'C:\\npm\\claude',
      stdout: '',
      stderr: '',
      message: describeRunFailure({ failure: 'spawn', errno: 'ENOENT', file: 'C:\\npm\\claude' })
    }
    const err = cliError(res, 'Could not register the connection')
    expect(err.message).toContain('Could not register the connection')
    expect(err.message).toMatch(/ENOENT|could not be started/i)
    expect(err.cliFailure).toBe('spawn')
  })

  it('surfaces the CLI output as detail when it did run', () => {
    const err = cliError(
      { failure: 'exit', code: 1, stdout: '', stderr: 'boom', message: 'boom' },
      'Failed'
    )
    expect(err.detail).toBe('boom')
  })
})

describe('run', () => {
  it('resolves rather than rejecting when the spawn fails', async () => {
    const res = await run('claude', ['--version'], {
      execFileImpl: (_f, _a, _o, cb) => cb(spawnEnoent, '', '')
    })
    expect(res.ok).toBe(false)
    expect(res.failure).toBe('spawn')
    expect(res.message).toBeTruthy()
  })

  it('keeps partial output from a truncated run', async () => {
    const res = await run('claude', ['mcp', 'list'], {
      execFileImpl: (_f, _a, _o, cb) => cb(overflow, 'first half', '')
    })
    expect(res.truncated).toBe(true)
    expect(res.stdout).toBe('first half')
  })

  it('reports a clean run as ok', async () => {
    const res = await run('claude', ['--version'], {
      execFileImpl: (_f, _a, _o, cb) => cb(null, '2.1.202 (Claude Code)\n', '')
    })
    expect(res).toMatchObject({ ok: true, code: 0, stdout: '2.1.202 (Claude Code)' })
    expect(res.message).toBeNull()
  })
})
