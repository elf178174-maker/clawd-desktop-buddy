// The IPC contract between renderers and the main process. Renderers call `invoke(channel, ...)`
// through the preload bridge; the main process registers a handler per channel. Keeping the
// whole contract in one type map lets both sides typecheck against it.

import type { ShortcutCheck } from './keybinds'
import type { DeepPartial, ProviderId, Settings, ShortcutAction } from './settings'
import type {
  AgentEvent,
  AgentPhase,
  CCSession,
  ChatMessage,
  Clarification,
  CompanionState,
  IntegrationStatus,
  MemoryItem,
  MemoryKind,
  PermissionDecision,
  PermissionDecisionRecord,
  PermissionRequest,
  ProviderStatus,
  SkillInfo,
  TaskRecord,
  TaskStatus,
} from './types'

export interface ShortcutStatus {
  action: ShortcutAction
  label: string
  accelerator: string
  registered: boolean
  error?: string
}

export interface StartupStatus {
  enabled: boolean
  /** The OS actually has a login entry for Clawd. */
  registered: boolean
  /** Command the login entry runs. */
  command?: string
  supported: boolean
  note?: string
}

export interface SendOptions {
  source?: TaskRecord['source']
  /** Attach the text that was selected when Clawd was summoned. */
  useSelection?: boolean
  /** Continue the current conversation (default) or start a fresh one. */
  fresh?: boolean
  /** Pre-load this skill's instructions (quick actions know which one fits). */
  skill?: string
  /** The result is a rewrite of the user's comment draft or selection, so it can be put back there. */
  applyTo?: 'draft' | 'selection'
  /** Short label shown as the result's title (e.g. "Refine my comment · Shorter"). */
  label?: string
}

export interface AgentSnapshot {
  phase: AgentPhase
  taskId: string | null
  pending: PermissionRequest[]
  clarifications: Clarification[]
  provider: ProviderStatus | null
  /** Context captured at summon time. */
  context: SummonContext | null
}

export interface SummonContext {
  app?: string
  title?: string
  /** Text the user is writing in a web page's text box (e.g. a Reddit comment), via the extension. */
  draft?: string
  selection?: string
  selectionMethod?: 'uia' | 'clipboard' | 'none'
  selectionNote?: string
  url?: string
  /** The app was a web browser (the page address needs the browser extension). */
  isBrowser?: boolean
  capturedAt: number
}

export interface TaskSummary {
  id: string
  request: string
  status: TaskStatus
  createdAt: number
  endedAt?: number
  steps: number
  files: number
  undoable: number
}

export interface UndoResult {
  ok: boolean
  reverted: string[]
  failed: { path: string; reason: string }[]
}

export interface VoiceStatus {
  devices: { deviceId: string; label: string }[]
  available: boolean
  modelsPresent: boolean
  missing: string[]
  downloading: { file: string; received: number; total: number } | null
  wakeWord: 'off' | 'listening' | 'paused' | 'error'
  micPermission: 'unknown' | 'granted' | 'denied'
  listening: boolean
  /** Speech heard, being turned into text. */
  recognizing: boolean
  speaking: boolean
  error?: string
  engine: string
}

export interface CCInstallStatus {
  installed: boolean
  settingsPath: string
  events: string[]
  hookCommand?: string
  /** Hooks from other tools that share the settings file (left untouched). */
  otherHooks: number
  serverRunning: boolean
  lastEventAt?: number
  error?: string
}

export interface BrowserStatus {
  enabled: boolean
  connected: boolean
  clients: { id: string; browser: string; version: string; connectedAt: number }[]
  port: number
  token: string
  extensionPath: string
}

export interface AppInfo {
  version: string
  electron: string
  dataDir: string
  logsDir: string
  packaged: boolean
  platform: string
}

export interface Diagnostics {
  info: AppInfo
  integrations: IntegrationStatus[]
  logTail: string[]
  perf: { fps: number; frameMs: number; cpu: number; memoryMB: number } | null
}

export interface ApplyResult {
  ok: boolean
  message: string
}

export interface Invokes {
  'settings:get': () => Settings
  'settings:set': (patch: DeepPartial<Settings>) => Settings
  'settings:reset': (section?: keyof Settings) => Settings

  'secrets:has': (id: ProviderId) => boolean
  'secrets:set': (id: ProviderId, value: string) => void
  'secrets:clear': (id: ProviderId) => void

  'shortcuts:status': () => ShortcutStatus[]
  'shortcuts:check': (action: ShortcutAction, accelerator: string) => ShortcutCheck
  'shortcuts:recording': (on: boolean) => void

