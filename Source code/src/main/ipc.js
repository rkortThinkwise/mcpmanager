import { ipcMain, dialog, shell, app } from 'electron'
import * as configFile from './services/configFile'
import * as connectivity from './services/connectivity'
import * as claudeCli from './services/claudeCli'
import { readLaunchProbe } from './services/terminalLauncher'
import * as log from './services/logger'
import * as codexCli from './services/codexCli'
import * as connections from './services/connections'
import * as settings from './services/settings'
import * as scopeWatcher from './services/scopeWatcher'
import * as secrets from './services/secrets'
import * as vscode from './services/vscode'
import * as v from './validate'

/**
 * shell.openExternal hands the URL to the OS handler, which will launch a
 * registered protocol handler for schemes like `file:`, `smb:` or `ms-msdt:` —
 * so it needs a scheme allowlist, not just a well-formed URL. Exported because
 * the window-open handler in index.js has to apply the same policy.
 */
export function isSafeExternalUrl(raw) {
  try {
    const { protocol } = new URL(raw)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

// Small wrapper so a thrown error in any handler comes back to the renderer as
// a structured { ok:false, error } rather than an unhandled rejection. This is
// also what turns a validation failure (see ./validate) into a message the
// renderer can show.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      // Never return an empty `error`. A CLI call that failed to spawn produces
      // empty stdout AND empty stderr, so a handler throwing on that used to
      // hand the renderer an Error with nothing in it — the user saw a failure
      // with no explanation at all. `detail` and `code` are additive: existing
      // callers read only `error`.
      const message =
        (err && err.message) || (err && String(err)) || `${channel} failed for an unknown reason.`
      return {
        ok: false,
        error: message,
        detail: (err && err.detail) || null,
        code: (err && err.cliFailure) || (err && err.code) || null
      }
    }
  })
}

