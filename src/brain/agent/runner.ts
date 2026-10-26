// The agent runtime: understands a request, plans, picks tools, runs them under the permission
// broker, checks results, recovers from errors, and reports the verified outcome.

import type { AgentSnapshot, SendOptions, SummonContext } from '../../shared/api'
import type { Settings } from '../../shared/settings'
import type {
  AgentEvent,
  AgentPhase,
  Artifact,
  ChatMessage,
  Clarification,
  MemoryKind,
  PermissionDecision,
  PermissionRequest,
  PlanItem,
  ProviderStatus,
  TaskRecord,
  TaskStep,
} from '../../shared/types'
import type { MemoryStore } from '../memory'
import type { PermissionBroker } from '../permissions'
import { ProviderError, textOf, type ChatResult, type ContentPart, type Message, type ModelProvider } from '../providers/types'
import type { SkillLibrary } from '../skills'
import { clip, newId, readJson, redactSecrets, writeJson } from '../store'
import type { TaskStore, UndoStore } from '../tasks'
import type { ToolRegistry } from '../tools/registry'
import type { AnyTool, HostCaller, ToolContext, ToolResult } from '../tools/types'
import { coerceArgs, validateArgs } from '../tools/validate'
import { parsePromptedCall, promptedToolsText, toPromptedMessages } from './prompted'
import { systemPrompt, userTurn, wrapUntrusted } from './prompt'
import path from 'node:path'
import { splitResult } from '../../shared/result-split'
import { isWritingTask } from '../../shared/quick-actions'

export interface RunnerDeps {
  dataDir: string
  host: HostCaller
  settings(): Settings
  memory: MemoryStore
  skills: SkillLibrary
  tasks: TaskStore
  undo: UndoStore
  registry: ToolRegistry
  permissions: PermissionBroker
  makeProvider(settings: Settings, useFallback?: boolean): Promise<ModelProvider>
  emit(e: AgentEvent): void
  /** Folders of active Claude Code projects (treated as allowed for file access). */
  projectRoots(): Promise<string[]>
}

interface Conversation {
  id: string
  chat: ChatMessage[]
  history: Message[]
  updatedAt: number
  /** Outside content entered an earlier task of this thread (its text is in the history). */
  tainted?: boolean
}

interface Active {
  task: TaskRecord
  ac: AbortController
  permissions: Map<string, { req: PermissionRequest; resolve: (d: PermissionDecision) => void }>
  asks: Map<string, { req: Clarification; resolve: (answer: string) => void }>
  grants: Set<string>
  tainted: boolean
  /** Web addresses from the request, the context and everything read so far (see ToolDef.egress). */
  seen: Set<string>
  done: Promise<void>
}

class Cancelled extends Error {
  constructor(reason = 'Cancelled') {
    super(reason)
    this.name = 'AbortError'
  }
}

const HISTORY_CHARS = 24000
/** An approval nobody answers is declined after this long, so a task never waits forever. */
const DECISION_TIMEOUT_MS = 30 * 60_000

const URL_RE = /https?:\/\/[^\s"'<>`)\]}]+/gi
export function normUrl(u: string): string {
  const s = u.trim().replace(/[.,;:!?]+$/, '')
  try {
    const x = new URL(s)
    x.hash = ''
    return x.href.replace(/\/$/, '')
  } catch {
    return s
  }
}
function collectUrls(into: Set<string>, text: string | undefined): void {
  if (text) for (const m of text.match(URL_RE) ?? []) into.add(normUrl(m))
}
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new Cancelled())), { once: true })
  })

export class AgentRunner {
  private conv: Conversation
  private convFile: string
  private active: Active | null = null
  private phase: AgentPhase = 'idle'
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private proposals = new Map<string, { text: string; kind: MemoryKind }>()
  providerStatus: ProviderStatus | null = null
  private summonContext: SummonContext | null = null

