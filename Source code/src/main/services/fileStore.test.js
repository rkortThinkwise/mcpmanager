import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteJson, readJsonSafe } from './fileStore'

let dir

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twmcp-fs-test-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const at = (name) => path.join(dir, name)

/**
 * readJsonSafe exists to keep "missing" and "corrupt" apart: a missing store is
 * normal on first run, while a corrupt one has to be surfaced rather than
 * silently resetting the user's settings to defaults.
 */
describe('readJsonSafe', () => {
  it('returns the fallback for a missing file, and does NOT call it corrupt', () => {
    expect(readJsonSafe(at('nope.json'), { a: 1 })).toMatchObject({
      data: { a: 1 },
      corrupted: false,
      error: null
    })
  })

  it('flags a corrupt file so the caller can warn instead of resetting quietly', () => {
    fs.writeFileSync(at('bad.json'), '{ not json')
    const res = readJsonSafe(at('bad.json'), { fallback: true })
    expect(res.corrupted).toBe(true)
    expect(res.error).toBeTruthy()
    expect(res.data).toMatchObject({ fallback: true })
  })

  it('reads valid JSON', () => {
    fs.writeFileSync(at('ok.json'), JSON.stringify({ hello: 'world' }))
    expect(readJsonSafe(at('ok.json'), null)).toMatchObject({
      data: { hello: 'world' },
      corrupted: false
    })
  })
})

describe('atomicWriteJson', () => {
  it('writes readable JSON', () => {
    atomicWriteJson(at('s.json'), { a: [1, 2], b: 'x' })
    expect(JSON.parse(fs.readFileSync(at('s.json'), 'utf8'))).toEqual({ a: [1, 2], b: 'x' })
  })

  it('replaces existing content rather than appending to it', () => {
    atomicWriteJson(at('s.json'), { v: 1 })
    atomicWriteJson(at('s.json'), { v: 2 })
    expect(readJsonSafe(at('s.json'), null).data).toEqual({ v: 2 })
  })

  it('leaves no temp file behind', () => {
    // A stray .tmp-<pid> would be picked up by the next run with stale
    // permissions, and this writes ~/.claude.json among other things.
    atomicWriteJson(at('s.json'), { v: 1 })
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('cleans up the temp file when the write cannot complete', () => {
    // Target is a directory, so the rename must fail.
    const target = at('adir')
    fs.mkdirSync(target)
    expect(() => atomicWriteJson(target, { v: 1 })).toThrow()
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('round-trips content that would break naive quoting', () => {
    const nasty = { url: 'https://x.test/a?b=1&c=2', text: 'quote " amp & nl \n done', pct: '%TEMP%' }
    atomicWriteJson(at('s.json'), nasty)
    expect(readJsonSafe(at('s.json'), null).data).toEqual(nasty)
  })
})
