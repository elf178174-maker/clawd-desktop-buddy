// The interaction panel: a compact, frameless window that opens next to Clawd for conversation,
// task progress, permission requests and results. It never covers Clawd himself.

import { BrowserWindow, screen } from 'electron'
import { EventEmitter } from 'node:events'
import type { Events } from '../../shared/api'
import { loadPage, secureWindow } from './common'

const WIDTH = 400
const MIN_H = 150
const MAX_H = 640

export class PanelWindow extends EventEmitter {
  private win: BrowserWindow | null = null
  private ready = false
  private queue: [keyof Events, unknown][] = []
  private pinned = false
  private height = 460
  /** Set by the app: true while a task runs or needs the user, so the panel stays open on blur. */
  busy = () => false

  constructor(private clawdPoint: () => { x: number; y: number; scale: number }) {
    super()
  }

  private create(): BrowserWindow {
    const win = secureWindow({
      width: WIDTH,
      height: this.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      title: 'Clawd',
    })
    win.setAlwaysOnTop(true, 'floating')
    win.on('blur', () => {
      setTimeout(() => {
        if (this.win && !this.win.isFocused() && !this.pinned && !this.busy()) this.hide()
      }, 220)
    })
    win.on('closed', () => {
      this.win = null
      this.ready = false
    })
    win.webContents.on('did-finish-load', () => {
      this.ready = true
      for (const [ch, p] of this.queue) win.webContents.send(ch, p)
      this.queue = []
    })
    void loadPage(win, 'panel')
    this.win = win
    return win
  }

  get visible(): boolean {
    return !!this.win && this.win.isVisible()
  }

  get window(): BrowserWindow | null {
    return this.win
  }

  private place(): void {
    if (!this.win) return
    const c = this.clawdPoint()
    const d = screen.getDisplayNearestPoint({ x: Math.round(c.x), y: Math.round(c.y - 10) })
    const wa = d.workArea
    const h = Math.max(MIN_H, Math.min(MAX_H, this.height, wa.height - 40))
    const clawdHalf = 7 * c.scale
    const gap = 14
    // Prefer the side of Clawd with more room; sit just above his feet line.
    const leftRoom = c.x - clawdHalf - gap - wa.x
    const x = leftRoom >= WIDTH ? c.x - clawdHalf - gap - WIDTH : Math.min(c.x + clawdHalf + gap, wa.x + wa.width - WIDTH - 8)
    const bottom = Math.min(wa.y + wa.height - 10, c.y - 4)
    const y = Math.max(wa.y + 8, bottom - h)
    this.win.setBounds({ x: Math.round(Math.max(wa.x + 8, x)), y: Math.round(y), width: WIDTH, height: Math.round(h) })
  }

  show(focusInput = true, payload?: Events['panel:focusInput']): void {
    const win = this.win ?? this.create()
    this.place()
    if (!win.isVisible()) win.show()
    win.focus()
    if (focusInput) this.send('panel:focusInput', payload ?? {})
    this.emit('visibility', true)
  }

  hide(): void {
    if (this.win?.isVisible()) {
      this.win.hide()
      this.emit('visibility', false)
    }
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  setPinned(on: boolean): void {
    this.pinned = on
  }

  setHeight(h: number): void {
    this.height = Math.max(MIN_H, Math.min(MAX_H, Math.round(h)))
    if (!this.win) return
    const b = this.win.getBounds()
    const bottom = b.y + b.height
    this.win.setBounds({ x: b.x, y: bottom - this.height, width: WIDTH, height: this.height })
  }

  send<K extends keyof Events>(ch: K, payload: Events[K]): void {
    if (!this.win) return
    if (!this.ready) this.queue.push([ch, payload])
    else this.win.webContents.send(ch, payload)
  }

  /** Pre-creates the window so the first summon opens instantly. */
  warm(): void {
    if (!this.win) this.create()
  }
}
