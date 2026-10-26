// Tool definitions: explicit schema, permission category, risk, availability and execution.

import type { SummonContext } from '../../shared/api'
import type { HostApi } from '../../shared/host'
import type { PermissionCategory, Settings } from '../../shared/settings'
import type { Artifact, FileChange, PlanItem, TaskRecord } from '../../shared/types'
import type { MemoryStore } from '../memory'
import type { SkillLibrary } from '../skills'
import type { UndoStore } from '../tasks'

export type JsonSchema = {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: readonly (string | number)[]
  items?: JsonSchema
  minimum?: number
  maximum?: number
  maxLength?: number
  maxItems?: number
  additionalProperties?: boolean
}

export type Risk = 'low' | 'medium' | 'high'

export interface HostCaller {
  call<K extends keyof HostApi>(method: K, ...args: Parameters<HostApi[K]>): Promise<Awaited<ReturnType<HostApi[K]>>>
}

export interface ToolContext {
  task: TaskRecord
  signal: AbortSignal
  host: HostCaller
  settings: Settings
  dataDir: string
  memory: MemoryStore
  skills: SkillLibrary
  undo: UndoStore
  /** The model can read images. */
  vision: boolean
  /** The model runs locally (no data leaves the machine). */
  providerLocal: boolean
  /** Extra folders treated as allowed for this task (e.g. active Claude Code projects). */
  extraRoots: string[]
  /** What the user had in front of them when they summoned Clawd (app, page URL, draft, selection). */
  summon: SummonContext | null
  /** Updates the running step's detail line. */
  progress(text: string): void
  setPlan(items: PlanItem[]): void
  /** Asks the user a question and waits for the answer. */
  ask(question: string, options?: string[]): Promise<string>
  /** Proposes a memory to the user (autoRemember = 'ask'). */
  proposeMemory(text: string, kind: string): void
}

export interface ToolResult {
  ok: boolean
  /** Text the model sees. */
  content: string
  images?: { mime: string; data: string }[]
  /** Set when the content came from outside Clawd (web, files, clipboard, other apps). */
  untrusted?: string
  artifacts?: Artifact[]
  files?: FileChange[]
  /** One-line, user-facing summary for the task panel. */
  summary?: string
}

export interface ToolDef<A extends Record<string, unknown> = Record<string, unknown>> {
  name: string
  description: string
  /** 'meta' tools (planning, asking) never need permission. */
  category: PermissionCategory | 'meta'
  parameters: JsonSchema & { type: 'object' }
  risk(args: A, ctx: ToolContext): Risk
  /** The exact action, for permission prompts and the task log. */
  describe(args: A): { title: string; details: string }
  /** Extra reasons that force a confirmation even when the category is allowed. */
  needsApproval?(args: A, ctx: ToolContext): string[]
  /** True if results carry the user's own context (selection, screen, clipboard, page). */
  sendsContext?: boolean
  /**
   * Web addresses this call sends a request to. Once outside content has entered the task, an
   * address that did not appear in the request or in anything read so far needs approval, so
   * injected instructions cannot smuggle data out inside a URL.
   */
  egress?(args: A): string[]
  /** Hands model-written content to the user or the future (clipboard, memory): asks once outside content has entered the task, whatever the risk. */
  escalateWhenTainted?(args: A, ctx: ToolContext): boolean
  /** Returns true, or a reason why the tool cannot be offered right now. */
  available?(settings: Settings): true | string
  timeoutSec?: number
  run(args: A, ctx: ToolContext): Promise<ToolResult>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDef<any>

export const ok = (content: string, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: true, content, ...extra })
export const fail = (content: string, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: false, content, ...extra })
