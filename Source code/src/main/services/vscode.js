import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'

function runRaw(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10000 }, (error, stdout) => {
      resolve({ code: error ? 1 : 0, stdout: (stdout || '').toString().trim() })
    })
  })
}

function staticCandidates() {
  if (isWindows) {
    return [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft VS Code', 'Code.exe')
    ]
  }
  if (isMac) {
    return ['/Applications/Visual Studio Code.app']
  }
  return [
    '/usr/share/code/code',
    '/snap/bin/code',
    '/usr/bin/code',
    path.join(os.homedir(), '.local', 'share', 'code', 'code')
  ]
}

/**
 * Locate a VS Code install. PATH first (`where`/`which code`, the CLI shim
 * both the installer and the "Add to PATH" option create), then well-known
 * install locations — a GUI app doesn't always inherit the user's shell PATH.
 */
export async function detect() {
  const located = await runRaw(isWindows ? 'where' : 'which', ['code'])
  if (located.code === 0 && located.stdout) {
    const first = located.stdout.split(/\r?\n/)[0].trim()
    if (first && fs.existsSync(first)) return { found: true, path: first }
  }

  for (const candidate of staticCandidates()) {
    if (candidate && fs.existsSync(candidate)) return { found: true, path: candidate }
  }

  return { found: false, path: null }
}
