// Desktop notifications for meaningful events only, with categories, quiet hours, focus-mode
// suppression (permission requests still get through) and de-duplication.

import { Notification } from 'electron'
import { logger } from './log'
import { resourcePath } from './paths'
import type { SettingsStore } from './settings-store'

const log = logger('notify')
export type NotifyCategory = 'taskDone' | 'taskFailed' | 'permission' | 'claudeCode' | 'integration' | 'agent'

function inQuietHours(start: string, end: string, now = new Date()): boolean {
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const t = now.getHours() * 60 + now.getMinutes()
  const a = toMin(start)
  const b = toMin(end)
  return a <= b ? t >= a && t < b : t >= a || t < b
}

export class Notifier {
  private recent = new Map<string, number>()
  /** Set by the app: whether focus mode is on. */
  focus = () => false
  onClick: (taskId?: string) => void = () => {}

  constructor(private settings: SettingsStore) {}

  /** Returns true when the notification was shown. */
  show(category: NotifyCategory, title: string, body: string, opts: { taskId?: string; key?: string; critical?: boolean } = {}): boolean {
    const s = this.settings.get().notifications
    if (!s.enabled || !Notification.isSupported()) return false
    if (category !== 'agent' && !(s as Record<string, unknown>)[category]) return false
    const critical = opts.critical || category === 'permission'
    if (!critical && this.focus()) return false
    if (!critical && s.quietHours && inQuietHours(s.quietStart, s.quietEnd)) return false
    const key = opts.key ?? `${category}:${title}:${body}`
    const last = this.recent.get(key) ?? 0
    if (Date.now() - last < 60_000) return false
    this.recent.set(key, Date.now())
    if (this.recent.size > 200) for (const [k, t] of this.recent) if (Date.now() - t > 300_000) this.recent.delete(k)
    try {
      const n = new Notification({ title, body: body.slice(0, 300), icon: resourcePath('icons', 'clawd-64.png'), silent: !critical })
      n.on('click', () => this.onClick(opts.taskId))
      n.show()
      return true
    } catch (err) {
      log.warn('notification failed', err)
      return false
    }
  }
}

export { inQuietHours }
