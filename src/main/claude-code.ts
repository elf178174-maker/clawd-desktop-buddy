// Claude Code integration through its documented hooks. The installer adds Clawd's own observer
// hook entries next to whatever else is in ~/.claude/settings.json (a backup is made first) and
// removes only its own entries. The tracker turns hook events into per-session states.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { CCInstallStatus } from '../shared/api'
import type { CCSession, CCState } from '../shared/types'
import { logger } from './log'
import { dataPath, resourcePath, writeFileAtomic } from './paths'

const log = logger('claude-code')

/** Events supported by the installed Claude Code (observer-only; no decision points). */
export const CC_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact'] as const
const MARKER = 'clawd-cc-hook.js'
const APPROVAL_PRONE = /^(Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__)/

export function ccSettingsPath(): string {
  if (process.env.CLAWD_CC_SETTINGS) return process.env.CLAWD_CC_SETTINGS
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(dir, 'settings.json')
}

interface HookHandler {
  type: string
  command?: string
  shell?: string
  async?: boolean
  timeout?: number
  [k: string]: unknown
}
interface MatcherGroup {
  matcher?: string
  hooks: HookHandler[]
}
type HookMap = Record<string, MatcherGroup[]>

function nodeRunner(): { exe: string; viaElectron: boolean } {
  const sys = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')
  if (fs.existsSync(sys)) return { exe: sys, viaElectron: false }
  return { exe: process.execPath, viaElectron: true }
}

function hookScriptPath(): string {
  return dataPath('hooks', MARKER)
}

export function hookCommand(event: string): string {
  const { exe, viaElectron } = nodeRunner()
  const script = hookScriptPath()
  const env = viaElectron ? "$env:ELECTRON_RUN_AS_NODE='1'; " : ''
  return `${env}& "${exe}" "${script}" ${event}`
}

export class HookInstaller {
  private read(): { json: Record<string, unknown>; exists: boolean } {
    const file = ccSettingsPath()
    if (!fs.existsSync(file)) return { json: {}, exists: false }
    const raw = fs.readFileSync(file, 'utf8')
    try {
      return { json: JSON.parse(raw) as Record<string, unknown>, exists: true }
    } catch {
      throw new Error(`${file} is not valid JSON; Clawd will not modify it. Fix the file and try again.`)
    }
  }

  status(serverRunning: boolean, lastEventAt?: number): CCInstallStatus {
    const file = ccSettingsPath()
    try {
      const { json } = this.read()
      const hooks = (json.hooks ?? {}) as HookMap
      const events = CC_EVENTS.filter((e) => (hooks[e] ?? []).some((g) => g.hooks?.some((h) => String(h.command ?? '').includes(MARKER))))
      let other = 0
      for (const groups of Object.values(hooks)) for (const g of groups ?? []) other += (g.hooks ?? []).filter((h) => !String(h.command ?? '').includes(MARKER)).length
      return { installed: events.length === CC_EVENTS.length && fs.existsSync(hookScriptPath()), settingsPath: file, events, hookCommand: hookCommand('<Event>'), otherHooks: other, serverRunning, lastEventAt }
    } catch (err) {
      return { installed: false, settingsPath: file, events: [], otherHooks: 0, serverRunning, error: (err as Error).message }
    }
  }

  install(): void {
    // Copy the hook script to a stable location outside the app bundle.
    const script = hookScriptPath()
    fs.mkdirSync(path.dirname(script), { recursive: true })
    fs.copyFileSync(resourcePath('hooks', MARKER), script)
    const file = ccSettingsPath()
    const { json, exists } = this.read()
    if (exists) fs.copyFileSync(file, `${file}.clawd-backup-${Date.now()}`)
    const hooks = ((json.hooks as HookMap | undefined) ?? {}) as HookMap
    for (const ev of CC_EVENTS) {
      const groups = (hooks[ev] ??= [])
      // Drop stale entries of ours (e.g. from an older path), then add the current one. Groups that
      // never held one of ours are left exactly as they were.
      const ours = (g: MatcherGroup) => (g.hooks ?? []).some((h) => String(h.command ?? '').includes(MARKER))
      const cleaned = groups.flatMap((g) => {
        if (!ours(g)) return [g]
        const rest = g.hooks.filter((h) => !String(h.command ?? '').includes(MARKER))
        return rest.length ? [{ ...g, hooks: rest }] : []
      })
      cleaned.push({ matcher: '', hooks: [{ type: 'command', shell: 'powershell', command: hookCommand(ev), async: true, timeout: 5 }] })
      hooks[ev] = cleaned
    }
    json.hooks = hooks
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeFileAtomic(file, JSON.stringify(json, null, 2))
    log.info('Claude Code hooks installed', { file })
  }

