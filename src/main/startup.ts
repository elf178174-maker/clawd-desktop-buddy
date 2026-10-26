// Start-with-Windows: a per-user login item (HKCU Run key via Electron), no admin rights needed.

import { app } from 'electron'
import { execFile } from 'node:child_process'
import type { StartupStatus } from '../shared/api'
import { logger } from './log'

const log = logger('startup')
export const STARTUP_FLAG = '--startup'

function launchSpec(): { path: string; args: string[] } {
  // In development the executable is electron.exe and needs the app path as its first argument.
  if (app.isPackaged) return { path: process.execPath, args: [STARTUP_FLAG] }
  return { path: process.execPath, args: [app.getAppPath(), STARTUP_FLAG] }
}

export function applyStartup(enabled: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return
  const spec = launchSpec()
  app.setLoginItemSettings({ openAtLogin: enabled, path: spec.path, args: spec.args, name: 'Clawd' })
  log.info('login item updated', { enabled })
}

export function startupStatus(enabled: boolean): StartupStatus {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return { enabled, registered: false, supported: false, note: 'Not supported on this platform.' }
  const spec = launchSpec()
  const st = app.getLoginItemSettings({ path: spec.path, args: spec.args })
  const item = st.launchItems?.find((i) => i.name === 'Clawd') ?? st.launchItems?.[0]
  const registered = st.openAtLogin
  let note: string | undefined
  if (registered && st.executableWillLaunchAtLogin === false) note = 'Windows has Clawd disabled under Settings > Apps > Startup.'
  if (!app.isPackaged) note = (note ? note + ' ' : '') + 'Development build: the entry starts the dev copy.'
  return { enabled, registered, supported: true, command: item ? `${item.path} ${item.args.join(' ')}` : `${spec.path} ${spec.args.join(' ')}`, note }
}

/** Reads the raw Run-key entry (used by tests to confirm the registry really changed). */
export function readRunKey(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Clawd'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const line = stdout.split(/\r?\n/).find((l) => l.includes('REG_SZ'))
      resolve(line ? line.split('REG_SZ')[1].trim() : null)
    })
  })
}

export function launchedAtStartup(): boolean {
  return process.argv.includes(STARTUP_FLAG)
}
