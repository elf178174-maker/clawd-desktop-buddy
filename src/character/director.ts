// Maps what the app is doing (agent phase, voice, Claude Code, visibility) onto Clawd's animation
// states. The base state is always derived from the current app state, so a cancelled task or a
// missed event can never leave him stuck in an animation.

import type { CompanionState } from '../shared/types'
import type { ClawdEngine } from './engine'
import type { StateName } from './states'

export interface DirectorOptions {
  laptopProp: boolean
  focusIntensity: number
}

export function baseStateFor(s: CompanionState, opts: DirectorOptions): [StateName, Record<string, number>] {
  if (s.visibility === 'hidden') return ['hidden', {}]
  if (s.needsUser) return ['permission', {}]
  if (s.listening) return ['listen', {}]
  if (s.speaking) return ['speak', {}]
  if (s.agent === 'thinking') return ['think', {}]
  if (s.agent === 'working') return ['work', {}]
  if (s.agent === 'waiting_permission' || s.agent === 'waiting_user') return ['permission', {}]
  switch (s.cc) {
    case 'waiting_approval':
    case 'waiting_input':
      return ['attention', { laptop: opts.laptopProp ? 1 : 0 }]
    case 'tool':
      return opts.laptopProp ? ['type', {}] : ['work', {}]
    case 'processing':
    case 'active':
      return opts.laptopProp ? ['waitCC', {}] : ['think', {}]
    default:
      break
  }
  return ['idle', {}]
}

export class Director {
  private last: CompanionState | null = null

  constructor(
    private engine: ClawdEngine,
    private opts: DirectorOptions,
  ) {}

  configure(opts: Partial<DirectorOptions>): void {
    Object.assign(this.opts, opts)
    if (this.last) this.apply(this.last)
  }

  /** Applies a new app state; plays entrance/exit one-shots on visibility changes. */
  apply(s: CompanionState, edge = true): void {
    const prev = this.last
    this.last = s
    const [base, params] = baseStateFor(s, this.opts)
    const wasHidden = !prev || prev.visibility === 'hidden'
    if (s.visibility === 'hidden') {
      if (!wasHidden) this.engine.play('leave', { edge: edge ? 1 : 0 })
      this.engine.setBase('hidden')
      return
    }
    this.engine.setBase(base, params)
    if (wasHidden) this.engine.play('enter', { edge: edge ? 1 : 0 })
    else if (prev && prev.listening && !s.listening && s.agent === 'idle' && !s.speaking) this.engine.nudge()
  }

  get state(): CompanionState | null {
    return this.last
  }
}
