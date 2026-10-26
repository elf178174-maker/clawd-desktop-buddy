// Data types shared by the main process, the agent service and the renderers.

import type { PermissionCategory, ProviderId } from './settings'

export type AgentPhase =
  | 'idle'
  | 'thinking' // waiting for the model
  | 'working' // running tools
  | 'waiting_permission'
  | 'waiting_user' // asked a clarifying question
  | 'speaking'
  | 'done'
  | 'error'
  | 'cancelled'

export type TaskStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export interface PlanItem {
  text: string
  status: 'pending' | 'active' | 'done' | 'failed' | 'skipped'
}

export type StepKind = 'model' | 'tool' | 'permission' | 'note' | 'error' | 'recovery'

export interface TaskStep {
  id: string
  kind: StepKind
  title: string
  tool?: string
  status: 'running' | 'done' | 'failed' | 'denied' | 'skipped'
  startedAt: number
  endedAt?: number
  /** Short, already-redacted views of the input and output. */
  input?: string
  output?: string
  error?: string
}

export interface Artifact {
  kind: 'file' | 'text' | 'link' | 'image'
  title: string
  path?: string
  url?: string
  text?: string
}

export interface FileChange {
  path: string
  action: 'created' | 'modified' | 'deleted' | 'moved'
  /** Where the move went (for 'moved'). */
  to?: string
  /** Backup id usable for undo, when one exists. */
  backupId?: string
  reverted?: boolean
}

export interface PermissionDecisionRecord {
  requestId: string
  tool: string
  category: PermissionCategory
  summary: string
  decision: PermissionDecision
  at: number
  /** Auto-decided by a rule rather than by the user. */
  automatic: boolean
}

export interface TaskRecord {
  id: string
  conversationId: string
  request: string
  /** Short title for the request (quick actions and tweaks have one). */
  label?: string
  /** Where the result can go back to: the comment draft or the selection it rewrites. */
  applyTo?: 'draft' | 'selection'
  source: 'text' | 'voice' | 'suggestion' | 'clipboard' | 'selection'
  createdAt: number
  updatedAt: number
  endedAt?: number
  status: TaskStatus
  model: { provider: ProviderId; model: string }
  plan: PlanItem[]
  steps: TaskStep[]
  result?: string
  /** Side note that accompanies the result. */
  resultNote?: string
  artifacts: Artifact[]
  files: FileChange[]
  permissions: PermissionDecisionRecord[]
  memoriesUsed: { id: string; text: string }[]
  skillsUsed: string[]
  error?: string
  /** Context the request was made in (app, window title), without content. */
  context?: { app?: string; title?: string; hadSelection?: boolean; hadDraft?: boolean; url?: string }
}

export type PermissionDecision = 'allow_once' | 'allow_task' | 'allow_always' | 'deny'

export interface PermissionRequest {
  id: string
  taskId: string
  tool: string
  category: PermissionCategory
  /** One line: "Run a PowerShell command". */
  title: string
  /** Exact action: the command, path, text to type, URL... */
  details: string
  risk: 'low' | 'medium' | 'high'
  /** Why this needs approval (e.g. "outside your allowed folders", "after reading web content"). */
  reasons: string[]
  /** Whether "always allow" may be offered for this request. */
  allowAlways: boolean
  createdAt: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  taskId?: string
  createdAt: number
  /** Assistant messages: which memories influenced the answer. */
  memories?: string[]
  /** A side note that is not part of the deliverable text (e.g. what Clawd could not read). */
  note?: string
}

export interface Clarification {
  id: string
  taskId: string
  question: string
  options?: string[]
}

/** Live events from the agent service to the UI. */
export type AgentEvent =
  | { type: 'phase'; taskId: string | null; phase: AgentPhase; detail?: string }
  | { type: 'task'; task: TaskRecord }
  | { type: 'delta'; taskId: string; text: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'permission_resolved'; id: string; decision: PermissionDecision }
  | { type: 'clarify'; request: Clarification }
  | { type: 'clarify_resolved'; id: string }
  | { type: 'speak'; text: string; taskId: string }
  | { type: 'memory_proposal'; id: string; text: string; kind: MemoryKind; taskId: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }

export type MemoryKind = 'preference' | 'fact' | 'project' | 'workflow' | 'correction' | 'note'

export interface MemoryItem {
  id: string
  text: string
  kind: MemoryKind
  tags: string[]
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  useCount: number
  source: 'user' | 'agent'
  pinned?: boolean
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  version: string
  author?: string
  taskTypes: string[]
  tools: string[]
  permissions: PermissionCategory[]
  enabled: boolean
  builtin: boolean
  path: string
  /** Validation problems; a skill with errors cannot be enabled. */
  errors: string[]
  warnings: string[]
  installedAt: number
  hasScripts: boolean
}

export type CCState =
  | 'idle'
  | 'active'
  | 'processing'
  | 'tool'
  | 'waiting_approval'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'disconnected'
  | 'unknown'

export interface CCSession {
  id: string
  cwd: string
  project: string
  state: CCState
  /** True when the state comes from a definite hook event, false when inferred (e.g. timeouts). */
  certain: boolean
  title?: string
  model?: string
  tool?: string
  message?: string
  transcriptPath?: string
  startedAt: number
  updatedAt: number
  lastEvent: string
  events: number
  toolCount: number
  editedFiles: string[]
  lastError?: string
}

export interface ProviderStatus {
  provider: ProviderId
  model: string
  ok: boolean
  local: boolean
  vision: boolean
  tools: boolean
  message: string
  checkedAt: number
}

export interface IntegrationStatus {
  id: 'claudeCode' | 'browser' | 'voice' | 'native' | 'model'
  ok: boolean
  label: string
  detail: string
}

export type Visibility = 'present' | 'hidden' | 'summoned'

/** What the overlay needs to drive Clawd's animation. */
export interface CompanionState {
  visibility: Visibility
  focus: boolean
  agent: AgentPhase
  /** Claude Code state of the selected/most active session, or null when none is connected. */
  cc: CCState | null
  listening: boolean
  speaking: boolean
  panelOpen: boolean
  /** A pending permission request or clarification needs the user. */
  needsUser: boolean
}
