// Shared helpers for creating Clawd's windows.

import { app, BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron'
import path from 'node:path'

export type PageName = 'overlay' | 'panel' | 'settings' | 'audio'

export function preloadPath(): string {
  return path.join(__dirname, '../preload/index.js')
}

export function loadPage(win: BrowserWindow, page: PageName, hash = ''): Promise<void> {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev && !app.isPackaged) return win.loadURL(`${dev}/${page}/index.html${hash ? '#' + hash : ''}`)
  return win.loadFile(path.join(__dirname, `../renderer/${page}/index.html`), hash ? { hash } : undefined)
}

export function secureWindow(opts: BrowserWindowConstructorOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...opts,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      ...opts.webPreferences,
    },
  })
  // Never navigate away from the app; open external links in the browser instead.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\u0000')) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  return win
}
