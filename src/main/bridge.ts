// Local bridge server on 127.0.0.1: receives Claude Code hook events (HTTP POST) and hosts the
// browser extension connection (WebSocket). Every request needs Clawd's token; requests from
// web pages are refused by origin, so a website cannot talk to Clawd.

import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { logger } from './log'
import { dataPath, writeFileAtomic } from './paths'

const log = logger('bridge')
export const BRIDGE_PORTS = [47913, 47914, 47915, 47916, 47917]

function loadToken(): string {
  const file = dataPath('bridge-token')
  try {
    const t = fs.readFileSync(file, 'utf8').trim()
    if (/^[a-f0-9]{48}$/.test(t)) return t
  } catch {
    /* create below */
  }
  const t = crypto.randomBytes(24).toString('hex')
  writeFileAtomic(file, t)
  return t
}

export class BridgeServer extends EventEmitter {
  readonly token = loadToken()
  port = 0
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null

  private allowedOrigin(origin: string | undefined): boolean {
    // Hooks send no Origin; the extension sends chrome-extension:// or moz-extension://.
    return !origin || /^(chrome|moz)-extension:\/\//.test(origin)
  }

  /** DNS rebinding defence: a page on evil.example resolving to 127.0.0.1 still sends its own Host. */
  private localHost(req: http.IncomingMessage): boolean {
    const host = String(req.headers.host ?? '').toLowerCase()
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
  }

  private authorised(req: http.IncomingMessage, url: URL): boolean {
    const header = req.headers['x-clawd-token']
    const given = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('token') ?? ''
    if (given.length !== this.token.length) return false
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(this.token))
  }

  async start(): Promise<number> {
    const server = http.createServer((req, res) => this.onRequest(req, res))
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/browser' || !this.localHost(req) || !this.allowedOrigin(req.headers.origin) || !this.authorised(req, url)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.emit('browser', ws as WebSocket, req))
    })
    for (const port of BRIDGE_PORTS) {
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false))
        server.listen(port, '127.0.0.1', () => resolve(true))
      })
      if (ok) {
        this.port = port
        break
      }
    }
    if (!this.port) {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      this.port = (server.address() as { port: number }).port
    }
    this.server = server
    writeFileAtomic(dataPath('bridge.json'), JSON.stringify({ port: this.port, token: this.token, pid: process.pid }))
    log.info('bridge listening', { port: this.port })
    return this.port
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!this.localHost(req) || !this.allowedOrigin(req.headers.origin) || !this.authorised(req, url)) {
      res.writeHead(403).end()
      return
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, app: 'clawd' }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/cc/event') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (c: string) => {
        body += c
        if (body.length > 2_000_000) req.destroy()
      })
      req.on('end', () => {
        res.writeHead(204).end()
        try {
          this.emit('cc', JSON.parse(body))
        } catch {
          /* malformed hook payload */
        }
      })
      return
    }
    res.writeHead(404).end()
  }

  stop(): void {
    this.wss?.close()
    this.server?.close()
  }
}