  'startup:status': () => StartupStatus

  'agent:send': (text: string, opts?: SendOptions) => { taskId: string }
  'agent:cancel': (taskId?: string) => void
  'agent:decide': (requestId: string, decision: PermissionDecision) => void
  'agent:answer': (clarificationId: string, answer: string) => void
  'agent:conversation': () => ChatMessage[]
  'agent:newConversation': () => void
  'agent:snapshot': () => AgentSnapshot
  /** Quick reachability check of the configured model (no generation). */
  'agent:checkModel': () => ProviderStatus
  'agent:memoryProposal': (id: string, accept: boolean, text?: string) => void

  'tasks:list': () => TaskSummary[]
  'tasks:get': (id: string) => TaskRecord | null
  'tasks:undo': (id: string, index?: number) => UndoResult
  'tasks:delete': (id: string) => void
  'tasks:clear': () => void

  'memory:list': (query?: string) => MemoryItem[]
  'memory:add': (text: string, kind?: MemoryKind) => MemoryItem
  'memory:update': (id: string, patch: Partial<Pick<MemoryItem, 'text' | 'kind' | 'tags' | 'pinned'>>) => MemoryItem
  'memory:remove': (id: string) => void
  'memory:clear': () => void

  'skills:list': () => SkillInfo[]
  'skills:install': (path?: string) => SkillInfo | null
  'skills:remove': (id: string) => void
  'skills:enable': (id: string, on: boolean) => SkillInfo
  'skills:openFolder': () => void

  'models:list': (provider: ProviderId) => { models: string[]; error?: string }
  'models:test': (provider?: ProviderId) => ProviderStatus

  'voice:status': () => VoiceStatus
  'voice:toggle': () => void
  'voice:test': (text?: string) => void
  'voice:stopSpeaking': () => void
  /** Stops listening without a transcript (the user started typing). */
  'voice:cancel': () => void
  'voice:voices': () => string[]
  'voice:download': () => void

  'cc:sessions': () => CCSession[]
  'cc:select': (id: string | null) => void
  'cc:status': () => CCInstallStatus
  'cc:install': () => CCInstallStatus
  'cc:uninstall': () => CCInstallStatus

  'browser:status': () => BrowserStatus
  'browser:openExtensionFolder': () => void

  'permissions:history': () => PermissionDecisionRecord[]
  'permissions:clearAlways': () => void

  'integrations:status': () => IntegrationStatus[]

  'result:apply': (text: string, mode: 'copy' | 'replace' | 'insert' | 'draft') => ApplyResult

  'app:info': () => AppInfo
  'app:open': (target: 'settings' | 'panel', section?: string) => void
  'app:openPath': (path: string) => void
  'app:reveal': (path: string) => void
  'app:openExternal': (url: string) => void
  'app:copy': (text: string) => void
  'app:diagnostics': () => Diagnostics
  'app:quit': () => void
  'app:pickFolder': () => string | null

  'panel:hide': () => void
  'panel:pin': (on: boolean) => void
  'panel:size': (height: number) => void

  'companion:summon': () => void
  'companion:hide': () => void
}

/** Events pushed from main to renderers. */
export interface Events {
  'settings:changed': Settings
  'agent:event': AgentEvent
  'companion:state': CompanionState
  'cc:sessions': CCSession[]
  'voice:status': VoiceStatus
  'panel:focusInput': { text?: string; context?: SummonContext | null }
  'panel:show': { section?: 'chat' | 'tasks'; taskId?: string }
  /** What the user said while the panel was listening ('' when nothing was understood). */
  'panel:voiceText': { text: string }
  'voice:level': number
  'integrations:changed': IntegrationStatus[]
  'browser:status': BrowserStatus
  'shortcuts:changed': ShortcutStatus[]
}

export type InvokeChannel = keyof Invokes
export type EventChannel = keyof Events

export const INVOKE_CHANNELS = [
  'settings:get', 'settings:set', 'settings:reset',
  'secrets:has', 'secrets:set', 'secrets:clear',
  'shortcuts:status', 'shortcuts:check', 'shortcuts:recording',
  'startup:status',
  'agent:send', 'agent:cancel', 'agent:decide', 'agent:answer', 'agent:conversation', 'agent:newConversation', 'agent:snapshot', 'agent:checkModel', 'agent:memoryProposal',
  'tasks:list', 'tasks:get', 'tasks:undo', 'tasks:delete', 'tasks:clear',
  'memory:list', 'memory:add', 'memory:update', 'memory:remove', 'memory:clear',
  'skills:list', 'skills:install', 'skills:remove', 'skills:enable', 'skills:openFolder',
  'models:list', 'models:test',
  'voice:status', 'voice:toggle', 'voice:test', 'voice:stopSpeaking', 'voice:cancel', 'voice:voices', 'voice:download',
  'cc:sessions', 'cc:select', 'cc:status', 'cc:install', 'cc:uninstall',
  'browser:status', 'browser:openExtensionFolder',
  'permissions:history', 'permissions:clearAlways',
  'integrations:status',
  'result:apply',
  'app:info', 'app:open', 'app:openPath', 'app:reveal', 'app:openExternal', 'app:copy', 'app:diagnostics', 'app:quit', 'app:pickFolder',
  'panel:hide', 'panel:pin', 'panel:size',
  'companion:summon', 'companion:hide',
] as const satisfies readonly InvokeChannel[]

