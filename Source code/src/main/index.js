import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { registerIpc, isSafeExternalUrl } from './ipc'
import * as scopeWatcher from './services/scopeWatcher'
import * as log from './services/logger'

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 940,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'MCP Manager',
    // electron-builder generates the packaged app/installer icon from
    // build/icon.png itself; this only covers the taskbar/window icon while
    // running unpacked (`pnpm dev` / `pnpm start`).
    icon: join(__dirname, '../../build/icon.png'),
    backgroundColor: '#FAFBFC',
    webPreferences: {
      // Node APIs stay out of the renderer; everything crosses the
      // contextBridge in preload. This matters because the app handles an
      // OAuth client secret.
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // Open target=_blank / window.open links in the OS browser, never in-app —
  // and only if they're http(s), since openExternal would otherwise launch an
  // OS protocol handler for anything with a registered scheme.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // The counterpart to the handler above: that one covers window.open, this one
  // covers navigating the window itself. Without it a stray in-page link could
  // replace the renderer — which has the contextBridge attached — with a remote
  // document.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow.webContents.getURL()
    if (url === current) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) shell.openExternal(url)
  })

  // electron-vite provides the dev-server URL via this env var in development;
  // in production we load the built renderer from disk.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Only one instance may run.
 *
 * Every write this app makes goes through the Claude Code CLI, which
 * read-modify-writes ~/.claude.json. Two instances doing that concurrently can
 * lose an entry outright, and the in-process guards (mutateMeta, the server-state
 * cache) only coordinate within one process. Focusing the existing window is also
 * what a user double-clicking the shortcut again actually wants.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  start()
}

/**
 * Report a crash instead of vanishing.
 *
 * console.error goes nowhere a user can see in a packaged build, so an
 * unexpected throw in the main process used to look like the app silently
 * doing nothing. A dialog at least tells them what to report.
 */
function reportFatal(kind) {
  return (error) => {
    const detail = (error && (error.stack || error.message)) || String(error)
    log.error('main', `${kind}:`, detail)
    // Never let the dialog itself take the process down.
    try {
      dialog.showErrorBox(
        'MCP Manager hit an unexpected problem',
        [kind, detail, 'Your Claude Code configuration has not been changed by this error.'].join(
          '\n\n'
        )
      )
    } catch {
      // No display available.
    }
  }
}

process.on('uncaughtException', reportFatal('Unexpected error'))
process.on('unhandledRejection', reportFatal('Unexpected error (unhandled promise)'))

function start() {
  app.whenReady().then(() => {
    log.info('main', `MCP Manager ${app.getVersion()} starting on ${process.platform}`)
    registerIpc(() => mainWindow)
    createWindow()
    // Periodically re-checks each server's well-known endpoint for scope changes.
    scopeWatcher.start(() => mainWindow)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Don't leave a timer armed against a window that's gone.
app.on('before-quit', () => scopeWatcher.stop())
