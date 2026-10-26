// Entry point of the agent service, which runs in its own Electron utility process so model
// calls and tool work never block the desktop host or Clawd's animation.

import type { HostApi } from '../shared/host'
import { RpcPeer, type RpcMessage } from '../shared/rpc'
import { sanitizeSettings, type ProviderId, type Settings } from '../shared/settings'
import type { AgentEvent, MemoryKind } from '../shared/types'
import { AgentRunner } from './agent/runner'
import { MemoryStore } from './memory'
import { PermissionBroker } from './permissions'
import { createProvider } from './providers'
import { SkillLibrary } from './skills'
import { TaskStore, UndoStore } from './tasks'
import { ToolRegistry } from './tools/registry'
import type { HostCaller } from './tools/types'

interface ParentPort {
  on(event: 'message', fn: (e: { data: unknown }) => void): void
  postMessage(msg: unknown): void
}
const port = (process as unknown as { parentPort: ParentPort }).parentPort

const rpc = new RpcPeer((m) => port.postMessage(m))
port.on('message', (e) => void rpc.receive(e.data as RpcMessage))

const host: HostCaller = {
  call: (method, ...args) => rpc.call(`host:${method}`, args, 120_000) as never,
}
const emit = (e: AgentEvent) => rpc.emit('agent', e)

let settings: Settings = sanitizeSettings({})
let runner: AgentRunner | null = null
let memory: MemoryStore
let tasks: TaskStore
let undo: UndoStore
let skills: SkillLibrary
let permissions: PermissionBroker
const registry = new ToolRegistry()

function need(): AgentRunner {
  if (!runner) throw new Error('Agent service is still starting.')
  return runner
}

const getKey = (id: ProviderId) => host.call('secrets.get', id)

rpc.setHandlers({
  init(cfg: { dataDir: string; builtinSkills: string | null; settings: Settings }) {
    settings = sanitizeSettings(cfg.settings)
    memory = new MemoryStore(cfg.dataDir)
    tasks = new TaskStore(cfg.dataDir)
    undo = new UndoStore(cfg.dataDir)
    skills = new SkillLibrary(cfg.dataDir, cfg.builtinSkills, () => registry.names())
    permissions = new PermissionBroker(cfg.dataDir)
    runner = new AgentRunner({
      dataDir: cfg.dataDir,
      host,
      settings: () => settings,
      memory,
      skills,
      tasks,
      undo,
      registry,
      permissions,
      makeProvider: (s, fallback) => createProvider(s, getKey, fallback ? 'ollama' : s.ai.provider),
      emit,
      projectRoots: async () => (await host.call('cc.sessions')).map((s) => s.cwd),
    })
    const interrupted = runner.recoverInterrupted()
    // Housekeeping on start.
    memory.prune(settings.memory.retentionDays)
    tasks.prune(settings.tasks.retentionDays)
    undo.prune(settings.tasks.undoRetentionDays)
    return { interrupted: interrupted.map((t) => ({ id: t.id, request: t.request })) }
  },
  settings(s: Settings) {
    settings = sanitizeSettings(s)
  },
  summonContext(ctx) {
    need().setSummonContext(ctx as never)
  },
  send: (text: string, opts) => need().send(text, opts as never),
  cancel: (taskId?: string) => need().cancel(taskId),
  decide: (id: string, d) => need().decide(id, d as never),
  answer: (id: string, text: string) => need().answer(id, text),
  memoryProposal: (id: string, accept: boolean, text?: string) => need().resolveProposal(id, accept, text),
  conversation: () => need().conversation(),
  newConversation: () => need().newConversation(),
  snapshot: () => need().snapshot(),
  checkModel: () => need().checkModel(),
  'tasks.list': () => tasks.list(),
  'tasks.get': (id: string) => tasks.get(id),
  'tasks.delete': (id: string) => tasks.delete(id),
  'tasks.clear': () => tasks.clear(),
  'tasks.undo': (id: string, index?: number) => {
    const t = tasks.get(id)
    if (!t) throw new Error('Unknown task.')
    const changes = index === undefined ? t.files : [t.files[index]].filter(Boolean)
    const res = undo.revert(changes)
    tasks.save(t)
    emit({ type: 'task', task: t })
    return res
  },
  'memory.list': (q?: string) => memory.list(q),
  'memory.add': (text: string, kind?: MemoryKind) => memory.add(text, kind ?? 'note', 'user'),
  'memory.update': (id: string, patch) => memory.update(id, patch as never),
  'memory.remove': (id: string) => memory.remove(id),
  'memory.clear': () => memory.clear(),
  'skills.list': () => skills.list(),
  'skills.install': (dir: string) => skills.install(dir),
  'skills.remove': (id: string) => skills.remove(id),
  'skills.enable': (id: string, on: boolean) => skills.setEnabled(id, on),
  'skills.folder': () => skills.folder,
  'permissions.history': () => permissions.getHistory(),
  'permissions.clearAlways': () => permissions.clearAlways(),
  async 'models.list'(id: ProviderId) {
    try {
      const p = await createProvider(settings, getKey, id, true)
      return { models: await p.listModels() }
    } catch (err) {
      return { models: [], error: (err as Error).message }
    }
  },
  async 'models.test'(id?: ProviderId) {
    const pid = id ?? settings.ai.provider
    const t0 = Date.now()
    try {
      const p = await createProvider(settings, getKey, pid)
      const caps = await p.capabilities()
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 60_000)
      const r = await p.chat({ system: 'You are a connectivity check. Reply with the single word: ready', messages: [{ role: 'user', content: 'Reply with: ready' }], tools: [], temperature: 0, reasoning: 'off', signal: ac.signal, maxTokens: 256 })
      clearTimeout(timer)
      return { provider: pid, model: p.model, ok: true, local: p.local, vision: caps.vision, tools: caps.tools, message: `Replied "${r.text.trim().slice(0, 40)}" in ${((Date.now() - t0) / 1000).toFixed(1)} s`, checkedAt: Date.now() }
    } catch (err) {
      return { provider: pid, model: '', ok: false, local: pid === 'ollama', vision: false, tools: false, message: (err as Error).message, checkedAt: Date.now() }
    }
  },
  ping: () => 'pong',
})

rpc.emit('ready', null)

// Type-only check that the host contract and the calls line up.
export type _HostCheck = HostApi
