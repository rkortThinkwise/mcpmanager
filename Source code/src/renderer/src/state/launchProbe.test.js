import { describe, expect, it } from 'vitest'
import { LAUNCH_START_GRACE_MS, launchFailureMessage } from './ConnectionsContext'

/**
 * The three-way distinction these markers exist to make. Before them, a
 * terminal that never opened was indistinguishable from a user who simply
 * hadn't finished in the browser — so the only possible outcome was a
 * five-minute timeout with nothing actionable in it.
 */
describe('launchFailureMessage', () => {
  const waiting = { known: true, started: true, exited: false, exitCode: null }

  it('keeps waiting while the CLI is running and the browser step is open', () => {
    // The legitimate slow case: this must survive the full timeout.
    expect(launchFailureMessage(waiting, 4 * 60 * 1000)).toBeNull()
  })

  it('keeps waiting inside the startup grace period', () => {
    const notYet = { known: true, started: false, exited: false, exitCode: null }
    expect(launchFailureMessage(notYet, 1000)).toBeNull()
  })

  it('gives up once the grace period passes with no terminal', () => {
    const never = { known: true, started: false, exited: false, exitCode: null }
    const msg = launchFailureMessage(never, LAUNCH_START_GRACE_MS + 1)
    expect(msg).toMatch(/never opened/i)
    // Naming a likely cause is the difference between an error and a dead end.
    expect(msg).toMatch(/antivirus|policy/i)
  })

  it('fails immediately when the sign-in exited non-zero', () => {
    // The script pauses after printing the error, so without this the app would
    // wait out the whole timeout on a failure it already knew about.
    const failed = { known: true, started: true, exited: true, exitCode: 1 }
    expect(launchFailureMessage(failed, 3000)).toMatch(/without authorizing/i)
  })

  it('treats a clean exit as success, not failure', () => {
    // exit 0 means the CLI finished; the status poll decides the outcome.
    const ok = { known: true, started: true, exited: true, exitCode: 0 }
    expect(launchFailureMessage(ok, 3000)).toBeNull()
  })

  it('never blocks when there is nothing to go on', () => {
    // No token (a Codex login, or an older call site) and an unreadable probe
    // must both degrade to the previous timeout-only behaviour.
    expect(launchFailureMessage(null, 10 * 60 * 1000)).toBeNull()
    expect(launchFailureMessage({ known: false }, 10 * 60 * 1000)).toBeNull()
  })
})