export const EVENT_CHANNELS = [
  'settings:changed', 'agent:event', 'companion:state', 'cc:sessions', 'voice:status', 'panel:focusInput', 'panel:show', 'panel:voiceText', 'voice:level',
  'integrations:changed', 'browser:status', 'shortcuts:changed',
] as const satisfies readonly EventChannel[]

/** Fire-and-forget messages from the overlay renderer (high frequency, no reply). */
export interface OverlaySends {
  'overlay:hitbox': { x: number; y: number; w: number; h: number } | null
  'overlay:interactive': boolean
  'overlay:drag': { phase: 'start' | 'move' | 'end'; screenX: number; screenY: number }
  'overlay:interaction': { kind: 'poke' | 'doubleClick' | 'highFive' | 'contextMenu' | 'hover' }
  'overlay:ready': null
  'overlay:perf': { fps: number; frameMs: number }
}

/** Messages main pushes to the overlay. */
export interface OverlayEvents {
  'overlay:init': OverlayInit
  'overlay:state': CompanionState
  'overlay:pointer': { x: number; y: number; moving: boolean } | null
  'overlay:anchor': { x: number; y: number; animate: 'none' | 'walk' | 'hop' | 'fall' }
  'overlay:play': { name: string; params?: Record<string, number> }
  'overlay:point': PointRequest | null
  'overlay:bubble': Bubble | null
  'overlay:level': number
  'overlay:glance': { x: number; y: number; seconds?: number }
  /** Clawd is controlling the keyboard or mouse (shows the edge glow). */
  'overlay:control': boolean
}

export interface OverlayInit {
  /** Work-area size of the display this overlay covers, CSS px. */
  width: number
  height: number
  settings: Settings
  /** Ground anchor: where Clawd's feet are, in overlay coordinates. */
  anchor: { x: number; y: number }
  onScreenEdge: boolean
  reducedMotion: boolean
}

export interface PointRequest {
  /** Target box in overlay coordinates (CSS px). */
  box: { x: number; y: number; w: number; h: number }
  label?: string
  /** Seconds to keep the highlight before fading. */
  hold?: number
  /** Show a press + ripple on arrival (Clawd is about to click there for real). */
  click?: boolean
}

export interface Bubble {
  id: string
  text: string
  /** Optional buttons; clicking one sends `bubble:action`. */
  actions?: { id: string; label: string; primary?: boolean }[]
  /** Seconds before auto-dismiss (0 = sticky). */
  ttl?: number
  tone?: 'normal' | 'attention'
}

export const OVERLAY_SEND_CHANNELS = ['overlay:hitbox', 'overlay:interactive', 'overlay:drag', 'overlay:interaction', 'overlay:ready', 'overlay:perf', 'bubble:action', 'audio:ready', 'audio:level', 'audio:devices', 'audio:micState', 'audio:nativeSpeech'] as const
export const OVERLAY_EVENT_CHANNELS = ['overlay:init', 'overlay:state', 'overlay:pointer', 'overlay:anchor', 'overlay:play', 'overlay:point', 'overlay:bubble', 'overlay:level', 'overlay:glance', 'overlay:control', 'audio:mic', 'audio:volume', 'audio:say', 'audio:stop', 'audio:listDevices'] as const

/** Hidden audio window <-> main. */
export interface AudioSends {
  'audio:ready': null
  'audio:level': number
  'audio:devices': { deviceId: string; label: string }[]
  'audio:micState': { on: boolean; error?: string; permission: 'granted' | 'denied' | 'unknown' }
  'audio:nativeSpeech': { state: 'start' | 'end' }
}
export interface AudioEvents {
  'audio:mic': { on: boolean; deviceId: string }
  'audio:volume': number
  'audio:say': { text: string; voice: string; rate: number; volume: number }
  'audio:stop': null
  'audio:listDevices': null
}
