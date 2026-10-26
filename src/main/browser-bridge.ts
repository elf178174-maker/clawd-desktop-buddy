// Connection to Clawd's browser extension (Chromium MV3: Chrome, Edge, Arc, Brave...). The
// extension reads whole pages (beyond the viewport) and reports the active tab.

import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import type { BrowserTab, PageContent } from '../shared/host'
import { logger } from './log'

const log = logger('browser')

interface Client {
  id: string
  ws: WebSocket
  browser: string
  version: string
  connectedAt: number
  lastSeen: number
}

export class BrowserBridge extends EventEmitter {
  private clients = new Map<string, Client>()
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private active: { url: string; title: string; at: number } | null = null

  attach(ws: WebSocket): void {
    const id = `c${++this.seq}`
    let client: Client | null = null
    const hello = setTimeout(() => ws.close(4001, 'no hello'), 5000)
    ws.on('message', (raw) => {
      let msg: { type?: string; id?: number; result?: unknown; error?: string; browser?: string; version?: string; url?: string; title?: string }
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (msg.type === 'hello') {
        clearTimeout(hello)
        client = { id, ws, browser: String(msg.browser ?? 'Browser').slice(0, 60), version: String(msg.version ?? '').slice(0, 20), connectedAt: Date.now(), lastSeen: Date.now() }
        this.clients.set(id, client)
        log.info('extension connected', { browser: client.browser })
        ws.send(JSON.stringify({ type: 'welcome', app: 'Clawd' }))
        this.emit('status')
        return
      }
      if (!client) return
      client.lastSeen = Date.now()
      if (msg.type === 'activeTab' && typeof msg.url === 'string') {
        this.active = { url: msg.url, title: String(msg.title ?? ''), at: Date.now() }
        return
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error))
        else p.resolve(msg.result)
      }
    })
    ws.on('close', () => {
      clearTimeout(hello)
      this.clients.delete(id)
      this.emit('status')
    })
    ws.on('error', () => ws.close())
  }

  get connected(): boolean {
    return this.clients.size > 0
  }

  clientList(): { id: string; browser: string; version: string; connectedAt: number }[] {
    return [...this.clients.values()].map((c) => ({ id: c.id, browser: c.browser, version: c.version, connectedAt: c.connectedAt }))
  }

  activeUrl(): string | undefined {
    return this.active && Date.now() - this.active.at < 10 * 60_000 ? this.active.url : undefined
  }

  private call<T>(method: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    const client = [...this.clients.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0]
    if (!client) return Promise.reject(new Error("Clawd's browser extension is not connected. Install it from Settings > Integrations."))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The browser did not answer in time.'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      client.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async getPage(tabId: number | null, maxChars: number, scroll: boolean): Promise<PageContent> {
    const r = await this.call<{ url: string; title: string; text: string; byline?: string; length: number }>('getPage', { tabId, maxChars, scroll }, scroll ? 60000 : 30000)
    return { url: r.url, title: r.title, text: r.text.slice(0, maxChars), byline: r.byline, truncated: r.length > maxChars, method: 'extension' }
  }

  getDraft(timeoutMs = 4000): Promise<{ found: boolean; text: string; kind?: string; url: string; title: string }> {
    return this.call('getDraft', {}, timeoutMs)
  }

  setDraft(text: string): Promise<{ ok: boolean; message: string }> {
    return this.call('setDraft', { text }, 8000)
  }

  listTabs(): Promise<BrowserTab[]> {
    return this.call<BrowserTab[]>('listTabs', {})
  }
}