  constructor(private d: RunnerDeps) {
    this.convFile = path.join(d.dataDir, 'conversation.json')
    this.conv = readJson<Conversation>(this.convFile, { id: newId('conv'), chat: [], history: [], updatedAt: Date.now() })
  }

  // ---------- public API ----------

  snapshot(): AgentSnapshot {
    return {
      phase: this.phase,
      taskId: this.active?.task.id ?? null,
      pending: [...(this.active?.permissions.values() ?? [])].map((p) => p.req),
      clarifications: [...(this.active?.asks.values() ?? [])].map((a) => a.req),
      provider: this.providerStatus,
      context: this.summonContext,
    }
  }

  conversation(): ChatMessage[] {
    return this.conv.chat
  }

  newConversation(): void {
    this.conv = { id: newId('conv'), chat: [], history: [], updatedAt: Date.now(), tainted: false }
    this.saveConv()
  }

  setSummonContext(ctx: SummonContext | null): void {
    this.summonContext = ctx
  }

  async send(text: string, opts: SendOptions = {}): Promise<string> {
    const request = text.trim()
    if (!request) throw new Error('Empty request.')
    // A reply while Clawd waits on a question answers it instead of starting over.
    if (this.active && this.active.asks.size) {
      const [id] = this.active.asks.keys()
      this.answer(id, request)
      return this.active.task.id
    }
    if (this.active) {
      this.cancel(undefined, 'Replaced by a new request.')
      await this.active?.done.catch(() => {})
    }
    // Follow-ups ("make it shorter") continue the thread; a new topic or a long pause starts fresh.
    if (opts.fresh || Date.now() - this.conv.updatedAt > 15 * 60_000) this.newConversation()
    const settings = this.d.settings()
    // "Leave out" drops the draft and the selection only; the page and app stay known.
    const ctx = opts.useSelection === false ? (this.summonContext ? { ...this.summonContext, selection: undefined, draft: undefined } : null) : this.summonContext
    const task: TaskRecord = {
      id: newId('task'),
      conversationId: this.conv.id,
      request,
      label: opts.label,
      applyTo: (opts.applyTo === 'draft' && ctx?.draft) || (opts.applyTo === 'selection' && ctx?.selection) ? opts.applyTo : undefined,
      source: opts.source ?? 'text',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      model: { provider: settings.ai.provider, model: '' },
      plan: [],
      steps: [],
      artifacts: [],
      files: [],
      permissions: [],
      memoriesUsed: [],
      skillsUsed: [],
      context: ctx ? { app: ctx.app, title: ctx.title, hadSelection: !!ctx.selection, hadDraft: !!ctx.draft, url: ctx.url } : undefined,
    }
    const ac = new AbortController()
    let resolveDone!: () => void
    const done = new Promise<void>((r) => (resolveDone = r))
    // A page (its title and URL are page-controlled), a draft or a selection is outside content; so is
    // an earlier answer in this thread that was built from outside content.
    const tainted = !!(ctx?.selection || ctx?.draft || ctx?.url) || !!this.conv.tainted
    const seen = new Set<string>()
    for (const t of [request, ctx?.url, ctx?.draft, ctx?.selection]) collectUrls(seen, t)
    this.active = { task, ac, permissions: new Map(), asks: new Map(), grants: new Set(), tainted, seen, done }
    this.addChat({ id: newId('msg'), role: 'user', text: request, taskId: task.id, createdAt: Date.now() })
    void this.run(task, request, ctx, settings, opts).finally(() => resolveDone())
    return task.id
  }

  cancel(taskId?: string, reason = 'Cancelled by you.'): void {
    const a = this.active
    if (!a || (taskId && a.task.id !== taskId)) return
    a.task.error = reason
    a.ac.abort()
    for (const p of a.permissions.values()) p.resolve('deny')
    for (const q of a.asks.values()) q.resolve('')
  }

  decide(requestId: string, decision: PermissionDecision): void {
    const p = this.active?.permissions.get(requestId)
    if (!p) return
    this.active!.permissions.delete(requestId)
    p.resolve(decision)
    this.d.emit({ type: 'permission_resolved', id: requestId, decision })
  }

