// The permission broker: decides whether a tool call may run, must be confirmed, or is denied.
// Consequential actions after untrusted content entered the task always need a human, whatever
// the rules say: that is the main defence against prompt injection.

import path from 'node:path'
import type { Settings } from '../shared/settings'
import type { PermissionDecision, PermissionDecisionRecord, PermissionRequest, TaskRecord } from '../shared/types'
import { newId, readJson, writeJson } from './store'
import type { AnyTool, Risk } from './tools/types'

export interface Verdict {
  action: 'allow' | 'ask' | 'deny'
  reasons: string[]
  risk: Risk
  /** Whether "always allow" may be offered. */
  allowAlways: boolean
}

interface AlwaysRule {
  tool: string
  /** Optional scope: a folder for file tools, a command prefix for commands. */
  scope?: string
  createdAt: number
}

export interface PermissionInput {
  tool: AnyTool
  args: Record<string, unknown>
  risk: Risk
  extraReasons: string[]
  task: TaskRecord
  settings: Settings
  /** Untrusted content (web, files, clipboard, other apps) has entered this task. */
  tainted: boolean
  /** The model is hosted (not local) and the tool returns the user's context. */
  sendsToCloud: boolean
  /** Categories the user allowed "for this task". */
  taskGrants: Set<string>
}

export class PermissionBroker {
  private file: string
  private historyFile: string
  private rules: AlwaysRule[]
  private history: PermissionDecisionRecord[]

  constructor(dir: string) {
    this.file = path.join(dir, 'permission-rules.json')
    this.historyFile = path.join(dir, 'permission-history.json')
    this.rules = readJson<AlwaysRule[]>(this.file, [])
    this.history = readJson<PermissionDecisionRecord[]>(this.historyFile, [])
  }

  private scopeOf(tool: AnyTool, args: Record<string, unknown>): string | undefined {
    const p = (args.path ?? args.to ?? args.cwd) as string | undefined
    if (p && tool.category.startsWith('files')) return path.dirname(path.resolve(String(p))).toLowerCase()
    if (tool.name === 'run_command') return String(args.command ?? '').trim().split(/\s+/)[0]?.toLowerCase()
    return undefined
  }

  private matchesAlways(tool: AnyTool, args: Record<string, unknown>): boolean {
    const scope = this.scopeOf(tool, args)
    return this.rules.some((r) => r.tool === tool.name && (!r.scope || (scope !== undefined && (scope === r.scope || scope.startsWith(r.scope + path.sep)))))
  }

  decide(i: PermissionInput): Verdict {
    const { tool, settings } = i
    if (tool.category === 'meta') return { action: 'allow', reasons: [], risk: 'low', allowAlways: false }
    const rule = settings.permissions.rules[tool.category]
    if (rule === 'deny') return { action: 'deny', reasons: [`"${tool.category}" actions are set to Deny in Settings > Permissions`], risk: i.risk, allowAlways: false }
    const reasons = [...i.extraReasons]
    if (i.tainted && i.risk !== 'low') reasons.push('Clawd has read outside content (web, files or other apps) during this task')
    if (i.sendsToCloud && settings.privacy.cloudContext === 'ask' && !i.taskGrants.has('cloud:' + tool.category))
      reasons.push(`the result will be sent to a hosted AI model (${i.task.model.provider})`)
    // Commands are never covered by an always-rule: a rule for one command line would cover others.
    const allowAlways = i.risk !== 'high' && !i.tainted && tool.category !== 'shell'
    // High-risk actions always ask, as do actions with special reasons.
    if (i.risk === 'high') return { action: 'ask', reasons: reasons.length ? reasons : ['this action is hard to undo'], risk: i.risk, allowAlways: false }
    if (reasons.length) {
      // Task-level grants and always-rules cover routine reasons but never taint.
      const coverable = !i.tainted && !reasons.some((r) => r.includes('protected') || r.includes('credentials') || r.includes('hosted AI'))
      if (coverable && (i.taskGrants.has(tool.category) || this.matchesAlways(tool, i.args))) return { action: 'allow', reasons, risk: i.risk, allowAlways }
      return { action: 'ask', reasons, risk: i.risk, allowAlways }
    }
    if (rule === 'allow' || i.taskGrants.has(tool.category) || this.matchesAlways(tool, i.args)) return { action: 'allow', reasons, risk: i.risk, allowAlways }
    return { action: 'ask', reasons: [`"${tool.category}" actions are set to Ask`], risk: i.risk, allowAlways }
  }

  buildRequest(i: PermissionInput, v: Verdict): PermissionRequest {
    const d = i.tool.describe(i.args)
    return {
      id: newId('perm'),
      taskId: i.task.id,
      tool: i.tool.name,
      category: i.tool.category as PermissionRequest['category'],
      title: d.title,
      details: d.details,
      risk: v.risk,
      reasons: v.reasons,
      allowAlways: v.allowAlways,
      createdAt: Date.now(),
    }
  }

  record(req: { id: string; tool: string; category: PermissionDecisionRecord['category']; summary: string }, decision: PermissionDecision, automatic: boolean): PermissionDecisionRecord {
    const rec: PermissionDecisionRecord = { requestId: req.id, tool: req.tool, category: req.category, summary: req.summary, decision, at: Date.now(), automatic }
    this.history.unshift(rec)
    if (this.history.length > 500) this.history.length = 500
    writeJson(this.historyFile, this.history)
    return rec
  }

  addAlways(tool: AnyTool, args: Record<string, unknown>): void {
    this.rules.push({ tool: tool.name, scope: this.scopeOf(tool, args), createdAt: Date.now() })
    writeJson(this.file, this.rules)
  }

  clearAlways(): void {
    this.rules = []
    writeJson(this.file, this.rules)
  }

  getHistory(): PermissionDecisionRecord[] {
    return this.history
  }
}
