import path from 'path'

/**
 * Pure helpers for locating and launching a CLI executable.
 *
 * Deliberately free of `fs`, `child_process` and `electron`: everything here is a
 * function of its arguments, with filesystem access injected as an `exists`
 * callback. That's what lets the tricky parts — Windows shim repair, candidate
 * ranking, version parsing — be tested without a filesystem or a subprocess.
 */

const WINDOWS_KINDS = {
  '.exe': 'exe',
  '.cmd': 'cmd',
  '.bat': 'cmd',
  '.ps1': 'ps1'
}

/**
 * What kind of thing a candidate path is, which decides both how it has to be
 * launched and how much we trust it. `shim` is the problem case: a global npm
 * install writes THREE files next to each other — `claude` (a Bourne script with
 * no extension), `claude.cmd` and `claude.ps1` — and Windows `where` returns the
 * extensionless one first. execFile cannot launch it, and cmd.exe can't either,
 * because the path it was handed has no extension for PATHEXT to complete.
 */
export function classifyCandidate(candidatePath, platform = process.platform) {
  if (platform !== 'win32') return 'posix'
  const ext = path.extname(String(candidatePath)).toLowerCase()
  return WINDOWS_KINDS[ext] || 'shim'
}

// Preference order when repairing a shim: a real executable beats a batch shim,
// which beats a PowerShell script (see launchSpecFor for why .ps1 is last).
const SHIM_REPAIR_EXTENSIONS = ['.exe', '.cmd', '.bat', '.ps1']

/**
 * Given an extensionless Windows path, find the sibling that can actually be
 * run. This is the fix for the npm-global install being silently unusable: the
 * Bourne shim and the `.cmd` shim live in the same directory under the same
 * stem, so the runnable one is always one `existsSync` away.
 *
 * Returns null when there's no runnable sibling, which is a real answer — the
 * caller should drop the candidate rather than cache something it can't launch.
 */
export function repairExtensionlessShim(candidatePath, exists) {
  for (const ext of SHIM_REPAIR_EXTENSIONS) {
    const sibling = `${candidatePath}${ext}`
    if (exists(sibling)) return sibling
  }
  return null
}

/**
 * How to invoke a resolved binary: the file to spawn, plus any arguments that
 * have to precede the CLI's own.
 *
 * `.cmd`/`.bat` need cmd.exe because execFile can't launch a batch file.
 * `.ps1` needs powershell with the profile and execution policy neutralised,
 * since npm's PowerShell shim would otherwise be blocked by the default
 * Restricted policy on a stock machine.
 *
 * SECURITY: neither route is self-escaping — see the note on runClaude in
 * claudeCli.js. Callers must validate every value that reaches `args`, and the
 * `.ps1` route needs a stricter allowlist than the cmd.exe one because
 * PowerShell's metacharacter set is different ($, backtick, ; and friends).
 * In practice `.ps1` is only reachable via a manual path override: npm always
 * writes the `.cmd` alongside it, and the `.cmd` outranks it.
 */
export function launchSpecFor(bin, platform = process.platform, env = process.env) {
  const kind = classifyCandidate(bin, platform)
  if (kind === 'cmd') {
    return { file: comSpec(env), prefix: ['/c', bin], kind }
  }
  if (kind === 'ps1') {
    return {
      file: powerShell(env),
      prefix: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bin],
      kind
    }
  }
  return { file: bin, prefix: [], kind }
}

/**
 * Resolve cmd.exe by absolute path rather than trusting PATH to produce it.
 * A PATH lookup for a shell is exactly the kind of thing a planted binary
 * earlier on PATH would hijack.
 */
export function comSpec(env = process.env) {
  const fromEnv = env.ComSpec || env.COMSPEC
  if (fromEnv) return fromEnv
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  return path.join(root, 'System32', 'cmd.exe')
}

export function powerShell(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Pull a version out of a `--version` line.
 *
 * The CLIs disagree on where the number sits — Claude Code prints
 * "2.1.202 (Claude Code)" and Codex prints "codex-cli 0.146.0" — so match the
 * number itself instead of taking the first or last whitespace-delimited token.
 * Returns null when there's nothing version-shaped, which the caller treats as a
 * failed probe rather than a healthy CLI with an unknown version.
 */
export function parseVersion(stdout) {
  const firstLine = String(stdout || '').split(/\r?\n/)[0]
  const m = firstLine.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/)
  return m ? m[1] : null
}

