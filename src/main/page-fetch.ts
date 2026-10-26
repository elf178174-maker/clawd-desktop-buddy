// Reads public web pages in a hidden, sandboxed browser window (JavaScript runs, so dynamic pages
// work) and extracts the article with Mozilla Readability. No cookies are shared with anything,
// downloads and permission requests are refused, and popups are blocked.

import { BrowserWindow, session } from 'electron'
import readabilitySrc from '@mozilla/readability/Readability.js?raw'
import type { PageContent } from '../shared/host'

const PARTITION = 'clawd-fetch'
let prepared = false

function prepare(): void {
  if (prepared) return
  prepared = true
  const s = session.fromPartition(PARTITION)
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  s.on('will-download', (e) => e.preventDefault())
  s.setUserAgent(s.getUserAgent().replace(/\s?Electron\/\S+/, '').replace(/\s?clawd-companion\/\S+/i, ''))
}

const EXTRACT = (maxChars: number, scroll: boolean) => `
(async () => {
  if (${scroll}) {
    for (let i = 0; i < 8; i++) { window.scrollBy(0, window.innerHeight * 1.5); await new Promise(r => setTimeout(r, 250)) }
    window.scrollTo(0, 0)
  }
  ${readabilitySrc}
  let title = document.title, text = '', byline = ''
  try {
    const art = new Readability(document.cloneNode(true)).parse()
    if (art && art.textContent && art.textContent.trim().length > 200) { title = art.title || title; text = art.textContent; byline = art.byline || '' }
  } catch (e) {}
  if (!text) text = document.body ? document.body.innerText : ''
  text = text.replace(/\\n\\s*\\n\\s*\\n+/g, '\\n\\n').trim()
  return { url: location.href, title, text: text.slice(0, ${maxChars}), byline, length: text.length }
})()`

export async function fetchPage(url: string, maxChars: number, scroll = true): Promise<PageContent> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) pages can be read.')
  prepare()
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, images: false, backgroundThrottling: false },
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await Promise.race([
      win.loadURL(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('The page took too long to load.')), 25000)),
    ]).catch((err) => {
      // A slow subresource is fine as long as the document itself arrived.
      if (!win.webContents.getURL() || win.webContents.getURL() === 'about:blank') throw err
    })
    await new Promise((r) => setTimeout(r, 1200))
    const r = (await win.webContents.executeJavaScript(EXTRACT(maxChars, scroll), true)) as { url: string; title: string; text: string; byline: string; length: number }
    if (!r.text) throw new Error('The page had no readable text.')
    return { url: r.url, title: r.title, text: r.text, byline: r.byline || undefined, truncated: r.length > maxChars, method: 'fetch' }
  } finally {
    win.destroy()
  }
}