export function registerIpc(getWindow) {
  // ---- System / app info ----
  handle('system:info', async () => {
    const secretsHealth = secrets.getStoreHealth()
    return {
      platform: process.platform,
      arch: process.arch,
      encryptionAvailable: secrets.isEncryptionAvailable(),
      appVersion: app.getVersion(),
      // A corrupted secrets.json silently drops every stored OAuth client
      // secret otherwise — see secrets.getStoreHealth() — so this is worth
      // a dedicated warning in the settings dialog rather than only ever
      // showing up as connections mysteriously asking for their secret again.
      secretsCorrupted: secretsHealth.corrupted,
      secretsError: secretsHealth.error
    }
  })

  handle('app:openExternal', async (url) => {
    if (!isSafeExternalUrl(url)) throw new Error('Only http(s) links can be opened.')
    await shell.openExternal(url)
    return true
  })

  // ---- Connections list & per-connection actions ----
  // The manager's own surface. Reads come from ~/.claude.json; every write goes
  // through the Claude Code CLI, for the client-secret reason documented in
  // services/claudeCli.js.
  //
  // Payloads are shape-checked here rather than in each service, so the rules
  // for a name, a scope or a port are stated once. See ./validate.
  handle('connections:list', () => connections.listConnections())
  handle('connections:get', (id) => connections.getConnectionDetails(v.connectionId(id)))
  handle('connections:add', (payload) => connections.addConnection(v.connectionPayload(payload)))
  handle('connections:refreshScopes', (id) => connections.refreshScopes(v.connectionId(id)))
  handle('connections:applyScopeRefresh', (id, payload) =>
    connections.applyScopeRefresh(v.connectionId(id), v.scopeRefreshPayload(payload))
  )
  handle('connections:reauthorize', (id) => connections.reauthorize(v.connectionId(id)))
  handle('connections:setEnabled', (id, enabled) =>
    connections.setConnectionEnabled(v.connectionId(id), Boolean(enabled))
  )
  handle('connections:delete', (id) => connections.deleteConnection(v.connectionId(id)))
  handle('connections:duplicate', (id, payload) =>
    connections.duplicateConnection(v.connectionId(id), v.duplicatePayload(payload))
  )
  handle('connections:rename', (id, payload) =>
    connections.renameConnection(v.connectionId(id), v.renamePayload(payload))
  )
  // Paired with connections:list (the renderer calls both together, see
  // ConnectionsContext.reload) rather than folded into the list response
  // itself, so the list's own shape (a plain array) doesn't have to change
  // just to carry one extra, list-wide diagnostic.
  handle('connections:codexHealth', () => ({ codexListError: connections.getCodexListError() }))

  // ---- Settings + the periodic scope-drift check ----
  handle('settings:get', async () => {
    const current = settings.readSettings()
    const health = settings.getSettingsHealth()
    return {
      ...current,
      intervalOptions: settings.CHECK_INTERVAL_OPTIONS,
      // A corrupted settings.json silently resets to defaults otherwise —
      // see settings.getSettingsHealth() — worth a dedicated warning rather
      // than a preference quietly reverting with no explanation.
      settingsCorrupted: health.corrupted,
      settingsError: health.error
    }
  })
  handle('settings:set', async (patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('No settings were supplied.')
    const next = settings.writeSettings({
      ...(patch.scopeCheckIntervalMinutes === undefined
        ? {}
        : { scopeCheckIntervalMinutes: Number(patch.scopeCheckIntervalMinutes) }),
      ...(patch.checkOnStartup === undefined
        ? {}
        : { checkOnStartup: Boolean(patch.checkOnStartup) }),
      ...(patch.claudeCliPath === undefined
        ? {}
        : { claudeCliPath: v.optionalCliPath(patch.claudeCliPath) })
    })
    // A changed interval has to take effect now, not after the pending timer
    // from the old interval finally fires.
    scopeWatcher.schedule()
    // A changed CLI path invalidates everything we'd cached about the old one.
    if (patch.claudeCliPath !== undefined) claudeCli.invalidateResolution()
    return { ...next, intervalOptions: settings.CHECK_INTERVAL_OPTIONS }
  })
  handle('scopes:checkNow', () => scopeWatcher.runNow())

  // Diagnostics. showItemInFolder rather than openPath: opening the folder is
  // what a user attaching a log to a bug report actually wants, and it avoids
  // handing an arbitrary file to the OS handler.
  handle('logs:reveal', () => {
    const dir = log.logDirectory()
    if (!dir) throw new Error('No log folder is available on this machine.')
    shell.openPath(dir)
    return { path: dir }
  })

  // ---- Wizard step 3: connectivity ----
  handle('connectivity:reachability', (url) =>
    connectivity.checkReachability(v.requireHttpUrl(url, 'The server URL'))
  )
  handle('connectivity:metadata', (url) =>
    connectivity.discoverMetadata(v.requireHttpUrl(url, 'The server URL'))
  )

  // ---- Wizard step 1: prerequisite checks ----
  handle('vscode:detect', () => vscode.detect())

  // ---- Wizard step 5: config file ----
  handle('config:locate', () => configFile.locateConfig())
  handle('config:validate', (p) => configFile.validateConfig(v.requireString(p, 'A config path')))
  handle('config:pickFile', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win, {
      title: 'Select your Claude config file',
      properties: ['openFile'],
      filters: [
        { name: 'Claude config', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    return { canceled: false, ...configFile.validateConfig(result.filePaths[0]) }
  })
  // Deliberately not config:pickFile: that one filters for .json and validates
  // the result as a Claude config, neither of which fits an executable.
  handle('settings:pickCliPath', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win, {
      title: 'Select the Claude Code CLI program',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [
              { name: 'Programs', extensions: ['exe', 'cmd', 'bat', 'ps1'] },
              { name: 'All files', extensions: ['*'] }
            ]
          : [{ name: 'All files', extensions: ['*'] }]
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    return { canceled: false, path: v.optionalCliPath(result.filePaths[0]) }
  })
  handle('config:listProjects', (p) => {
    const res = configFile.validateConfig(v.requireString(p, 'A config path'))
    if (!res.valid) throw new Error(res.error)
    return configFile.listProjects(res.config)
  })
  handle('config:casingCheck', (p, projectPath) => {
    const res = configFile.validateConfig(v.requireString(p, 'A config path'))
    if (!res.valid) throw new Error(res.error)
    return configFile.casingCheck(res.config, v.optionalString(projectPath, 'A project path'))
  })
  handle('config:readEntry', (payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('No entry was specified.')
    const { installScope, projectPath } = v.requireLocation({
      installScope: payload.scope,
      projectPath: payload.projectPath
    })
    return configFile.readEntry({
      filePath: v.requireString(payload.filePath, 'A config path'),
      scope: installScope,
      projectPath,
      name: v.requireServerName(payload.name)
    })
  })

  // ---- Registration through the Claude Code CLI ----
  // The CLI is how the OAuth client secret reaches Claude Code's credential
  // store; see services/claudeCli.js for why a plain JSON write isn't enough.
  //
  // Only the calls the renderer actually makes are exposed. `claude:register`
  // and `claude:remove` used to sit here as well, superseded by
  // connections:add / connections:delete (which also handle the secret store,
  // the meta record and the collision checks) — an unused channel that can
  // register a server is surface for nothing.
  handle('claude:detect', () => claudeCli.detect())
  handle('claude:get', (payload) => claudeCli.getServer(v.cliTarget(payload)))
  // Kicks off the browser OAuth flow. Returns as soon as the terminal is
  // launched; the renderer polls claude:get to detect completion.
  handle('claude:startLogin', (payload) => claudeCli.startLogin(v.cliTarget(payload)))
  // How far the sign-in terminal has got. Lets the poller distinguish "the
  // terminal never opened" from "the user hasn't finished in the browser yet",
  // instead of treating both as a five-minute wait. Takes only the opaque
  // token — see validate.launchId.
  handle('login:launchStatus', (id) => readLaunchProbe(v.launchId(id)))

  // ---- Registration through the Codex CLI ----
  // Mirrors the claude:* stanza above, minus everything that only exists for
  // Claude Code (scope/projectPath, a stored client secret) — see
  // services/codexCli.js.
  handle('codex:detect', () => codexCli.detect())
  handle('codex:get', (payload) => codexCli.getServer(v.codexTarget(payload)))
  handle('codex:startLogin', (payload) => codexCli.startLogin(v.codexTarget(payload)))

  // NOTE: there are deliberately no `secret:*` channels. The renderer never
  // handles the stored secret directly — it hands a typed-in one to
  // connections:add / :duplicate / :rename / :applyScopeRefresh, which store it
  // only once the registration it was needed for has actually succeeded.
  // `system:info` already reports whether OS-level encryption is available,
  // which is all the UI needs to warn about.
}
