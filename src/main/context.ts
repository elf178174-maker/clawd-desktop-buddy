// Screen awareness: remembers which application the user is working in (so Clawd's own windows
// never count), captures the selection when he is summoned, and serves layered context: UI
// Automation first, clipboard copy as a fallback, screenshots last.

import { clipboard } from 'electron'
import { EventEmitter } from 'node:events'
import type { SummonContext } from '../shared/api'
import { prettyApp } from '../shared/apps'
import type { ActiveContext, SelectionResult, UiElement, WindowTextResult, Screenshot } from '../shared/host'
import { logger } from './log'
import { NativeHelper, type WinInfo } from './native'
import type { SettingsStore } from './settings-store'

const log = logger('context')
const TERMINALS = /^(windowsterminal|cmd|powershell|pwsh|conhost|wezterm-gui|alacritty|mintty|kitty|wt|openconsole)\.exe$/i
const BROWSERS = /^(chrome|msedge|arc|brave|vivaldi|opera|firefox|chromium)\.exe$/i

export class ScreenContext extends EventEmitter {
  private last: WinInfo | null = null
  private ownPid = process.pid
  private summon: SummonContext | null = null
  /** URL lookup from the browser bridge, set by the app. */
  activeUrl: () => string | undefined = () => undefined
  /** Reads the draft in the browser's focused text box, set by the app (null if unavailable). */
  readDraft: () => Promise<string | null> = async () => null

  constructor(
    private native: NativeHelper,
    private settings: SettingsStore,
  ) {
    super()
    native.on('foreground', (w: WinInfo) => this.onForeground(w))
    native.on('dialog', (w: WinInfo) => this.onDialog(w))
  }

  private isOwn(w: WinInfo): boolean {
    return w.pid === this.ownPid || /clawd(\.exe)?$/i.test(w.process) || (w.process.toLowerCase() === 'electron.exe' && w.title.startsWith('Clawd'))
  }

  private onForeground(w: WinInfo): void {
    if (!w || this.isOwn(w) || !w.title) return
    const changed = !this.last || this.last.hwnd !== w.hwnd
    this.last = w
    if (changed && this.settings.get().privacy.screenAwareness) this.emit('foreground', w)
  }

  private onDialog(w: WinInfo): void {
    if (!w || this.isOwn(w)) return
    if (this.settings.get().privacy.screenAwareness) this.emit('dialog', w)
  }

  /** The window the user was last working in (outside Clawd). */
  async target(): Promise<WinInfo | null> {
    if (this.last) return this.last
    try {
      const w = await this.native.call<WinInfo | null>('foreground')
      if (w && !this.isOwn(w)) this.last = w
    } catch {
      /* helper unavailable */
    }
    return this.last
  }

  get lastWindow(): WinInfo | null {
    return this.last
  }

  isTerminal(w: WinInfo | null): boolean {
    return !!w && TERMINALS.test(w.process)
  }

  isBrowser(w: WinInfo | null): boolean {
    return !!w && BROWSERS.test(w.process)
  }

  /**
   * Called the moment Clawd is summoned, while the user's app still has focus: grabs the app,
   * title and selected text (UI Automation first, then a careful clipboard copy).
   */
  async captureSummon(): Promise<SummonContext> {
    const s = this.settings.get()
    const ctx: SummonContext = { capturedAt: Date.now() }
    if (!s.privacy.screenAwareness) {
      this.summon = ctx
      return ctx
    }
    let fg: WinInfo | null = null
    try {
      fg = await this.native.call<WinInfo | null>('foreground', {}, 2000)
    } catch {
      /* ignore */
    }
    if (fg && !this.isOwn(fg)) this.last = fg
    const w = fg && !this.isOwn(fg) ? fg : this.last
    if (w) {
      ctx.app = prettyApp(w.process)
      ctx.title = w.title
      // The desktop itself is Explorer's "Program Manager" window.
      if (/^explorer\.exe$/i.test(w.process) && w.title === 'Program Manager') {
        ctx.app = 'Desktop'
        ctx.title = undefined
      }
      if (this.isBrowser(w)) {
        ctx.isBrowser = true
        ctx.url = this.activeUrl()
        const draft = await this.readDraft().catch(() => null)
        if (draft && draft.trim()) ctx.draft = draft.slice(0, 20_000)
      }
    }
    if (fg && !this.isOwn(fg)) {
      const sel = await this.readSelectionNow(fg)
      if (sel.text) {
        ctx.selection = sel.text.slice(0, 100_000)
        ctx.selectionMethod = sel.method === 'uia' ? 'uia' : 'clipboard'
      } else ctx.selectionNote = sel.note
    }
    this.summon = ctx
    return ctx
  }

