// Overlay windows: one transparent, click-through, always-on-top window per display work area.
// Clawd lives in the overlay of his "home" display; other overlays exist only while he points there.

import { BrowserWindow, ipcMain, screen, type Display } from 'electron'
import { EventEmitter } from 'node:events'
import type { OverlayEvents, OverlayInit, OverlaySends } from '../../shared/api'
import type { Settings } from '../../shared/settings'
import type { CompanionState } from '../../shared/types'
import { logger } from '../log'
import type { SettingsStore } from '../settings-store'
import { loadPage, secureWindow } from './common'

const log = logger('overlay')

interface OverlayWin {
  win: BrowserWindow
  display: Display
  ready: boolean
  interactive: boolean
  queue: [string, unknown][]
}

export interface Anchor {
  x: number
  y: number
  onEdge: boolean
}

export class OverlayManager extends EventEmitter {
  private overlays = new Map<number, OverlayWin>()
  private homeId = 0
  private state: CompanionState | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private lastPointer = { x: NaN, y: NaN, still: 0 }
  private topmostTimer: NodeJS.Timeout | null = null
  perf: { fps: number; frameMs: number } | null = null
  /** Extra space at the bottom of each display taken by third-party bars (DIP). */
  private bottomInset = new Map<number, number>()

  constructor(private settings: SettingsStore) {
    super()
    ipcMain.on('overlay:ready', (e) => this.onReady(e.sender.id))
    ipcMain.on('overlay:interactive', (e, on: OverlaySends['overlay:interactive']) => this.setInteractive(e.sender.id, !!on))
    ipcMain.on('overlay:drag', (e, d: OverlaySends['overlay:drag']) => this.onDrag(e.sender.id, d))
    ipcMain.on('overlay:interaction', (_e, i: OverlaySends['overlay:interaction']) => this.emit('interaction', i))
    ipcMain.on('overlay:perf', (_e, p: OverlaySends['overlay:perf']) => (this.perf = p))
    ipcMain.on('bubble:action', (_e, a: { bubbleId: string; actionId: string }) => this.emit('bubbleAction', a))
    screen.on('display-added', () => this.rebuild())
    screen.on('display-removed', () => this.rebuild())
    screen.on('display-metrics-changed', (_e, d, changed) => {
      if (changed.some((c) => c === 'workArea' || c === 'bounds' || c === 'scaleFactor')) this.relayout(d)
    })
  }

  /** The display Clawd lives on, falling back to the primary display. */
  homeDisplay(s: Settings = this.settings.get()): Display {
    const all = screen.getAllDisplays()
    const want = s.companion.display
    return (want !== 'primary' && all.find((d) => String(d.id) === want)) || screen.getPrimaryDisplay()
  }

  setBottomInsets(insets: Map<number, number>): void {
    const changed = [...insets].some(([id, v]) => (this.bottomInset.get(id) ?? 0) !== v) || [...this.bottomInset.keys()].some((id) => !insets.has(id))
    this.bottomInset = insets
    if (!changed) return
    const s = this.settings.get()
    for (const o of this.overlays.values()) if (o.ready) o.win.webContents.send('overlay:init', this.initFor(o, s))
  }

  anchorFor(display: Display, s: Settings = this.settings.get()): Anchor {
    const inset = this.bottomInset.get(display.id) ?? 0
    const wa = { ...display.workArea, height: display.workArea.height - inset }
    const size = s.companion.size
    const margin = 8 * size
    const clampX = (x: number) => Math.max(margin, Math.min(wa.width - margin, x))
    const off = s.companion.edgeOffset
    switch (s.companion.corner) {
      case 'bottom-left':
        return { x: clampX(off), y: wa.height, onEdge: true }
      case 'top-right':
        return { x: clampX(wa.width - off), y: Math.round(14 * size + 24), onEdge: false }
      case 'top-left':
        return { x: clampX(off), y: Math.round(14 * size + 24), onEdge: false }
      case 'custom': {
        const y = Math.max(12 * size, Math.min(wa.height, s.companion.customY * wa.height))
        return { x: clampX(s.companion.customX * wa.width), y, onEdge: y >= wa.height - 1 }
      }
      default:
        return { x: clampX(wa.width - off), y: wa.height, onEdge: true }
    }
  }

