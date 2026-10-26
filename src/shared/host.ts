// Capabilities the agent service asks the main process for (things only the desktop host can do).
// Each entry is one RPC method name -> signature, used on both sides for type checking.

import type { CCSession } from './types'

export interface ActiveContext {
  app: string
  title: string
  processPath?: string
  pid?: number
  bounds?: { x: number; y: number; w: number; h: number }
  /** URL of the active browser tab when the browser extension is connected. */
  url?: string
  available: boolean
  note?: string
}

export interface SelectionResult {
  text: string
  method: 'uia' | 'clipboard' | 'summon' | 'none'
  note?: string
  app?: string
}

export interface WindowTextResult {
  text: string
  app: string
  title: string
  truncated: boolean
  method: 'uia' | 'none'
  note?: string
}

export interface UiElement {
  name: string
  type: string
  rect: { x: number; y: number; w: number; h: number }
  value?: string
  enabled?: boolean
}

export interface Screenshot {
  mime: string
  data: string
  width: number
  height: number
  note?: string
}

export interface PageContent {
  url: string
  title: string
  text: string
  byline?: string
  truncated: boolean
  method: 'extension' | 'fetch' | 'uia'
  note?: string
}

export interface BrowserTab {
  id: number
  title: string
  url: string
  active: boolean
  windowId?: number
}

export interface HostApi {
  'context.active': () => ActiveContext
  'context.selection': (fresh: boolean) => SelectionResult
  'context.windowText': (maxChars: number) => WindowTextResult
  'context.elements': (query: string, max: number) => { app: string; elements: UiElement[]; note?: string }
  'context.screenshot': (target: 'screen' | 'window', maxWidth: number) => Screenshot
  'pointer.point': (rect: { x: number; y: number; w: number; h: number }, label?: string, hold?: number) => boolean
  'clipboard.read': () => string
  'clipboard.write': (text: string) => void
  'web.fetchPage': (url: string, maxChars: number) => PageContent
  'browser.connected': () => boolean
  'browser.getPage': (tabId: number | null, maxChars: number, scroll: boolean) => PageContent
  'browser.listTabs': () => BrowserTab[]
  /** The text in the focused text box on the active page (the user's comment or reply draft). */
  'browser.getDraft': () => { found: boolean; text: string; kind?: string; url: string; title: string }
  'apps.openUrl': (url: string) => { ok: boolean; message: string }
  'apps.openPath': (path: string) => { ok: boolean; message: string }
  'apps.launch': (name: string) => { ok: boolean; message: string }
  'files.trash': (path: string) => { ok: boolean; message: string }
  'input.type': (text: string) => { ok: boolean; message: string }
  'input.keys': (combo: string) => { ok: boolean; message: string }
  'input.click': (x: number, y: number, button: 'left' | 'right', double: boolean) => { ok: boolean; message: string }
  'notify': (title: string, body: string, taskId?: string) => boolean
  'cc.sessions': () => CCSession[]
  'cc.selected': () => string | null
  'secrets.get': (provider: string) => string | null
}

export type HostMethod = keyof HostApi
