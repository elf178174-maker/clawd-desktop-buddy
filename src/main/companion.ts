// The companion controller: one source of truth for what Clawd is doing on screen. Everything that
// affects his behaviour (agent phase, voice, Claude Code, focus, visibility) funnels through here.

import { EventEmitter } from 'node:events'
import type { Bubble, PointRequest } from '../shared/api'
import type { AgentPhase, CCState, CompanionState, Visibility } from '../shared/types'
import { logger } from './log'
import type { SettingsStore } from './settings-store'
import type { OverlayManager } from './windows/overlay'

const log = logger('companion')

export class Companion extends EventEmitter {
  private s: CompanionState = {
    visibility: 'hidden',
    focus: false,
    agent: 'idle',
    cc: null,
    listening: false,
    speaking: false,
    panelOpen: false,
    needsUser: false,
  }
  private lastActivity = Date.now()
  private idleTimer: NodeJS.Timeout
  private bubbleSeq = 0

  constructor(
    private overlays: OverlayManager,
    private settings: SettingsStore,
  ) {
    super()
    this.s.focus = settings.get().focus.active
    this.idleTimer = setInterval(() => this.checkIdle(), 15_000)
  }

  get state(): CompanionState {
    return this.s
  }

  private update(patch: Partial<CompanionState>): void {
    const next = { ...this.s, ...patch }
    if (JSON.stringify(next) === JSON.stringify(this.s)) return
    this.s = next
    this.overlays.setState(next)
    this.emit('state', next)
  }

  /** Any deliberate interaction with Clawd resets the auto-hide timer. */
  touch(): void {
    this.lastActivity = Date.now()
  }

  private checkIdle(): void {
    const minutes = this.settings.get().general.hideAfterIdleMinutes
    if (!minutes || this.s.visibility === 'hidden') return
    const busy = this.s.agent !== 'idle' && this.s.agent !== 'done' && this.s.agent !== 'error' && this.s.agent !== 'cancelled'
    if (busy || this.s.panelOpen || this.s.listening || this.s.speaking || this.s.needsUser) return
    if (Date.now() - this.lastActivity > minutes * 60_000) {
      log.info('hiding after inactivity')
      this.setVisibility('hidden')
    }
  }

  setVisibility(v: Visibility): void {
    if (v !== 'hidden') this.touch()
    this.update({ visibility: v })
  }

  /** Brings Clawd back (with his entrance) and lets the caller open the panel. */
  summon(): void {
    this.touch()
    if (this.s.visibility === 'hidden') this.update({ visibility: 'summoned' })
    else this.overlays.send('overlay:play', { name: 'interrupt' })
  }

  hide(): void {
    this.update({ visibility: 'hidden', panelOpen: false })
  }

  toggleVisible(): void {
    if (this.s.visibility === 'hidden') this.setVisibility('present')
    else this.hide()
  }

  setAgent(phase: AgentPhase): void {
    const prev = this.s.agent
    this.update({ agent: phase })
    // One-shot reactions to how a task ended.
    if (prev !== phase) {
      if (phase === 'done' && (prev === 'working' || prev === 'thinking' || prev === 'speaking')) this.play('celebrate')
      if (phase === 'error') this.play('error')
      if (phase === 'cancelled') this.play('interrupt')
      if (phase === 'waiting_user') this.play('confused')
    }
  }

  setListening(on: boolean): void {
    if (on) this.touch()
    this.update({ listening: on })
  }

  setSpeaking(on: boolean): void {
    this.update({ speaking: on })
  }

  setLevel(level: number): void {
    this.overlays.send('overlay:level', level)
  }

  setCC(state: CCState | null): void {
    const prev = this.s.cc
    this.update({ cc: state })
    if (prev !== state) {
      if (state === 'completed' && prev && prev !== 'idle') this.play('celebrate')
      if (state === 'failed') this.play('error')
      if ((state === 'tool' || state === 'processing') && (!prev || prev === 'idle' || prev === 'completed' || prev === 'disconnected')) this.play('hop')
    }
  }

  setNeedsUser(on: boolean): void {
    this.update({ needsUser: on })
  }

  setFocus(on: boolean): void {
    this.update({ focus: on })
  }

  setPanelOpen(on: boolean): void {
    if (on) this.touch()
    this.update({ panelOpen: on })
  }

  play(name: string, params?: Record<string, number>): void {
    if (this.s.visibility === 'hidden') return
    this.overlays.send('overlay:play', { name, params })
  }

  bubble(text: string, opts: Omit<Bubble, 'id' | 'text'> = {}): string {
    const id = `b${++this.bubbleSeq}`
    this.overlays.send('overlay:bubble', { id, text, ttl: 6, ...opts })
    return id
  }

  clearBubble(): void {
    this.overlays.send('overlay:bubble', null)
  }

  /** Points Clawd's cursor at a screen rectangle (DIP). Returns false if it is not on his display. */
  point(rect: { x: number; y: number; w: number; h: number }, label?: string, hold?: number, click = false): boolean {
    const box = this.overlays.toHome(rect)
    if (!box) return false
    const req: PointRequest = { box, label, hold, click }
    if (this.s.visibility === 'hidden') this.setVisibility('present')
    this.overlays.send('overlay:point', req)
    return true
  }

  /** Marks Clawd as controlling the keyboard/mouse (edge glow); turns itself off after a pause. */
  control(): void {
    if (this.controlTimer) clearTimeout(this.controlTimer)
    else this.overlays.send('overlay:control', true)
    this.controlTimer = setTimeout(() => {
      this.controlTimer = null
      this.overlays.send('overlay:control', false)
    }, 2500)
  }
  private controlTimer: NodeJS.Timeout | null = null

  glance(screenX: number, screenY: number, seconds = 1.6): void {
    const box = this.overlays.toHome({ x: screenX, y: screenY, w: 0, h: 0 })
    if (box) this.overlays.send('overlay:glance', { x: box.x, y: box.y, seconds })
  }

  dispose(): void {
    clearInterval(this.idleTimer)
  }
}