  uninstall(): void {
    const file = ccSettingsPath()
    const { json, exists } = this.read()
    if (!exists) return
    fs.copyFileSync(file, `${file}.clawd-backup-${Date.now()}`)
    const hooks = (json.hooks ?? {}) as HookMap
    for (const ev of Object.keys(hooks)) {
      const groups = (hooks[ev] ?? []).flatMap((g) => {
        if (!(g.hooks ?? []).some((h) => String(h.command ?? '').includes(MARKER))) return [g]
        const rest = g.hooks.filter((h) => !String(h.command ?? '').includes(MARKER))
        return rest.length ? [{ ...g, hooks: rest }] : []
      })
      if (groups.length) hooks[ev] = groups
      else delete hooks[ev]
    }
    if (Object.keys(hooks).length) json.hooks = hooks
    else delete json.hooks
    writeFileAtomic(file, JSON.stringify(json, null, 2))
    log.info('Claude Code hooks removed', { file })
  }
}

interface HookEvent {
  event: string
  t: number
  payload: {
    session_id?: string
    transcript_path?: string
    cwd?: string
    tool_name?: string
    tool_input?: { file_path?: string; path?: string; command?: string; description?: string }
    error?: string
    is_interrupt?: boolean
    notification_type?: string
    message?: string
    title?: string
    source?: string
    reason?: string
    permission_mode?: string
    model?: string
    session_title?: string
  }
}

/** Builds and maintains per-session state from hook events (which may arrive out of order). */
export class SessionTracker extends EventEmitter {
  private sessions = new Map<string, CCSession & { lastT: number; approvalTimer?: NodeJS.Timeout; doneTimer?: NodeJS.Timeout; mode?: string }>()
  selected: string | null = null
  lastEventAt: number | undefined
  private staleTimer: NodeJS.Timeout

  constructor() {
    super()
    this.staleTimer = setInterval(() => this.sweep(), 30_000)
  }