/** Compare two dotted version strings numerically. Missing parts count as 0. */
export function compareSemver(a, b) {
  const pa = String(a || '').split(/[.\-+]/)
  const pb = String(b || '').split(/[.\-+]/)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const na = Number.parseInt(pa[i], 10) || 0
    const nb = Number.parseInt(pb[i], 10) || 0
    if (na !== nb) return na > nb ? 1 : -1
  }
  return 0
}

/**
 * Sort `<prefix><version>` directory names newest-first.
 *
 * readdirSync order is lexicographic at best, which puts "1.0.9" above "1.0.10"
 * — so scanning VS Code's extensions directory without this can hand back an
 * older bundled binary than the one actually installed.
 */
export function sortVersionedDirs(names, prefix) {
  return names
    .filter((n) => n.startsWith(prefix))
    .slice()
    .sort((a, b) => compareSemver(b.slice(prefix.length), a.slice(prefix.length)))
}

/**
 * Split a PATH value into usable directories.
 *
 * Real PATH values are messier than they look: entries get quoted when they
 * contain spaces, a stray separator leaves an empty entry (this machine's user
 * PATH has a `;;` in it), and the same directory shows up twice in different
 * casing. Relative entries are dropped outright — an empty or relative entry
 * resolves against the current directory, which is how a binary dropped beside
 * the app could get picked ahead of the real install.
 */
export function splitPathList(pathEnv, platform = process.platform) {
  const sep = platform === 'win32' ? ';' : ':'
  const seen = new Set()
  const out = []
  for (const raw of String(pathEnv || '').split(sep)) {
    const entry = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!entry) continue
    if (!path.isAbsolute(entry)) continue
    const key =
      platform === 'win32' ? entry.toLowerCase().replace(/[\\/]+$/, '') : entry
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/**
 * Extensions to try for a bare command name.
 *
 * Deliberately not PATHEXT verbatim: PATHEXT carries `.COM`, `.VBS`, `.JS` and
 * friends, none of which a CLI ships as, and it does NOT carry `.ps1` — which
 * npm does write. The empty string is last so an extensionless shim is only
 * considered when there's nothing better, and even then it gets repaired.
 */
export function probeExtensions(platform = process.platform) {
  return platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : ['']
}

/**
 * Find every place `command` exists on PATH.
 *
 * This replaces shelling out to `where`/`which`, which had three problems: it
 * reported only what the caller then truncated to one line, Windows `where`
 * searches the current directory before PATH, and it cost a subprocess on a
 * code path that runs on every connection list refresh.
 */
export function enumeratePathCandidates({
  command,
  pathEnv,
  platform = process.platform,
  exists
}) {
  const out = []
  for (const dir of splitPathList(pathEnv, platform)) {
    for (const ext of probeExtensions(platform)) {
      const candidate = path.join(dir, `${command}${ext}`)
      if (exists(candidate)) out.push(candidate)
    }
  }
  return out
}

// Lower is better. An explicit override beats everything; PATH beats a guess at
// a well-known location; the VS Code extension's bundled copy is the last
// resort, since it tracks the extension's release rather than the user's install.
const SOURCE_RANK = { override: 0, path: 1, static: 2, vscode: 3 }
const KIND_RANK = { exe: 0, posix: 0, cmd: 1, ps1: 2, shim: 3 }

/**
 * Order candidates by how likely they are to work, keeping ties in the order
 * they were discovered so a directory earlier on PATH still wins.
 */
export function rankCandidates(candidates, platform = process.platform) {
  return candidates
    .map((c, index) => ({ ...c, index, kind: c.kind || classifyCandidate(c.path, platform) }))
    .sort(
      (a, b) =>
        (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9) ||
        (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) ||
        a.index - b.index
    )
}

/**
 * Resolve a candidate list to launchable, deduplicated paths.
 *
 * Extensionless Windows hits are repaired to a runnable sibling, or dropped when
 * there isn't one — caching a path that can never be launched is what made a
 * global npm install report as healthy and then fail everything afterwards.
 */
export function prepareCandidates(candidates, { platform = process.platform, exists }) {
  const seen = new Set()
  const out = []
  for (const candidate of rankCandidates(candidates, platform)) {
    let target = candidate.path
    let repairedFrom = null
    if (candidate.kind === 'shim') {
      const repaired = repairExtensionlessShim(target, exists)
      if (!repaired) {
        out.push({ ...candidate, path: target, unrepairable: true })
        continue
      }
      repairedFrom = target
      target = repaired
    }
    const key = platform === 'win32' ? target.toLowerCase() : target
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      ...candidate,
      path: target,
      repairedFrom,
      kind: classifyCandidate(target, platform)
    })
  }
  return out
}