  private async readSelectionNow(fg: WinInfo): Promise<SelectionResult> {
    try {
      const r = await this.native.call<{ text: string; method: string; note?: string }>('selection', {}, 2500)
      if (r.text && r.text.trim()) return { text: r.text, method: 'uia', app: fg.process }
    } catch (err) {
      log.debug('uia selection failed', String(err))
    }
    // Fallback: copy with Ctrl+C and restore the clipboard. Never in terminals (Ctrl+C interrupts).
    if (this.isTerminal(fg)) return { text: '', method: 'none', note: 'Selections in terminals cannot be read safely; paste the text instead.' }
    return this.copySelection()
  }

  private async copySelection(): Promise<SelectionResult> {
    // Snapshot every clipboard format so the user's clipboard comes back exactly as it was.
    const saved = await clipboard.read().catch(() => null)
    const beforeSeq = await this.native.call<number>('clipSeq').catch(() => -1)
    try {
      await this.native.call('sendKeys', { keys: 'ctrl+c' })
      let text = ''
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 25))
        const seq = await this.native.call<number>('clipSeq').catch(() => -2)
        if (seq !== beforeSeq) {
          text = await clipboard.readText()
          break
        }
      }
      if (!text) return { text: '', method: 'none', note: 'No text was selected (or the app does not support copying it).' }
      return { text, method: 'clipboard' }
    } catch (err) {
      return { text: '', method: 'none', note: `Could not read the selection: ${(err as Error).message}` }
    } finally {
      setTimeout(() => {
        if (saved && saved.length) void clipboard.write(saved).catch(() => {})
        else clipboard.clear()
      }, 60)
    }
  }

  get summonContext(): SummonContext | null {
    return this.summon
  }

  clearSummon(): void {
    this.summon = null
  }

  // ---------- host capabilities for the agent ----------

  async active(): Promise<ActiveContext> {
    const w = await this.target()
    if (!w) return { app: '', title: '', available: false, note: this.native.error ?? 'No active window is known yet.' }
    const b = NativeHelper.toDip(w.bounds)
    return { app: prettyApp(w.process), title: w.title, processPath: w.path, pid: w.pid, bounds: b, url: this.isBrowser(w) ? this.activeUrl() : undefined, available: true }
  }

  async selection(fresh: boolean): Promise<SelectionResult> {
    if (this.summon?.selection) return { text: this.summon.selection, method: 'summon', app: this.summon.app }
    if (!fresh) return { text: '', method: 'none', note: this.summon?.selectionNote ?? 'Nothing was selected when Clawd was summoned.' }
    const w = await this.target()
    if (!w) return { text: '', method: 'none', note: 'No application to read from.' }
    // Bring the user's app forward, then read its selection.
    await this.native.call('focusWindow', { hwnd: w.hwnd }).catch(() => false)
    await new Promise((r) => setTimeout(r, 120))
    return this.readSelectionNow(w)
  }

  async windowText(maxChars: number): Promise<WindowTextResult> {
    const w = await this.target()
    if (!w) return { text: '', app: '', title: '', truncated: false, method: 'none', note: 'No active window is known.' }
    try {
      const r = await this.native.call<{ text: string; truncated: boolean; process: string; title: string; note?: string }>('windowText', { hwnd: w.hwnd, maxChars }, 15000)
      return { text: r.text, app: r.process.replace(/\.exe$/i, ''), title: r.title, truncated: r.truncated, method: r.text ? 'uia' : 'none', note: r.note }
    } catch (err) {
      return { text: '', app: w.process, title: w.title, truncated: false, method: 'none', note: (err as Error).message }
    }
  }

  async elements(query: string, max: number): Promise<{ app: string; elements: UiElement[]; note?: string }> {
    const w = await this.target()
    if (!w) return { app: '', elements: [], note: 'No active window is known.' }
    try {
      const r = await this.native.call<{ process: string; elements: UiElement[]; note?: string }>('elements', { hwnd: w.hwnd, query, max }, 15000)
      return { app: r.process.replace(/\.exe$/i, ''), elements: r.elements.map((e) => ({ ...e, rect: NativeHelper.toDip(e.rect) })), note: r.note }
    } catch (err) {
      return { app: w.process, elements: [], note: (err as Error).message }
    }
  }

  async screenshot(target: 'screen' | 'window', maxWidth: number): Promise<Screenshot> {
    const w = await this.target()
    const r = await this.native.call<Screenshot>('screenshot', { hwnd: w?.hwnd, target, maxWidth }, 15000)
    return { ...r, note: target === 'window' && w ? `Window: ${w.process} - ${w.title}` : undefined }
  }
}
