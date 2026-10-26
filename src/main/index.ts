// Clawd desktop host entry point.

import { app } from 'electron'
import { ClawdApp } from './app'
import { logger } from './log'
import { Secrets } from './secrets'
import { SettingsStore } from './settings-store'

const log = logger('main')

app.setAppUserModelId('app.clawd.companion')
// A transparent always-on-top overlay must keep animating when no window of ours has focus.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

let clawd: ClawdApp | null = null

// A copy with its own data folder (tests, captures) is its own instance: the lock follows the
// user-data folder, so it neither quits nor summons the Clawd you are running.
if (process.env.CLAWD_DATA_DIR) app.setPath('userData', process.env.CLAWD_DATA_DIR)

if (!app.requestSingleInstanceLock()) {
  // Another Clawd is running: it receives 'second-instance' and summons itself.
  app.quit()
} else {
  app.on('second-instance', () => void clawd?.summon())
  app.on('window-all-closed', () => {
    // Clawd lives in the tray; closing windows never quits.
  })
  app.on('before-quit', () => clawd?.dispose())
  process.on('uncaughtException', (err) => log.error('uncaught exception', err))
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', err))

  app.whenReady().then(async () => {
    const settings = new SettingsStore()
    const secrets = new Secrets()
    clawd = new ClawdApp(settings, secrets)
    await clawd.start()
    ;(globalThis as unknown as { __clawd: ClawdApp }).__clawd = clawd
  })
}
