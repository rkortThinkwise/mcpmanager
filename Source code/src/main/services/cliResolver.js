import { classifyCandidate, enumeratePathCandidates, launchSpecFor, parseVersion, prepareCandidates } from './cliDiscovery'

/**
 * Locate a CLI executable and prove it runs, before anything depends on it.
 *
 * The problem this solves: "we found a file at this path" and "we can run the
 * CLI" are different claims, and treating them as one made a global npm install
 * on Windows report a healthy CLI that then failed every single operation with
 * no error message. The `where` first-line-wins lookup it replaced also had no
 * way to try the *next* candidate when the first one turned out to be a shell
 * script Windows can't execute.
 *
 * Every filesystem and subprocess touch is injected, so the ordering, repair,
 * caching and probe logic can be tested against a fake machine.
 */

// A machine littered with broken shims shouldn't cost a probe per candidate.
const MAX_PROBES = 4
const PROBE_TIMEOUT_MS = 10000
// Re-probing an absent CLI on every connection-list refresh would be brutal:
// deriveStatus already runs several at a time, so a machine without the CLI
// installed would pay a full scan plus MAX_PROBES timeouts per render.
const NEGATIVE_TTL_MS = 30000

export function createCliResolver({
  command,
  displayName,
  staticCandidates = () => [],
  extraCandidates = () => [],
  readOverride = () => null,
  // Called with each completed resolution. A hook rather than a direct logger
  // import so this module stays free of electron and testable without stubs.
  onResolved = () => {},
  deps
}) {
  const { exists, run, platform, env, homedir } = deps

  let cached = null // { path, version, kind }
  let negativeAt = 0
  let lastResolution = null
  let inFlight = null

  /** Everywhere the CLI might be, tagged with how much we trust each source. */
  function enumerate() {
    const out = []

    // An explicit setting is the user telling us they know better. It ranks
    // above everything and, if it fails, stops the search — silently running a
    // different binary than the one they typed would be worse than an error.
    const override = readOverride()
    if (override) out.push({ path: override, source: 'override' })

    for (const p of enumeratePathCandidates({ command, pathEnv: env.PATH || env.Path, platform, exists })) {
      out.push({ path: p, source: 'path' })
    }
    for (const p of staticCandidates()) {
      if (p && exists(p)) out.push({ path: p, source: 'static' })
    }
    for (const p of extraCandidates()) {
      if (p && exists(p)) out.push({ path: p, source: 'vscode' })
    }
    return prepareCandidates(out, { platform, exists })
  }

  /** Run `--version` and require a parseable answer. */
  async function probe(candidatePath) {
    const spec = launchSpecFor(candidatePath, platform, env)
    const res = await run(spec.file, [...spec.prefix, '--version'], {
      timeoutMs: PROBE_TIMEOUT_MS,
      cwd: homedir(),
      // Colour codes would corrupt the version string, and a pager would hang.
      env: { NO_COLOR: '1', FORCE_COLOR: '0' }
    })
    const version = res.ok ? parseVersion(res.stdout) : null
    return { res, version }
  }

  async function resolveUncached() {
    const candidates = enumerate()
    const name = displayName || command

    if (!candidates.length) {
      return {
        found: false,
        healthy: false,
        path: null,
        version: null,
        reason: 'not_found',
        message: `${name} was not found on this computer. Install it, or set the path to it in Settings.`,
        detail: null,
        candidates: []
      }
    }

    const tried = []
    for (const candidate of candidates.slice(0, MAX_PROBES)) {
      if (candidate.unrepairable) {
        // An extensionless shim with no runnable sibling. Recording it matters:
        // it's usually the only visible sign of a half-finished install.
        tried.push({
          path: candidate.path,
          source: candidate.source,
          kind: candidate.kind,
          outcome: 'shim_unrepairable',
          detail: 'No runnable .exe/.cmd/.bat/.ps1 alongside this file.'
        })
        if (candidate.source === 'override') break
        continue
      }

      const { res, version } = await probe(candidate.path)
      if (version) {
        return {
          found: true,
          healthy: true,
          path: candidate.path,
          version,
          launchKind: candidate.kind,
          source: candidate.source,
          repairedFrom: candidate.repairedFrom || null,
          reason: null,
          message: null,
          detail: null,
          candidates: tried
        }
      }

      tried.push({
        path: candidate.path,
        source: candidate.source,
        kind: candidate.kind,
        outcome: res.ok ? 'version_unparsed' : res.failure || 'probe_failed',
        detail: res.ok ? res.stdout || '(no output)' : res.message || res.stderr || '(no output)'
      })

      // The override is a hard stop, not a first guess.
      if (candidate.source === 'override') break
    }

    const first = tried[0]
    const overrode = first && first.source === 'override'
    return {
      found: true,
      healthy: false,
      path: first.path,
      version: null,
      launchKind: first.kind,
      source: first.source,
      reason: overrode ? 'override_failed' : reasonFor(first.outcome),
      message: overrode
        ? `The ${name} path set in Settings (${first.path}) could not be run. ` +
          'Correct it, or clear it to detect the CLI automatically.'
        : `${name} was found at ${first.path}, but it could not be run. ` +
          'If it works in a terminal, set the path to it in Settings.',
      detail: tried
        .map((t) => `${t.path} [${t.source}/${t.kind}] ${t.outcome}: ${t.detail}`)
        .join('\n'),
      candidates: tried
    }
  }

  function reasonFor(outcome) {
    if (outcome === 'shim_unrepairable') return 'shim_unrepairable'
    if (outcome === 'version_unparsed') return 'version_unparsed'
    if (outcome === 'timeout') return 'probe_timeout'
    return 'probe_failed'
  }

  /**
   * Full detection: enumerate, verify, and cache the binary proved runnable.
   *
   * Concurrent calls share one scan. Without that, a ten-connection list
   * refresh on a machine with no CLI would start ten identical scans.
   */
  async function detect({ refresh = false } = {}) {
    if (!refresh) {
      if (cached && exists(cached.path)) return { ...lastResolution, path: cached.path }
      if (negativeAt && Date.now() - negativeAt < NEGATIVE_TTL_MS && lastResolution) {
        return lastResolution
      }
    }
    if (inFlight) return inFlight

    inFlight = (async () => {
      try {
        const result = await resolveUncached()
        lastResolution = result
        try {
          onResolved(result)
        } catch {
          // Reporting must never break resolution.
        }
        if (result.healthy) {
          cached = { path: result.path, version: result.version, kind: result.launchKind }
          negativeAt = 0
        } else {
          cached = null
          negativeAt = Date.now()
        }
        return result
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  /**
   * The path to run, or null. Used on hot paths (one status read per connection)
   * so it returns the verified cache without re-probing.
   */
  async function resolve({ refresh = false } = {}) {
    if (!refresh && cached && exists(cached.path)) return cached.path
    const result = await detect({ refresh })
    return result.healthy ? result.path : null
  }

  /**
   * Forget what we found. Called when a run against the cached binary fails to
   * spawn — the CLI was uninstalled, upgraded or moved mid-session, and
   * re-resolving beats failing every operation until the app restarts — and
   * when the user changes the path setting.
   */
  function invalidate() {
    cached = null
    negativeAt = 0
    lastResolution = null
  }

  return {
    detect,
    resolve,
    invalidate,
    get lastResolution() {
      return lastResolution
    },
    // Exposed for the caller's shim routing; avoids re-deriving it per call.
    kindOf: (p) => classifyCandidate(p, platform)
  }
}