  start(): void {
    this.homeId = this.homeDisplay().id
    this.ensure(this.homeId)
    this.pollTimer = setInterval(() => this.pollPointer(), 16)
    // Some apps grab the topmost band; re-assert ours now and then.
    this.topmostTimer = setInterval(() => this.reassertTop(), 4000)
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.topmostTimer) clearInterval(this.topmostTimer)
    for (const o of this.overlays.values()) o.win.destroy()
    this.overlays.clear()
  }

  private ensure(displayId: number): OverlayWin {
    const existing = this.overlays.get(displayId)
    if (existing && !existing.win.isDestroyed()) return existing
    const display = screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay()
    const wa = display.workArea
    const win = secureWindow({
      x: wa.x,
      y: wa.y,
      width: wa.width,
      height: wa.height,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      type: 'toolbar',
      title: 'Clawd',
      backgroundColor: '#00000000',
      webPreferences: { backgroundThrottling: false, spellcheck: false },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setIgnoreMouseEvents(true, { forward: true })
    win.setVisibleOnAllWorkspaces(true)
    const o: OverlayWin = { win, display, ready: false, interactive: false, queue: [] }
    this.overlays.set(display.id, o)
    win.on('closed', () => this.overlays.delete(display.id))
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error('overlay renderer crashed; restarting', details)
      this.overlays.delete(display.id)
      if (!win.isDestroyed()) win.destroy()
      setTimeout(() => {
        const n = this.ensure(display.id)
        n.win.showInactive()
      }, 500)
    })
    void loadPage(win, 'overlay')
    return o
  }

  private onReady(senderId: number): void {
    for (const o of this.overlays.values()) {
      if (o.win.webContents.id !== senderId) continue
      o.ready = true
      const s = this.settings.get()
      const isHome = o.display.id === this.homeId
      const a = this.anchorFor(o.display, s)
      const init: OverlayInit = {
        width: o.display.workArea.width,
        height: o.display.workArea.height,
        settings: s,
        anchor: { x: a.x, y: a.y },
        onScreenEdge: a.onEdge,
        reducedMotion: false,
      }
      o.win.webContents.send('overlay:init', init)
      if (this.state) o.win.webContents.send('overlay:state', isHome ? this.state : { ...this.state, visibility: 'hidden' })
      for (const [ch, p] of o.queue) o.win.webContents.send(ch, p)
      o.queue = []
      if (isHome && this.state?.visibility !== 'hidden') o.win.showInactive()
      this.emit('ready', o.display.id)
    }
  }

  private home(): OverlayWin {
    return this.ensure(this.homeId)
  }

  private sendTo<K extends keyof OverlayEvents>(o: OverlayWin, ch: K, payload: OverlayEvents[K]): void {
    if (o.win.isDestroyed()) return
    if (!o.ready) o.queue.push([ch, payload])
    else o.win.webContents.send(ch, payload)
  }

  send<K extends keyof OverlayEvents>(ch: K, payload: OverlayEvents[K]): void {
    this.sendTo(this.home(), ch, payload)
  }

  setState(s: CompanionState): void {
    const prevHidden = this.state?.visibility === 'hidden'
    this.state = s
    const o = this.home()
    if (s.visibility !== 'hidden' && !o.win.isVisible()) o.win.showInactive()
    this.sendTo(o, 'overlay:state', s)
    // Hide the window once the exit animation has finished, so nothing is composited while hidden.
    if (s.visibility === 'hidden' && !prevHidden) {
      setTimeout(() => {
        if (this.state?.visibility === 'hidden' && !o.win.isDestroyed()) {
          o.win.hide()
          this.setInteractiveWin(o, false)
        }
      }, 1300)
    }
  }

  /** Re-applies settings that affect placement or look. */
  applySettings(prev: Settings, next: Settings): void {
    const moved =
      prev.companion.display !== next.companion.display ||
      prev.companion.corner !== next.companion.corner ||
      prev.companion.edgeOffset !== next.companion.edgeOffset ||
      prev.companion.size !== next.companion.size ||
      (next.companion.corner === 'custom' && (prev.companion.customX !== next.companion.customX || prev.companion.customY !== next.companion.customY))
    const newHome = this.homeDisplay(next).id
    if (newHome !== this.homeId) {
      this.rehome(newHome)
      return
    }
    for (const o of this.overlays.values()) o.ready && o.win.webContents.send('overlay:init', this.initFor(o, next))
    if (moved) {
      const a = this.anchorFor(this.home().display, next)
      this.send('overlay:anchor', { x: a.x, y: a.y, animate: 'none' })
    }
  }

  private initFor(o: OverlayWin, s: Settings): OverlayInit {
    const a = this.anchorFor(o.display, s)
    return {
      width: o.display.workArea.width,
      height: o.display.workArea.height,
      settings: s,
      anchor: { x: a.x, y: a.y },
      onScreenEdge: a.onEdge,
      reducedMotion: false,
    }
  }

  private rehome(displayId: number): void {
    const old = this.overlays.get(this.homeId)
    this.homeId = displayId
    if (old && old.display.id !== displayId) {
      old.win.webContents.send('overlay:state', { ...(this.state as CompanionState), visibility: 'hidden' })
      setTimeout(() => !old.win.isDestroyed() && old.win.hide(), 400)
    }
    const o = this.ensure(displayId)
    if (o.ready) {
      o.win.webContents.send('overlay:init', this.initFor(o, this.settings.get()))
      if (this.state) o.win.webContents.send('overlay:state', this.state)
      if (this.state?.visibility !== 'hidden') o.win.showInactive()
    }
  }

  private rebuild(): void {
    // Displays changed: drop overlays for vanished displays and re-home if needed.
    const ids = new Set(screen.getAllDisplays().map((d) => d.id))
    for (const [id, o] of this.overlays) {
      if (!ids.has(id)) {
        o.win.destroy()
        this.overlays.delete(id)
      }
    }
    const want = this.homeDisplay().id
    if (want !== this.homeId || !this.overlays.has(want)) this.rehome(want)
  }

  private relayout(d: Display): void {
    const o = this.overlays.get(d.id)
    if (!o) return
    o.display = d
    o.win.setBounds(d.workArea)
    if (o.ready) o.win.webContents.send('overlay:init', this.initFor(o, this.settings.get()))
  }

  private reassertTop(): void {
    const o = this.overlays.get(this.homeId)
    if (o && o.win.isVisible()) {
      o.win.setAlwaysOnTop(true, 'screen-saver')
      o.win.moveTop()
    }
  }

  private setInteractive(senderId: number, on: boolean): void {
    for (const o of this.overlays.values()) if (o.win.webContents.id === senderId) this.setInteractiveWin(o, on)
  }

  private setInteractiveWin(o: OverlayWin, on: boolean): void {
    if (o.interactive === on || o.win.isDestroyed()) return
    o.interactive = on
    const mode = this.settings.get().companion.clickThrough
    if (mode === 'never' && on) o.win.setIgnoreMouseEvents(false)
    else o.win.setIgnoreMouseEvents(!on, { forward: true })
  }

  private pollPointer(): void {
    const o = this.overlays.get(this.homeId)
    if (!o || !o.ready || !o.win.isVisible() || this.state?.visibility === 'hidden') return
    const p = screen.getCursorScreenPoint()
    const wa = o.display.workArea
    const moved = p.x !== this.lastPointer.x || p.y !== this.lastPointer.y
    if (moved) {
      this.lastPointer = { x: p.x, y: p.y, still: 0 }
      o.win.webContents.send('overlay:pointer', { x: p.x - wa.x, y: p.y - wa.y, moving: true })
      this.emit('pointerActivity')
    } else if (++this.lastPointer.still === 30) {
      o.win.webContents.send('overlay:pointer', { x: p.x - wa.x, y: p.y - wa.y, moving: false })
    }
  }

  private onDrag(senderId: number, d: OverlaySends['overlay:drag']): void {
    if (d.phase !== 'end') return
    const from = [...this.overlays.values()].find((o) => o.win.webContents.id === senderId)
    if (!from) return
    const pt = screen.getCursorScreenPoint()
    const target = screen.getDisplayNearestPoint(pt)
    const s = this.settings.get()
    const wa = target.workArea
    const fx = Math.max(0, Math.min(1, (pt.x - wa.x) / wa.width))
    const dropY = pt.y - wa.y
    // Feet land roughly where the cursor held his middle.
    const feetY = Math.max(10 * s.companion.size, Math.min(wa.height, dropY + 4 * s.companion.size))
    const groundY = s.companion.gravity ? wa.height : feetY
    const fy = groundY / wa.height
    this.settings.set({ companion: { display: String(target.id), corner: 'custom', customX: fx, customY: fy } })
    if (target.id === from.display.id) {
      this.send('overlay:anchor', { x: fx * wa.width, y: groundY, animate: s.companion.gravity && groundY > feetY + 2 ? 'fall' : 'none' })
    }
    this.emit('moved', { display: target.id, x: fx, y: fy })
  }

  /** Converts a screen rectangle (DIP) to the home overlay's coordinates; null if on another display. */
  toHome(rect: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } | null {
    const o = this.overlays.get(this.homeId)
    if (!o) return null
    const wa = o.display.workArea
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2
    if (cx < wa.x || cx > wa.x + wa.width || cy < wa.y || cy > wa.y + wa.height) return null
    return { x: rect.x - wa.x, y: rect.y - wa.y, w: rect.w, h: rect.h }
  }

  /** Clawd's on-screen position (DIP), for anchoring the panel. */
  clawdScreenPoint(): { x: number; y: number; display: Display } {
    const o = this.home()
    const a = this.anchorFor(o.display)
    return { x: o.display.workArea.x + a.x, y: o.display.workArea.y + a.y, display: o.display }
  }

  homeWindow(): BrowserWindow | null {
    return this.overlays.get(this.homeId)?.win ?? null
  }

  allWindows(): BrowserWindow[] {
    return [...this.overlays.values()].map((o) => o.win)
  }
}
