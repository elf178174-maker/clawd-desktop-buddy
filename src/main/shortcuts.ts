// Global shortcut registry. Accelerators come only from settings; nothing is hard-coded in UI.

import { globalShortcut } from 'electron'
import { EventEmitter } from 'node:events'
import type { ShortcutStatus } from '../shared/api'
import { checkShortcut, normaliseAccelerator, type ShortcutCheck } from '../shared/keybinds'
import { DEFAULT_SHORTCUTS, SHORTCUT_LABELS, type Settings, type ShortcutAction } from '../shared/settings'
import { logger } from './log'

const log = logger('shortcuts')
const ACTIONS = Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]

export class Shortcuts extends EventEmitter {
  private status = new Map<ShortcutAction, ShortcutStatus>()
  private suspended = false
  private current: Settings['shortcuts'] | null = null

  constructor(private handlers: Record<ShortcutAction, () => void>) {
    super()
  }

  apply(shortcuts: Settings['shortcuts']): ShortcutStatus[] {
    this.current = shortcuts
    globalShortcut.unregisterAll()
    this.status.clear()
    const seen = new Map<string, ShortcutAction>()
    for (const action of ACTIONS) {
      const raw = shortcuts[action]
      const accel = raw ? normaliseAccelerator(raw) : ''
      const st: ShortcutStatus = { action, label: SHORTCUT_LABELS[action], accelerator: accel ?? raw, registered: false }
      if (!raw) st.error = 'Disabled'
      else if (!accel) st.error = 'Invalid shortcut'
      else if (seen.has(accel)) st.error = `Same as "${SHORTCUT_LABELS[seen.get(accel)!]}"`
      else if (!this.suspended) {
        try {
          st.registered = globalShortcut.register(accel, () => this.fire(action))
          if (!st.registered) st.error = 'Another application is already using this shortcut'
        } catch (err) {
          st.error = 'Could not register'
          log.warn('register failed', { action, accel, err: String(err) })
        }
        seen.set(accel, action)
      }
      this.status.set(action, st)
    }
    const list = this.list()
    this.emit('changed', list)
    return list
  }

  private fire(action: ShortcutAction): void {
    log.debug('shortcut', action)
    try {
      this.handlers[action]()
    } catch (err) {
      log.error('shortcut handler failed', { action, err: String(err) })
    }
  }

  list(): ShortcutStatus[] {
    return ACTIONS.map((a) => this.status.get(a)!).filter(Boolean)
  }

  /** While the user records a new shortcut, ours must not fire. */
  setRecording(on: boolean): void {
    this.suspended = on
    if (on) globalShortcut.unregisterAll()
    else if (this.current) this.apply(this.current)
  }

  /** Validates a candidate, including whether another application already owns it. */
  check(action: ShortcutAction, accelerator: string): ShortcutCheck {
    const others = Object.fromEntries(ACTIONS.map((a) => [SHORTCUT_LABELS[a], this.current?.[a] ?? ''])) as Record<string, string>
    const res = checkShortcut(accelerator, others, SHORTCUT_LABELS[action])
    if (!res.ok || !accelerator) return res
    const accel = normaliseAccelerator(accelerator)!
    const mine = ACTIONS.some((a) => this.status.get(a)?.registered && this.status.get(a)?.accelerator === accel)
    if (!mine) {
      // Probe: if registration fails, some other program holds it.
      try {
        const ok = globalShortcut.register(accel, () => {})
        if (ok) globalShortcut.unregister(accel)
        else return { ok: false, error: 'Another application is already using this shortcut.', warnings: res.warnings }
      } catch {
        return { ok: false, error: 'Windows rejected this shortcut.', warnings: res.warnings }
      }
    }
    return res
  }

  dispose(): void {
    globalShortcut.unregisterAll()
  }
}