  list(): CCSession[] {
    return [...this.sessions.values()]
      .map(({ lastT: _l, approvalTimer: _a, doneTimer: _d, mode: _m, ...s }) => s)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** The session whose state drives Clawd: the selected one, else the most recently active. */
  focus(): CCSession | null {
    const list = this.list().filter((s) => s.state !== 'disconnected')
    return list.find((s) => s.id === this.selected) ?? list[0] ?? null
  }

  select(id: string | null): void {
    this.selected = id
    this.emit('changed', this.list())
  }

  private set(s: CCSession & { lastT: number }, state: CCState, certain = true): void {
    s.state = state
    s.certain = certain
    s.updatedAt = Date.now()
  }

  handle(ev: HookEvent): void {
    const p = ev.payload ?? {}
    const id = p.session_id
    if (!id || typeof id !== 'string') return
    this.lastEventAt = Date.now()
    let s = this.sessions.get(id)
    if (!s) {
      const cwd = p.cwd ?? ''
      s = { id, cwd, project: path.basename(cwd) || cwd || 'Claude Code', state: 'idle', certain: true, startedAt: Date.now(), updatedAt: Date.now(), lastEvent: ev.event, events: 0, toolCount: 0, editedFiles: [], lastT: 0 }
      this.sessions.set(id, s)
    }
    // Hooks run in parallel processes; ignore events older than what we already applied.
    if (ev.t && ev.t < s.lastT - 50 && ev.event !== 'PostToolUse' && ev.event !== 'PostToolUseFailure') return
    s.lastT = Math.max(s.lastT, ev.t || Date.now())
    s.events++
    s.lastEvent = ev.event
    if (p.transcript_path) s.transcriptPath = p.transcript_path
    if (p.cwd) {
      s.cwd = p.cwd
      s.project = path.basename(p.cwd) || p.cwd
    }
    if (p.model) s.model = p.model
    if (p.session_title) s.title = p.session_title
    if (p.permission_mode) s.mode = p.permission_mode
    if (s.approvalTimer) clearTimeout(s.approvalTimer)
    if (s.doneTimer) clearTimeout(s.doneTimer)
    const prev = s.state
    switch (ev.event) {
      case 'SessionStart':
        this.set(s, 'idle')
        s.message = p.source ? `Session ${p.source}` : undefined
        break
      case 'UserPromptSubmit':
        this.set(s, 'processing')
        s.lastError = undefined
        s.message = undefined
        break
      case 'PreToolUse': {
        this.set(s, 'tool')
        s.tool = p.tool_name
        s.toolCount++
        // If a tool that usually needs approval does not complete quickly, Clawd assumes a prompt.
        const auto = s.mode === 'bypassPermissions' || s.mode === 'acceptEdits' || s.mode === 'dontAsk' || s.mode === 'auto'
        if (p.tool_name && APPROVAL_PRONE.test(p.tool_name) && !auto) {
          const sess = s
          sess.approvalTimer = setTimeout(() => {
            if (sess.state === 'tool' && sess.tool === p.tool_name) {
              this.set(sess, 'waiting_approval', false)
              sess.message = `Possibly waiting for approval to use ${p.tool_name}`
              this.changed(sess, 'tool')
            }
          }, 4500)
        }
        break
      }
      case 'PostToolUse':
        this.set(s, 'processing')
        if (p.tool_input?.file_path && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(p.tool_name ?? '')) {
          const f = p.tool_input.file_path
          s.editedFiles = [...s.editedFiles.filter((x) => x !== f), f].slice(-30)
          this.emit('edited', s, f)
        }
        break
      case 'PostToolUseFailure':
        this.set(s, 'processing')
        if (!p.is_interrupt) {
          s.lastError = `${p.tool_name ?? 'Tool'}: ${p.error ?? 'failed'}`
          this.emit('toolError', s)
        }
        break
      case 'Notification':
        if (p.notification_type === 'permission_prompt') {
          this.set(s, 'waiting_approval')
          s.message = p.message
        } else if (p.notification_type === 'idle_prompt' || p.notification_type === 'elicitation_dialog' || p.notification_type === 'agent_needs_input') {
          this.set(s, 'waiting_input')
          s.message = p.message
        }
        break
      case 'Stop': {
        this.set(s, 'completed')
        s.tool = undefined
        const sess = s
        sess.doneTimer = setTimeout(() => {
          if (sess.state === 'completed') {
            this.set(sess, 'idle')
            this.changed(sess, 'completed')
          }
        }, 25_000)
        break
      }
      case 'StopFailure':
        this.set(s, 'failed')
        s.lastError = p.error ?? 'The turn ended because of an API error.'
        break
      case 'SubagentStart':
      case 'SubagentStop':
        if (s.state !== 'tool') this.set(s, 'processing')
        break
      case 'PreCompact':
        this.set(s, 'processing')
        s.message = 'Compacting context'
        break
      case 'PostCompact':
        s.message = undefined
        break
      case 'SessionEnd': {
        this.set(s, 'disconnected')
        const gone = s.id
        setTimeout(() => {
          const x = this.sessions.get(gone)
          if (x && x.state === 'disconnected') {
            this.sessions.delete(gone)
            if (this.selected === gone) this.selected = null
            this.emit('changed', this.list())
          }
        }, 60_000)
        break
      }
    }
    this.changed(s, prev)
  }

  private changed(s: CCSession, prev: CCState): void {
    this.emit('changed', this.list())
    if (prev !== s.state) this.emit('state', s, prev)
  }

  /** Long silence while "processing" becomes "unknown" rather than a guess. */
  private sweep(): void {
    const now = Date.now()
    for (const s of this.sessions.values()) {
      const quiet = now - s.updatedAt
      if ((s.state === 'processing' || s.state === 'tool') && quiet > 10 * 60_000) {
        const prev = s.state
        this.set(s, 'unknown', false)
        s.message = 'No events for 10 minutes'
        this.changed(s, prev)
      } else if (s.state === 'idle' && quiet > 6 * 3600_000) {
        this.sessions.delete(s.id)
        this.emit('changed', this.list())
      }
    }
  }

  dispose(): void {
    clearInterval(this.staleTimer)
  }
}
