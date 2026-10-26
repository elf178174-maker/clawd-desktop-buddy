// Focus mode: manual, on a schedule, or while chosen applications are in front.

import { EventEmitter } from 'node:events'
import type { SettingsStore } from './settings-store'

export function scheduleActive(days: number[], start: string, end: string, now = new Date()): boolean {
  if (!days.includes(now.getDay())) return false
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const t = now.getHours() * 60 + now.getMinutes()
  const a = toMin(start)
  const b = toMin(end)
  return a <= b ? t >= a && t < b : t >= a || t < b
}

export class FocusMode extends EventEmitter {
  private foregroundApp = ''
  private active = false
  private timer: NodeJS.Timeout

  constructor(private settings: SettingsStore) {
    super()
    this.timer = setInterval(() => this.evaluate(), 30_000)
    settings.onChange((n, p) => {
      if (JSON.stringify(n.focus) !== JSON.stringify(p.focus)) this.evaluate()
    })
    this.evaluate()
  }

  setForeground(process: string): void {
    this.foregroundApp = process
    if (this.settings.get().focus.trigger === 'apps') this.evaluate()
  }

  /** Manual toggle (from the shortcut, tray or settings). */
  toggle(): void {
    const f = this.settings.get().focus
    this.settings.set({ focus: { active: !this.active, trigger: f.trigger === 'manual' ? 'manual' : f.trigger } })
    // A manual toggle overrides schedule/app triggers until the next change of that trigger.
    if (f.trigger !== 'manual') {
      this.active = !this.active
      this.emit('change', this.active)
    }
  }

  get isActive(): boolean {
    return this.active
  }

  evaluate(): void {
    const f = this.settings.get().focus
    let next = f.active
    if (f.trigger === 'schedule') next = f.active || scheduleActive(f.days, f.start, f.end)
    if (f.trigger === 'apps') next = f.active || f.apps.some((a) => a.toLowerCase() === this.foregroundApp.toLowerCase())
    if (next !== this.active) {
      this.active = next
      this.emit('change', next)
    }
  }

  dispose(): void {
    clearInterval(this.timer)
  }
}
