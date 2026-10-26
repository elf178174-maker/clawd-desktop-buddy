// Occasional, dismissible quick-action suggestions shown in Clawd's speech bubble. They are rare by
// design: global rate limits, per-kind switches, a 24 h memory of dismissals, and silence in focus
// mode or while Clawd is busy. Nothing is sent to a model unless the user clicks an action.

import crypto from 'node:crypto'
import { logger } from './log'
import type { Companion } from './companion'
import type { SettingsStore } from './settings-store'

const log = logger('suggest')
export type SuggestionKind = 'errors' | 'articles' | 'selection' | 'builds' | 'clipboard'

export interface Suggestion {
  kind: SuggestionKind
  /** Stable key used for de-duplication and "not now". */
  key: string
  text: string
  actions: { id: string; label: string; primary?: boolean }[]
  run: (actionId: string) => void
}

export class Suggestions {
  private lastShown = 0
  private dismissed = new Map<string, number>()
  private seen = new Set<string>()
  private current: { bubbleId: string; s: Suggestion } | null = null
  /** Set by the app: true while Clawd is working, listening or the panel is open. */
  busy = () => false

  constructor(
    private settings: SettingsStore,
    private companion: Companion,
  ) {}

  static keyOf(...parts: string[]): string {
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)
  }

  offer(s: Suggestion): boolean {
    const cfg = this.settings.get().suggestions
    if (!cfg.enabled || !cfg[s.kind]) return false
    if (this.companion.state.focus || this.companion.state.visibility === 'hidden' || this.busy()) return false
    const gap = cfg.frequency === 'normal' ? 4 * 60_000 : 15 * 60_000
    if (Date.now() - this.lastShown < gap) return false
    const dis = this.dismissed.get(s.key)
    if (dis && Date.now() - dis < 24 * 3600_000) return false
    if (this.seen.has(s.key)) return false
    this.seen.add(s.key)
    this.lastShown = Date.now()
    const bubbleId = this.companion.bubble(s.text, { actions: [...s.actions, { id: 'dismiss', label: 'Not now' }], ttl: 14, tone: 'normal' })
    this.current = { bubbleId, s }
    log.info('suggestion shown', { kind: s.kind })
    return true
  }

  /** Bubble button pressed. Returns true if it belonged to a suggestion. */
  handleAction(bubbleId: string, actionId: string): boolean {
    if (!this.current || this.current.bubbleId !== bubbleId) return false
    const s = this.current.s
    this.current = null
    if (actionId === 'dismiss') this.dismissed.set(s.key, Date.now())
    else s.run(actionId)
    return true
  }
}

/** Light-weight local classification of copied text (no model involved). */
export function classifyClip(text: string): 'code' | 'error' | 'url' | 'prose' | 'short' {
  const t = text.trim()
  if (t.length < 40) return /^https?:\/\/\S+$/.test(t) ? 'url' : 'short'
  if (/^https?:\/\/\S+$/.test(t)) return 'url'
  if (/(Traceback \(most recent call last\)|Exception|Error:|error TS\d+|at .+\(.+:\d+:\d+\)|ERR!|FATAL|Unhandled|stack trace|panicked at|Segmentation fault)/.test(t)) return 'error'
  const codeSignals = (t.match(/[{};=<>()[\]]|=>|\bfunction\b|\bconst\b|\bdef\b|\bclass\b|\bimport\b|\breturn\b|^\s{2,}\S/gm) ?? []).length
  if (codeSignals / Math.max(1, t.split('\n').length) > 1.5) return 'code'
  return 'prose'
}