  answer(id: string, text: string): void {
    const q = this.active?.asks.get(id)
    if (!q) return
    this.active!.asks.delete(id)
    q.resolve(text)
    this.d.emit({ type: 'clarify_resolved', id })
  }

  resolveProposal(id: string, accept: boolean, text?: string): void {
    const p = this.proposals.get(id)
    if (!p) return
    this.proposals.delete(id)
    if (accept) this.d.memory.add(text?.trim() || p.text, p.kind, 'agent')
  }

  // ---------- internals ----------

  private setPhase(phase: AgentPhase, taskId: string | null, detail?: string): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.phase = phase
    this.d.emit({ type: 'phase', taskId, phase, detail })
    if (phase === 'done' || phase === 'error' || phase === 'cancelled') {
      this.idleTimer = setTimeout(() => {
        if (!this.active) {
          this.phase = 'idle'
          this.d.emit({ type: 'phase', taskId: null, phase: 'idle' })
        }
      }, 2500)
    }
  }

  private addChat(m: ChatMessage): void {
    this.conv.chat.push(m)
    if (this.conv.chat.length > 200) this.conv.chat.splice(0, this.conv.chat.length - 200)
    this.conv.updatedAt = Date.now()
    this.saveConv()
    this.d.emit({ type: 'message', message: m })
  }

  private saveConv(): void {
    writeJson(this.convFile, this.conv)
  }

  private publish(task: TaskRecord): void {
    task.updatedAt = Date.now()
    this.d.tasks.save(task)
    this.d.emit({ type: 'task', task })
  }

  private step(task: TaskRecord, s: Omit<TaskStep, 'id' | 'startedAt'>): TaskStep {
    const st: TaskStep = { id: newId('st'), startedAt: Date.now(), ...s }
    task.steps.push(st)
    this.publish(task)
    return st
  }

  private trimmedHistory(): Message[] {
    const out: Message[] = []
    let chars = 0
    for (let i = this.conv.history.length - 1; i >= 0; i--) {
      const m = this.conv.history[i]
      const len = textOf(m.content as string).length
      if (chars + len > HISTORY_CHARS && out.length >= 2) break
      chars += len
      out.unshift(m)
    }
    // History must start with a user turn.
    while (out.length && out[0].role !== 'user') out.shift()
    return out
  }

  private async run(task: TaskRecord, request: string, ctx: SummonContext | null, settings: Settings, opts: SendOptions = {}): Promise<void> {
    const a = this.active!
    const signal = a.ac.signal
    this.setPhase('thinking', task.id)
    this.publish(task)
    try {
      // ---- model ----
      let provider: ModelProvider
      let caps
      try {
        provider = await this.d.makeProvider(settings)
        caps = await provider.capabilities()
      } catch (err) {
        if (settings.ai.fallback === 'ollama' && settings.ai.provider !== 'ollama' && err instanceof ProviderError && (err.kind === 'network' || err.kind === 'unavailable')) {
          this.step(task, { kind: 'recovery', title: `${settings.ai.provider} is unreachable; using the local Ollama model instead`, status: 'done' })
          provider = await this.d.makeProvider(settings, true)
          caps = await provider.capabilities()
        } else throw err
      }
      task.model = { provider: provider.id, model: provider.model }
      this.providerStatus = { provider: provider.id, model: provider.model, ok: true, local: provider.local, vision: caps.vision, tools: caps.tools, message: 'Ready', checkedAt: Date.now() }

      // ---- prompt ----
      const { tools, unavailable } = this.d.registry.available(settings)
      const visionOk = caps.vision && settings.ai.vision === 'auto'
      const usable = tools.filter((t) => t.name !== 'take_screenshot' || visionOk)
      const specs = this.d.registry.specs(usable)
      const native = caps.tools
      const memories = settings.memory.enabled ? this.d.memory.relevant(request) : []
      task.memoriesUsed = memories.map((m) => ({ id: m.id, text: m.text }))
      const system = systemPrompt({
        modelLabel: `${provider.model} via ${provider.label}`,
        local: provider.local,
        vision: visionOk,
        skillsIndex: this.d.skills.index(),
        unavailable,
        promptedTools: native ? undefined : promptedToolsText(specs),
      })
      // Pre-load a skill's instructions when the request clearly calls for one (quick actions say
      // which); small local models follow inline guidance far better than they decide to fetch it.
      // '' means the caller chose no skill (a quick action without one); undefined lets the router pick.
      const skillName = opts.skill === '' ? undefined : (opts.skill ?? routeSkill(request, ctx))
      const skill = skillName ? this.d.skills.instructions(skillName) : null
      if (skill) task.skillsUsed.push(skill.info.name)
      // A typed request that ran a rewriting skill on the draft or selection can be put back there.
      if (!task.applyTo && skill?.info.name === 'comment-refine' && ctx?.draft) task.applyTo = 'draft'
      if (!task.applyTo && skill?.info.name === 'writing-polish' && ctx?.selection) task.applyTo = 'selection'
      const turn = userTurn(request, ctx, memories) + (skill ? `\n\n<skill name="${skill.info.name}">\n${skill.body}\n</skill>` : '')
      const messages: Message[] = [...this.trimmedHistory(), { role: 'user', content: turn }]
      const extraRoots = await this.d.projectRoots().catch(() => [])

      const toolCtx: ToolContext = {
        task,
        signal,
        host: this.d.host,
        settings,
        dataDir: this.d.dataDir,
        memory: this.d.memory,
        skills: this.d.skills,
        undo: this.d.undo,
        vision: visionOk,
        providerLocal: provider.local,
        extraRoots,
        summon: ctx,
        progress: (text) => {
          const st = [...task.steps].reverse().find((s) => s.status === 'running')
          if (st) {
            st.output = text
            this.publish(task)
          }
        },
        setPlan: (items: PlanItem[]) => {
          task.plan = items.map((i) => ({ text: i.text, status: i.status }))
          this.publish(task)
        },
        ask: (question, options) => this.askUser(task, question, options),
        proposeMemory: (text, kind) => {
          const id = newId('mp')
          this.proposals.set(id, { text, kind: kind as MemoryKind })
          this.d.emit({ type: 'memory_proposal', id, text, kind: kind as MemoryKind, taskId: task.id })
        },
      }

      // ---- loop ----
      const repeats = new Map<string, number>()
      let consecutiveErrors = 0
      let continuations = 0
      let finalText = ''
      const maxSteps = settings.ai.maxSteps
      for (let stepNo = 1; ; stepNo++) {
        if (signal.aborted) throw new Cancelled()
        const lastStep = stepNo > maxSteps
        if (lastStep) messages.push({ role: 'user', content: 'You have reached the step limit for this task. Do not call tools. Summarise what you did, what is verified, and what remains.' })
        this.setPhase('thinking', task.id)
        let streamed = ''
        const result = await this.callModel(provider, {
          system,
          messages: native ? messages : toPromptedMessages(messages),
          tools: native && !lastStep ? specs : [],
          temperature: settings.ai.temperature,
          reasoning: settings.ai.reasoning,
          signal,
          onText: (delta) => {
            streamed += delta
            if (!/```tool|<tool_call>/.test(streamed)) this.d.emit({ type: 'delta', taskId: task.id, text: delta })
          },
        }, task, messages)
        let calls = result.toolCalls
        let text = result.text
        if (!native) {
          const parsed = parsePromptedCall(text)
          calls = parsed.call ? [parsed.call] : []
          text = parsed.call ? parsed.rest : text
        }
        messages.push({ role: 'assistant', content: text, toolCalls: calls.length ? calls : undefined, raw: result.raw })
        if (!calls.length || lastStep) {
          if (result.stop === 'length' && continuations < 2 && !lastStep) {
            continuations++
            messages.push({ role: 'user', content: 'Your reply was cut off. Continue exactly where you stopped, more concisely.' })
            finalText += text
            continue
          }
          finalText += text
          break
        }
        // ---- tools ----
        this.setPhase('working', task.id)
        for (const call of calls) {
          if (signal.aborted) throw new Cancelled()
          const res = await this.execute(call.name, call.args, call.parseError, usable, toolCtx, repeats)
          if (res.untrusted) a.tainted = true
          collectUrls(a.seen, res.content)
          consecutiveErrors = res.ok ? 0 : consecutiveErrors + 1
          for (const art of res.artifacts ?? []) if (!task.artifacts.some((x) => x.path === art.path && x.url === art.url)) task.artifacts.push(art)
          const body = res.untrusted ? wrapUntrusted(res.untrusted, res.content) : res.content
          const content: string | ContentPart[] = res.images?.length && visionOk ? [{ type: 'text', text: body }, ...res.images.map((im) => ({ type: 'image' as const, mime: im.mime, data: im.data }))] : body
          messages.push({ role: 'tool', callId: call.id, name: call.name, content, isError: !res.ok })
        }
        if (consecutiveErrors >= 3) {
          this.step(task, { kind: 'recovery', title: 'Several steps failed; asking the model to rethink the approach', status: 'done' })
          messages.push({ role: 'user', content: 'Several tool calls in a row failed. Stop and reconsider: is there a different tool or approach? If the task cannot be done, explain why to the user.' })
          consecutiveErrors = 0
        }
      }

      // ---- finish ----
      finalText = finalText.trim() || (task.files.length ? 'Done.' : "I couldn't produce an answer for that.")
      const split = splitResult(finalText, !!task.applyTo || isWritingTask(request) || task.skillsUsed.some((s) => s === 'comment-refine' || s === 'writing-polish'))
      finalText = split.text
      task.result = finalText
      task.resultNote = split.note
      task.status = 'done'
      task.endedAt = Date.now()
      for (const p of task.plan) if (p.status === 'active') p.status = 'done'
      if (finalText.length > 400 || task.artifacts.length) task.artifacts.unshift({ kind: 'text', title: 'Result', text: finalText } as Artifact)
      this.publish(task)
      this.conv.history.push({ role: 'user', content: userTurn(request, ctx ? { ...ctx, selection: ctx.selection ? clip(ctx.selection, 4000) : undefined } : null, []) })
      const filesNote = task.files.length ? `\n\n(Files changed: ${task.files.map((f) => `${f.action} ${f.path}`).join('; ')})` : ''
      this.conv.history.push({ role: 'assistant', content: finalText + filesNote })
      if (a.tainted) this.conv.tainted = true
      this.addChat({ id: newId('msg'), role: 'assistant', text: finalText, note: split.note, taskId: task.id, createdAt: Date.now(), memories: task.memoriesUsed.map((m) => m.text) })
      if (settings.voice.speak && (task.source === 'voice' || settings.voice.speakWhen === 'always')) this.d.emit({ type: 'speak', text: finalText, taskId: task.id })
      this.active = null
      this.setPhase('done', task.id)
    } catch (err) {
      const cancelled = signal.aborted || (err as Error).name === 'AbortError'
      task.status = cancelled ? 'cancelled' : 'failed'
      task.endedAt = Date.now()
      task.error = cancelled ? (task.error ?? 'Cancelled.') : friendlyError(err)
      for (const s of task.steps) if (s.status === 'running') s.status = cancelled ? 'skipped' : 'failed'
      this.publish(task)
      if (!cancelled) {
        this.addChat({ id: newId('msg'), role: 'assistant', text: task.error, taskId: task.id, createdAt: Date.now() })
        if (err instanceof ProviderError) this.providerStatus = { ...(this.providerStatus ?? { provider: settings.ai.provider, model: '', local: false, vision: false, tools: false }), ok: false, message: err.message, checkedAt: Date.now() } as ProviderStatus
      }
      if (this.active?.task.id === task.id) this.active = null
      this.setPhase(cancelled ? 'cancelled' : 'error', task.id, task.error)
    }
  }

  private async callModel(provider: ModelProvider, req: Parameters<ModelProvider['chat']>[0], task: TaskRecord, messages: Message[]): Promise<ChatResult> {
    let trimmed = false
    for (let attempt = 0; ; attempt++) {
      try {
        return await provider.chat(req)
      } catch (err) {
        if (req.signal.aborted) throw new Cancelled()
        // A local model that isn't running won't start by itself in the next 15 s: one quick retry, then say so.
        const localDown = provider.local && err instanceof ProviderError && err.kind === 'network'
        if (err instanceof ProviderError && err.retryable && attempt < (localDown ? 1 : 3)) {
          const wait = localDown ? 800 : Math.min(20000, err.retryAfterMs ?? [1500, 4000, 9000][attempt])
          this.step(task, { kind: 'recovery', title: `${err.message} Retrying in ${Math.round(wait / 1000)} s`, status: 'done' })
          await sleep(wait, req.signal)
          continue
        }
        if (err instanceof ProviderError && err.kind === 'context' && !trimmed) {
          // Shrink the oldest tool outputs and history, then try once more.
          trimmed = true
          for (const m of messages) if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 2000) m.content = clip(m.content, 2000)
          while (messages.length > 4 && messages[0].role !== 'user') messages.shift()
          if (messages.length > 6) messages.splice(0, Math.floor(messages.length / 3))
          while (messages.length && messages[0].role !== 'user') messages.shift()
          req = { ...req, messages }
          this.step(task, { kind: 'recovery', title: 'The conversation was too long; trimmed older details and retried', status: 'done' })
          continue
        }
        throw err
      }
    }
  }

  private async execute(name: string, rawArgs: Record<string, unknown>, parseError: string | undefined, usable: AnyTool[], ctx: ToolContext, repeats: Map<string, number>): Promise<ToolResult> {
    const task = ctx.task
    const tool = usable.find((t) => t.name === name)
    if (!tool) {
      const unknown = this.d.registry.get(name)
      const msg = unknown ? `The tool "${name}" is not available right now (${unknown.available?.(ctx.settings) ?? 'disabled'}).` : `There is no tool named "${name}". Use only these tools: ${usable.map((t) => t.name).join(', ')}.`
      this.step(task, { kind: 'error', title: `Unknown or unavailable tool: ${name}`, tool: name, status: 'failed', error: msg, endedAt: Date.now() })
      return { ok: false, content: msg }
    }
    if (parseError) return { ok: false, content: `Your call to ${name} had invalid arguments: ${parseError}. Send valid JSON matching the schema.` }
    const args = coerceArgs(tool.parameters, rawArgs)
    const errors = validateArgs(tool.parameters, args)
    if (errors.length) return { ok: false, content: `Invalid arguments for ${name}: ${errors.join('; ')}.` }
    // Loop guard: the same call over and over will not produce a different result.
    const key = name + JSON.stringify(args)
    const count = (repeats.get(key) ?? 0) + 1
    repeats.set(key, count)
    if (count > 2 && tool.category !== 'meta')
      return { ok: false, content: `You already called ${name} with these exact arguments ${count - 1} times. Try something different or finish with what you have.` }

    let desc: { title: string; details: string }
    try {
      desc = tool.describe(args)
    } catch (err) {
      return { ok: false, content: `${name}: ${(err as Error).message}` }
    }
    const st = tool.category === 'meta' && name !== 'ask_user' ? null : this.step(task, { kind: 'tool', title: desc.title, tool: name, status: 'running', input: redactSecrets(clip(desc.details, 600)) })
    // ---- permission ----
    const allowed = await this.authorize(tool, args, ctx)
    if (!allowed.ok) {
      if (st) {
        st.status = 'denied'
        st.endedAt = Date.now()
        st.error = allowed.reason
        this.publish(task)
      }
      return { ok: false, content: `Not allowed: ${allowed.reason}. Do not retry this action; continue without it or explain to the user.` }
    }
    this.setPhase('working', task.id)
    // ---- run with timeout ----
    const timeoutMs = (tool.timeoutSec ?? ctx.settings.ai.toolTimeoutSec) * 1000
    const local = new AbortController()
    const onAbort = () => local.abort()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let res: ToolResult
    try {
      res = await Promise.race([
        tool.run(args, { ...ctx, signal: local.signal }),
        new Promise<ToolResult>((resolve) => {
          timer = setTimeout(() => {
            // Settle first: a tool that reacts to the abort must not win the race with "aborted".
            resolve({ ok: false, content: `${name} timed out after ${Math.round(timeoutMs / 1000)} s.` })
            local.abort()
          }, timeoutMs)
        }),
      ])
    } catch (err) {
      if (ctx.signal.aborted) throw new Cancelled()
      res = { ok: false, content: `${name} failed: ${(err as Error).message}` }
    } finally {
      if (timer) clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
    if (st) {
      st.status = res.ok ? 'done' : 'failed'
      st.endedAt = Date.now()
      const detail = ctx.settings.tasks.detail === 'full' ? res.content : res.summary ?? ''
      if (res.ok) st.output = redactSecrets(clip(res.summary ? `${res.summary}${detail && detail !== res.summary ? '\n' + detail : ''}` : detail, 1500))
      else st.error = redactSecrets(clip(res.content, 800))
      this.publish(task)
    }
    return res
  }

  private async authorize(tool: AnyTool, args: Record<string, unknown>, ctx: ToolContext): Promise<{ ok: boolean; reason?: string }> {
    const a = this.active!
    let risk: ReturnType<AnyTool['risk']>
    let extraReasons: string[]
    try {
      risk = tool.risk(args, ctx)
      extraReasons = [...(tool.needsApproval?.(args, ctx) ?? [])]
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
    if (a.tainted) {
      const unseen = (tool.egress?.(args) ?? []).filter((u) => !a.seen.has(normUrl(u)))
      if (unseen.length) extraReasons.push('the address is not from your request or from anything I read, so it could carry your data out')
      if (tool.escalateWhenTainted?.(args, ctx)) extraReasons.push('it uses text written after reading outside content')
    }
    const input = {
      tool,
      args,
      risk,
      extraReasons,
      task: ctx.task,
      settings: ctx.settings,
      tainted: a.tainted,
      sendsToCloud: !!tool.sendsContext && !ctx.providerLocal,
      taskGrants: a.grants,
    }
    const v = this.d.permissions.decide(input)
    const summary = tool.describe(args).title
    if (v.action === 'allow') {
      if (risk !== 'low') ctx.task.permissions.push(this.d.permissions.record({ id: newId('auto'), tool: tool.name, category: tool.category as never, summary }, 'allow_once', true))
      return { ok: true }
    }
    if (v.action === 'deny') {
      ctx.task.permissions.push(this.d.permissions.record({ id: newId('auto'), tool: tool.name, category: tool.category as never, summary }, 'deny', true))
      return { ok: false, reason: v.reasons.join('; ') }
    }
    const req = this.d.permissions.buildRequest(input, v)
    const decision = await new Promise<PermissionDecision>((resolve) => {
      const expire = setTimeout(() => {
        if (a.permissions.delete(req.id)) {
          this.d.emit({ type: 'permission_resolved', id: req.id, decision: 'deny' })
          resolve('deny')
        }
      }, DECISION_TIMEOUT_MS)
      a.permissions.set(req.id, {
        req,
        resolve: (d) => {
          clearTimeout(expire)
          resolve(d)
        },
      })
      this.setPhase('waiting_permission', ctx.task.id, req.title)
      this.d.emit({ type: 'permission', request: req })
    })
    if (ctx.signal.aborted) throw new Cancelled()
    ctx.task.permissions.push(this.d.permissions.record({ id: req.id, tool: tool.name, category: req.category, summary }, decision, false))
    this.publish(ctx.task)
    if (decision === 'deny') return { ok: false, reason: 'you declined this action' }
    if (decision === 'allow_task') {
      a.grants.add(tool.category)
      a.grants.add('cloud:' + tool.category)
    }
    if (decision === 'allow_always' && v.allowAlways) this.d.permissions.addAlways(tool, args)
    return { ok: true }
  }

  private askUser(task: TaskRecord, question: string, options?: string[]): Promise<string> {
    const a = this.active!
    const req: Clarification = { id: newId('ask'), taskId: task.id, question, options }
    return new Promise<string>((resolve) => {
      a.asks.set(req.id, {
        req,
        resolve: (answer) => {
          this.setPhase('working', task.id)
          resolve(answer || '(no answer)')
        },
      })
      task.status = 'waiting'
      this.publish(task)
      this.setPhase('waiting_user', task.id, question)
      this.d.emit({ type: 'clarify', request: req })
    }).then((ans) => {
      task.status = 'running'
      if (a.ac.signal.aborted) throw new Cancelled()
      return ans
    })
  }

  /** Quick reachability check of the configured model (no generation), for the panel's status. */
  async checkModel(): Promise<ProviderStatus> {
    const settings = this.d.settings()
    try {
      const p = await this.d.makeProvider(settings)
      const caps = await p.capabilities()
      this.providerStatus = { provider: p.id, model: p.model, ok: true, local: p.local, vision: caps.vision, tools: caps.tools, message: 'Ready', checkedAt: Date.now() }
    } catch (err) {
      this.providerStatus = { provider: settings.ai.provider, model: '', ok: false, local: settings.ai.provider === 'ollama', vision: false, tools: false, message: friendlyError(err), checkedAt: Date.now() }
    }
    return this.providerStatus
  }

  /** Marks tasks that were running when the app stopped. */
  recoverInterrupted(): TaskRecord[] {
    return this.d.tasks.markInterrupted()
  }

  get busy(): boolean {
    return !!this.active
  }
}

/** Picks a built-in skill for common requests when the caller did not name one. */
export function routeSkill(request: string, ctx: SummonContext | null): string | undefined {
  const r = request.toLowerCase()
  // Reading tasks ("what the post says") are not rewrites, whatever words they contain.
  if (/\b(summari[sz]e|summary|takeaways?|tl;?dr|explain)\b/.test(r)) return /\b(research|look up|find out about)\b/.test(r) ? 'web-research' : undefined
  if (ctx?.draft && /\b(refine|improve|fix|polish|rewrite|reword|comment|reply|post|grammar|shorter|clearer)\b/.test(r)) return 'comment-refine'
  if (/\b(my (comment|reply)|refine (my|this) (comment|reply))\b/.test(r)) return 'comment-refine'
  if (ctx?.selection && /\b(refine|rewrite|reword|polish|improve|shorten|clearer|grammar|spelling|translate|formal|casual|professional)\b/.test(r)) return 'writing-polish'
  if (/\b(research|compare sources|look up|find out about)\b/.test(r)) return 'web-research'
  return undefined
}

const sentence = (m: string) => (/[.!?)]$/.test(m.trim()) ? m.trim() : `${m.trim()}.`)

export function friendlyError(err: unknown): string {
  if (err instanceof ProviderError) {
    err.message = sentence(err.message)
    switch (err.kind) {
      case 'auth':
      case 'not_found':
      case 'context':
      case 'refusal':
        return err.message
      case 'network':
      case 'unavailable':
        return `${err.message} I'll be able to help once the model is reachable again; you can switch models in Settings > AI.`
      case 'rate_limit':
        return `${err.message} Please try again in a minute.`
      default:
        return `The model returned an error: ${err.message}`
    }
  }
  return `Something went wrong: ${(err as Error)?.message ?? String(err)}`
}
