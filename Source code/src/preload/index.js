import { contextBridge, ipcRenderer } from 'electron'

// Unwrap the { ok, data, error } envelope from ipc.js into either a resolved
// value or a thrown Error, so the renderer can use plain try/catch + await.
async function invoke(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args)
  if (res && res.ok) return res.data
  const err = new Error(res && res.error ? res.error : `IPC call ${channel} failed`)
  // Reattach what ipc.js forwarded, so a screen can render the raw CLI output
  // through ErrorDetail and branch on the failure kind instead of matching on
  // message text. Existing `catch (e) { setError(e.message) }` is unaffected.
  if (res) {
    err.detail = res.detail || null
    err.cliFailure = res.code || null
  }
  throw err
}

/**
 * Subscribe to a main-process push on one of a fixed set of channels, and hand
 * back an unsubscribe function.
 *
 * The channel list is a hard allowlist and the Electron `event` object is never
 * passed through — the renderer only ever sees the payload. Leaking `event`
 * would hand it `event.sender`, which is a way back into the main process.
 */
const EVENT_CHANNELS = new Set(['connections:changed', 'scopes:checking'])

function subscribe(channel, callback) {
  if (!EVENT_CHANNELS.has(channel)) {
    throw new Error(`Unknown event channel: ${channel}`)
  }
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  system: {
    info: () => invoke('system:info')
  },
  openExternal: (url) => invoke('app:openExternal', url),

  connections: {
    list: () => invoke('connections:list'),
    get: (id) => invoke('connections:get', id),
    add: (payload) => invoke('connections:add', payload),
    refreshScopes: (id) => invoke('connections:refreshScopes', id),
    applyScopeRefresh: (id, payload) => invoke('connections:applyScopeRefresh', id, payload),
    reauthorize: (id) => invoke('connections:reauthorize', id),
    setEnabled: (id, enabled) => invoke('connections:setEnabled', id, enabled),
    remove: (id) => invoke('connections:delete', id),
    duplicate: (id, payload) => invoke('connections:duplicate', id, payload),
    rename: (id, payload) => invoke('connections:rename', id, payload),
    codexHealth: () => invoke('connections:codexHealth'),
    // Fired after the periodic scope check records new results.
    onChanged: (cb) => subscribe('connections:changed', cb)
  },

  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    pickCliPath: () => invoke('settings:pickCliPath'),
    revealLogs: () => invoke('logs:reveal')
  },

  scopes: {
    checkNow: () => invoke('scopes:checkNow'),
    onChecking: (cb) => subscribe('scopes:checking', cb)
  },

  connectivity: {
    reachability: (url) => invoke('connectivity:reachability', url),
    metadata: (url) => invoke('connectivity:metadata', url)
  },

  vscode: {
    detect: () => invoke('vscode:detect')
  },

  config: {
    locate: () => invoke('config:locate'),
    validate: (p) => invoke('config:validate', p),
    pickFile: () => invoke('config:pickFile'),
    listProjects: (p) => invoke('config:listProjects', p),
    casingCheck: (p, projectPath) => invoke('config:casingCheck', p, projectPath),
    readEntry: (payload) => invoke('config:readEntry', payload)
  },

  claude: {
    detect: () => invoke('claude:detect'),
    launchStatus: (launchId) => invoke('login:launchStatus', launchId),
    get: (payload) => invoke('claude:get', payload),
    startLogin: (payload) => invoke('claude:startLogin', payload)
  },

  codex: {
    detect: () => invoke('codex:detect'),
    get: (payload) => invoke('codex:get', payload),
    startLogin: (payload) => invoke('codex:startLogin', payload)
  }
}

contextBridge.exposeInMainWorld('api', api)
