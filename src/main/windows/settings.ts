// The settings application window.

import { BrowserWindow, nativeTheme } from 'electron'
import type { Events } from '../../shared/api'
import { resourcePath } from '../paths'
import { loadPage, secureWindow } from './common'

export class SettingsWindow {
  private win: BrowserWindow | null = null

  open(section?: string): void {
    if (this.win && !this.win.isDestroyed()) {
      if (section) this.win.webContents.send('panel:show', { section: section as 'chat' })
      if (section) void this.win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(section)}`)
      if (this.win.isMinimized()) this.win.restore()
      this.win.show()
      this.win.focus()
      return
    }
    const dark = nativeTheme.shouldUseDarkColors
    const win = secureWindow({
      width: 1080,
      height: 740,
      minWidth: 860,
      minHeight: 560,
      show: false,
      title: 'Clawd Settings',
      icon: resourcePath('icon.ico'),
      backgroundColor: dark ? '#141413' : '#f5f2ec',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#ece9e2' : '#1f1e1c', height: 44 },
      autoHideMenuBar: true,
    })
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => (this.win = null))
    void loadPage(win, 'settings', section)
    this.win = win
  }

  /** Keeps the native caption buttons legible when the theme changes. */
  setTheme(dark: boolean): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#ece9e2' : '#1f1e1c', height: 44 })
    this.win.setBackgroundColor(dark ? '#141413' : '#f5f2ec')
  }

  send<K extends keyof Events>(ch: K, payload: Events[K]): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(ch, payload)
  }

  get window(): BrowserWindow | null {
    return this.win
  }
}
