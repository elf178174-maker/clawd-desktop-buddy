// Client for the clawd-native helper process (UI Automation, input, screenshots, WinEvents).
// Restarts the helper if it dies; every call has a timeout so a hung query cannot stall Clawd.

import { app, screen } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from './log'

const log = logger('native')

export interface WinInfo {
  hwnd: number
  title: string
  className: string
  pid: number
  process: string
  path: string
  /** Physical pixels. */
  bounds: { x: number; y: number; w: number; h: number }
}

export class NativeHelper extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private buf = ''
  private failures = 0
  available = false
  error: string | null = null

  exePath(): string {
    const dev = path.join(app.getAppPath(), 'native', 'bin', 'clawd-native.exe')
    const packed = path.join(process.resourcesPath ?? '', 'native', 'clawd-native.exe')
    return app.isPackaged ? packed : dev
  }

  start(): void {
    if (process.platform !== 'win32') {
      this.error = 'Windows only'
      return
    }
    const exe = this.exePath()
    if (!fs.existsSync(exe)) {
      this.error = `Helper not found at ${exe} (run npm run build:native)`
      log.warn(this.error)
      return
    }
    const p = spawn(exe, [], { windowsHide: true })
    this.proc = p
    this.available = true
    this.error = null
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (chunk: string) => this.onData(chunk))
    p.stderr.on('data', (b) => log.warn(String(b).trim()))
    p.on('exit', (code) => {
      this.available = false
      this.proc = null
      for (const [, x] of this.pending) {
        clearTimeout(x.timer)
        x.reject(new Error('The Windows helper stopped.'))
      }
      this.pending.clear()
      if (++this.failures < 6) setTimeout(() => this.start(), 1000 * this.failures)
      else this.error = `The Windows helper keeps stopping (exit ${code}).`
      log.warn('native helper exited', { code })
    })
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let msg: { id?: number; ok?: boolean; v?: unknown; e?: string; event?: string; data?: unknown }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.event) {
        this.emit(msg.event, msg.data)
        continue
      }
      const p = this.pending.get(msg.id ?? -1)
      if (!p) continue
      this.pending.delete(msg.id!)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.v)
      else p.reject(new Error(msg.e ?? 'Helper error'))
    }
  }

  call<T = unknown>(method: string, args: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
    if (!this.proc) return Promise.reject(new Error(this.error ?? 'The Windows helper is not running.'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} took too long.`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.proc!.stdin.write(JSON.stringify({ id, m: method, a: args }) + '\n')
    })
  }

  /** Physical-pixel rectangle -> DIP rectangle (for Electron windows and Clawd's pointer). */
  static toDip(r: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
    const d = screen.screenToDipRect(null, { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) })
    return { x: d.x, y: d.y, w: d.width, h: d.height }
  }

  static toPhysical(x: number, y: number): { x: number; y: number } {
    const p = screen.dipToScreenPoint({ x, y })
    return { x: p.x, y: p.y }
  }

  stop(): void {
    this.failures = 99
    this.proc?.kill()
  }
}
