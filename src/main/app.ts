// ClawdApp wires the subsystems together: windows, companion state, agent service, voice,
// screen context, Claude Code, the browser bridge, shortcuts, tray, notifications and startup.

import { app, clipboard, dialog, Menu, nativeTheme, screen, shell, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentSnapshot, AppInfo, SummonContext, TaskSummary, UndoResult } from '../shared/api'
import type { HostApi } from '../shared/host'
import { DEFAULT_SHORTCUTS, type ProviderId, type Settings, type ShortcutAction } from '../shared/settings'
import type { ShortcutCheck } from '../shared/keybinds'
import { prettyApp } from '../shared/apps'
import type { AgentEvent, AgentPhase, IntegrationStatus, MemoryItem, PermissionRequest, ProviderStatus, SkillInfo, TaskRecord } from '../shared/types'
import { BrainHost, type HostImpl } from './brain-host'
import { BridgeServer } from './bridge'
import { BrowserBridge } from './browser-bridge'
import { HookInstaller, SessionTracker } from './claude-code'
import { Companion } from './companion'
import { ScreenContext } from './context'
import { FocusMode } from './focus'
import { registerIpc, type Handlers } from './ipc'
import { logger, logTail } from './log'
import { ModelManager } from './models'
import { NativeHelper } from './native'
import { Notifier } from './notifications'
import { fetchPage } from './page-fetch'
import { dataDir, resourcePath, subdir } from './paths'
import type { Secrets } from './secrets'
import type { SettingsStore } from './settings-store'
import { Shortcuts } from './shortcuts'
import { applyStartup, launchedAtStartup, startupStatus } from './startup'
import { classifyClip, Suggestions } from './suggestions'
import { ClawdTray } from './tray'
import { VoiceHost } from './voice-host'
import { OverlayManager } from './windows/overlay'
import { PanelWindow } from './windows/panel'
import { SettingsWindow } from './windows/settings'

const log = logger('app')
/** Tried in order when the default summon shortcut belongs to another app. */
const SUMMON_ALTERNATIVES = ['Ctrl+Alt+C', 'Ctrl+Alt+K', 'Ctrl+Alt+Shift+C']

/** Short spoken version of a long answer. */
export function spokenSummary(text: string): { speech: string; truncated: boolean } {
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim()
  if (clean.length <= 360) return { speech: clean, truncated: false }
  const sentences = clean.match(/[^.!?]+[.!?]+/g) ?? [clean.slice(0, 300)]
  let out = ''
  for (const s of sentences) {
    if ((out + s).length > 300) break
    out += s
  }
  return { speech: `${(out || sentences[0]).trim()} The rest is in my panel.`, truncated: true }
}

export class ClawdApp {
  readonly native = new NativeHelper()
  readonly overlays: OverlayManager
  readonly companion: Companion
  readonly context: ScreenContext
  readonly notifier: Notifier
  readonly focus: FocusMode
  readonly bridge = new BridgeServer()
  readonly browser = new BrowserBridge()
  readonly cc = new SessionTracker()
  readonly hooks = new HookInstaller()
  readonly models = new ModelManager()
  readonly voice: VoiceHost
  readonly brain: BrainHost
  readonly panel: PanelWindow
  readonly settingsWin = new SettingsWindow()
  readonly suggestions: Suggestions
  shortcuts!: Shortcuts
  tray!: ClawdTray
  private phase: AgentPhase = 'idle'
  private taskId: string | null = null
  /** Where the next transcript goes: the open panel's ask bar, or a bubble over Clawd. */
  private listenTarget: 'panel' | 'bubble' = 'bubble'
  private pending = new Map<string, PermissionRequest>()
  private asking = new Set<string>()
  private provider: ProviderStatus | null = null
  private bubbleTargets = new Map<string, (action: string) => void>()
  private lastGlance = 0
  private clipSeq = -1
  private clipTimer: NodeJS.Timeout | null = null
  private taskStarted = new Map<string, number>()

  constructor(
    readonly settings: SettingsStore,
    readonly secrets: Secrets,
  ) {
    this.overlays = new OverlayManager(settings)
    this.companion = new Companion(this.overlays, settings)
    this.context = new ScreenContext(this.native, settings)
    this.notifier = new Notifier(settings)
    this.focus = new FocusMode(settings)
    this.voice = new VoiceHost(settings, this.models)
    this.panel = new PanelWindow(() => {
      const p = this.overlays.clawdScreenPoint()
      return { x: p.x, y: p.y, scale: this.settings.get().companion.size }
    })
    this.brain = new BrainHost(dataDir(), fs.existsSync(resourcePath('skills')) ? resourcePath('skills') : null, () => settings.get(), this.hostImpl())
    this.suggestions = new Suggestions(settings, this.companion)
  }

  // ---------- startup ----------

  async start(): Promise<void> {
    const s = this.settings.get()
    this.native.start()
    this.context.activeUrl = () => this.browser.activeUrl()
    this.context.readDraft = async () => {
      if (!this.browser.connected || !this.settings.get().privacy.browserAccess) return null
      const d = await this.browser.getDraft(1200)
      return d.found ? d.text : null
    }
    await this.bridge.start()
    this.bridge.on('browser', (ws) => this.browser.attach(ws))
    this.bridge.on('cc', (ev) => {
      if (this.settings.get().integrations.claudeCode) this.cc.handle(ev)
    })
    this.browser.on('status', () => this.broadcast('browser:status', this.browserStatus()))
    this.wireCompanion()
    this.wireAgent()
    this.wireVoice()
    this.wireClaudeCode()
    this.wireContext()
    this.wireSettings()
    this.tray = new ClawdTray({
      summon: () => void this.summon(),
      toggleVisible: () => this.toggleVisible(),
      toggleVoice: () => void this.toggleVoice(),
      toggleWake: () => this.settings.set({ voice: { wakeWord: !this.settings.get().voice.wakeWord } }),
      toggleFocus: () => this.focus.toggle(),
      openSettings: (section) => this.settingsWin.open(section),
      cancelTask: () => this.cancel(),
      quit: () => app.quit(),
    })
    this.shortcuts = new Shortcuts({
      summon: () => void this.summon(),
      voice: () => void this.toggleVoice(),
      cancel: () => this.cancel(),
      toggleVisible: () => this.toggleVisible(),
      focusMode: () => this.focus.toggle(),
      settings: () => this.settingsWin.open(),
    })
    this.shortcuts.on('changed', (list) => this.broadcast('shortcuts:changed', list))
    this.shortcuts.apply(s.shortcuts)
    const summonMoved = await this.rescueSummonShortcut()
    registerIpc(this.handlers(), (e) => this.trusted(e))
    // A dev copy only touches the login item when asked to, so it never removes an installed Clawd's entry.
    if (app.isPackaged || s.general.startWithWindows) applyStartup(s.general.startWithWindows)
    this.overlays.start()
    this.brain.start()
    this.panel.warm()
    // At login, show Clawd per preference and initialise heavier parts a little later.
    const atLogin = launchedAtStartup()
    const visible = atLogin ? !s.general.startInTray && s.general.showOnStartup : s.general.showOnStartup
    this.companion.setVisibility(visible ? 'present' : 'hidden')
    this.companion.setFocus(this.focus.isActive)
    setTimeout(() => this.voice.apply(), atLogin ? 6000 : 800)
    setTimeout(() => this.applyClipboardMonitor(), 2000)
    this.updateTray()
    void this.scanEdgeBars()
    setInterval(() => void this.scanEdgeBars(), 20000)
    if (!s.general.onboarded) setTimeout(() => this.welcome(), 2200)
    else if (summonMoved) setTimeout(() => this.tellSummonMoved(summonMoved), 2200)
    else if (this.wakeQuestionNeeded()) setTimeout(() => this.askWakeWord(), 2200)
    if (this.settings.recovered) this.companion.bubble(this.settings.recovered, { ttl: 10, tone: 'attention' })
    log.info('Clawd started', { atLogin, visible })
  }

  private trusted(e: IpcMainInvokeEvent): boolean {
    const url = e.senderFrame?.url ?? ''
    return url.startsWith('file:') || (!!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))
  }

  private broadcast(channel: Parameters<SettingsWindow['send']>[0], payload: unknown): void {
    this.panel.send(channel as never, payload as never)
    this.settingsWin.send(channel as never, payload as never)
  }

  // ---------- summon / visibility ----------

  /** Finds always-on-top bars (YASB, docks) that sit on the work area, so Clawd stands on them. */
  private async scanEdgeBars(): Promise<void> {
    const bars = await this.native.call<{ x: number; y: number; w: number; h: number }[]>('edgeBars').catch(() => null)
    if (!bars) return
    const insets = new Map<number, number>()
    for (const d of screen.getAllDisplays()) {
      const wa = d.workArea
      let inset = 0
      for (const raw of bars) {
        const b = NativeHelper.toDip(raw)
        const spansWidth = b.w >= wa.width * 0.5 && b.x < wa.x + wa.width && b.x + b.w > wa.x
        const atBottom = b.y + b.h >= wa.y + wa.height - 4 && b.y > wa.y + wa.height / 2
        if (spansWidth && atBottom) inset = Math.max(inset, wa.y + wa.height - b.y)
      }
      if (inset > 0 && inset < 160) insets.set(d.id, Math.round(inset))
    }
    this.overlays.setBottomInsets(insets)
  }

  private wakeQuestionNeeded(): boolean {
    const v = this.settings.get().voice
    return v.enabled && v.wakeWord && !v.wakeConsent && this.settings.get().privacy.microphone
  }

  /**
   * The summon shortcut is the main way in. If the default is taken by another app (and the user
   * never changed it), move it to a free alternative instead of failing silently.
   */
  private async rescueSummonShortcut(): Promise<{ from: string; to: string } | null> {
    const st = this.shortcuts.list().find((x) => x.action === 'summon')
    const current = this.settings.get().shortcuts.summon
    if (!st || st.registered || current !== DEFAULT_SHORTCUTS.summon) return null
    for (const alt of SUMMON_ALTERNATIVES) {
      const res = await this.checkShortcut('summon', alt)
      if (!res.ok) continue
      this.settings.set({ shortcuts: { summon: alt } })
      log.info('summon shortcut taken; moved', { from: current, to: alt })
      return { from: current, to: alt }
    }
    return null
  }

  private tellSummonMoved(m: { from: string; to: string }): void {
    const id = this.companion.bubble(`${m.from.replace(/\+/g, ' + ')} is taken by another app, so press ${m.to.replace(/\+/g, ' + ')} to call me.`, {
      ttl: 10,
      actions: [{ id: 'shortcuts', label: 'Change it' }],
    })
    this.bubbleTargets.set(id, () => this.settingsWin.open('shortcuts'))
    if (this.wakeQuestionNeeded()) setTimeout(() => this.askWakeWord(), 10500)
  }

  /** Checks a shortcut, including whether Ctrl+Alt+key types a character on this keyboard layout (AltGr). */
  private async checkShortcut(action: ShortcutAction, accel: string): Promise<ShortcutCheck> {
    const res = this.shortcuts.check(action, accel)
    const m = /^Ctrl\+Alt\+(Shift\+)?([A-Z0-9])$/i.exec(accel)
    if (res.ok && m && this.native.available) {
      const ch = await this.native.call<string>('altGr', { vk: m[2].toUpperCase().charCodeAt(0), shift: !!m[1] }).catch(() => '')
      res.warnings = res.warnings.filter((w) => !w.includes('AltGr'))
      if (ch) return { ok: false, error: `On your keyboard layout this combination types "${ch}" (AltGr).`, warnings: res.warnings }
    }
    return res
  }

  private welcome(): void {
    this.settings.set({ general: { onboarded: true } })
    const sc = this.settings.get().shortcuts.summon
    this.companion.play('wave')
    const id = this.companion.bubble(`Hi, I'm Clawd! Double-click me or press ${sc.replace(/\+/g, ' + ')} whenever you need me.`, {
      ttl: 9,
      actions: [{ id: 'ok', label: 'Hi Clawd!', primary: true }],
    })
    this.bubbleTargets.set(id, () => {
      this.companion.play('hop')
      if (this.wakeQuestionNeeded()) setTimeout(() => this.askWakeWord(), 700)
    })
    setTimeout(() => {
      if (this.bubbleTargets.has(id) && this.wakeQuestionNeeded()) {
        this.bubbleTargets.delete(id)
        this.askWakeWord()
      }
    }, 9500)
  }

  private askWakeWord(): void {
    if (!this.models.present) {
      // Voice first, wake word second: the download is for talking at all; the always-on
      // microphone gets its own question (with its disclosure) once the models are here.
      const id = this.companion.bubble('Want to talk to me? I listen when you open me and can answer out loud. That needs a one-time 620 MB download that runs only on this PC.', {
        ttl: 0,
        actions: [{ id: 'yes', label: 'Download', primary: true }, { id: 'no', label: 'Type only' }],
      })
      this.bubbleTargets.set(id, (a) => {
        if (a === 'yes') {
          this.models.once('done', () => {
            if (this.models.present && this.wakeQuestionNeeded()) setTimeout(() => this.askWakeWord(), 1200)
          })
          void this.models.download()
        } else this.settings.set({ voice: { wakeWord: false } })
      })
      return
    }
    const id = this.companion.bubble('Should I listen for "Hey Clawd"? Your microphone stays on while I listen, and what you say is processed only on this PC.', {
      ttl: 0,
      actions: [{ id: 'yes', label: 'Listen for it', primary: true }, { id: 'no', label: 'Not now' }],
    })
    this.bubbleTargets.set(id, (a) => {
      if (a === 'yes') {
        this.settings.set({ voice: { wakeConsent: true } })
        this.companion.play('celebrate')
      } else this.settings.set({ voice: { wakeWord: false } })
    })
  }

  /** Summons Clawd: grabs the user's context first (while their app still has focus). */
  async summon(opts: { panel?: boolean } = {}): Promise<void> {
    // Voice first: the microphone starts at once so the first words aren't lost while the context
    // (which needs the user's app to still have focus) is read; the panel shows it as listening.
    const s = this.settings.get()
    if (opts.panel !== false && s.voice.listenOnSummon && s.voice.enabled && s.privacy.microphone && this.models.present && !this.voice.isCapturing) {
      void this.listen('panel', true)
    }
    let ctx: SummonContext | null = null
    try {
      ctx = await this.context.captureSummon()
    } catch (err) {
      log.warn('summon context failed', String(err))
    }
    void this.brain.call('summonContext', ctx).catch(() => {})
    this.companion.summon()
    if (opts.panel === false) return
    this.panel.show(true, { context: ctx })
  }

  toggleVisible(): void {
    if (this.companion.state.visibility === 'hidden') this.companion.setVisibility('present')
    else {
      this.panel.hide()
      this.companion.hide()
    }
    this.updateTray()
  }

  cancel(): void {
    void this.brain.call('cancel').catch(() => {})
    this.voice.cancelCapture()
    this.voice.stopSpeaking()
    this.companion.setListening(false)
    this.overlays.send('overlay:point', null)
    this.companion.clearBubble()
  }

  async toggleVoice(): Promise<void> {
    if (this.voice.isCapturing) {
      this.voice.cancelCapture()
      return
    }
    const s = this.settings.get()
    if (!s.voice.enabled || !s.privacy.microphone) {
      this.companion.bubble(!s.privacy.microphone ? 'Microphone access is off in Settings > Permissions & privacy.' : 'Voice input is turned off in Settings > Voice.', { ttl: 5, actions: [{ id: 'open', label: 'Open settings' }] })
      return
    }
    if (!this.models.present) {
      this.companion.bubble('My voice models are not downloaded yet.', { ttl: 8, actions: [{ id: 'download', label: 'Download (620 MB)', primary: true }] })
      return
    }
    if (this.panel.visible) await this.listen('panel')
    else await this.summonForVoice()
  }

  private async summonForVoice(): Promise<void> {
    const ctx = await this.context.captureSummon().catch(() => null)
    void this.brain.call('summonContext', ctx).catch(() => {})
    this.companion.summon()
    await this.listen('bubble')
  }

  /** Starts listening; `quiet` skips the bubble when the microphone can't start (the panel still works by typing). */
  private async listen(target: 'panel' | 'bubble', quiet = false): Promise<boolean> {
    this.listenTarget = target
    this.companion.setListening(true)
    // The panel gives a little longer before giving up: people read the panel first.
    const ok = await this.voice.startCapture(target === 'panel' ? 8 : 6)
    if (!ok) {
      this.companion.setListening(false)
      if (!quiet) this.companion.bubble(this.voice.status().error ?? "I can't hear you right now; check the microphone in Settings > Voice.", { ttl: 6, tone: 'attention' })
    }
    return ok
  }

  // ---------- wiring ----------

  private wireCompanion(): void {
    this.overlays.on('interaction', (i: { kind: string }) => {
      this.companion.touch()
      if (i.kind === 'doubleClick') void this.summon()
      if (i.kind === 'contextMenu') this.contextMenu()
    })
    this.overlays.on('bubbleAction', ({ bubbleId, actionId }: { bubbleId: string; actionId: string }) => {
      if (this.suggestions.handleAction(bubbleId, actionId)) return
      const target = this.bubbleTargets.get(bubbleId)
      if (target) {
        this.bubbleTargets.delete(bubbleId)
        target(actionId)
        return
      }
      if (actionId === 'open') this.settingsWin.open('voice')
      if (actionId === 'download') void this.models.download()
    })
    this.overlays.on('pointerActivity', () => {})
    this.companion.on('state', (st) => {
      this.panel.send('companion:state' as never, st as never)
      this.updateTray()
    })
    this.panel.on('visibility', (v: boolean) => {
      this.companion.setPanelOpen(v)
      if (!v && this.listenTarget === 'panel') this.voice.cancelCapture()
    })
    this.panel.busy = () => !!this.taskId || this.pending.size > 0 || this.asking.size > 0
    this.suggestions.busy = () => this.phase !== 'idle' && this.phase !== 'done' || this.companion.state.panelOpen || this.voice.isCapturing
    this.focus.on('change', (on: boolean) => {
      this.companion.setFocus(on)
      this.updateTray()
    })
    this.notifier.focus = () => this.focus.isActive
    this.notifier.onClick = (taskId) => {
      this.panel.show(false)
      if (taskId) this.panel.send('panel:show', { section: 'chat', taskId })
    }
  }

  private contextMenu(): void {
    const win = this.overlays.homeWindow()
    const s = this.settings.get()
    const menu = Menu.buildFromTemplate([
      { label: 'Talk to Clawd', click: () => void this.summon() },
      { label: 'Voice input', enabled: s.voice.enabled, click: () => void this.toggleVoice() },
      { type: 'separator' },
      { label: 'Focus mode', type: 'checkbox', checked: this.focus.isActive, click: () => this.focus.toggle() },
      { label: 'Hide Clawd', click: () => this.toggleVisible() },
      { label: 'Return to corner', click: () => this.settings.set({ companion: { corner: 'bottom-right' } }) },
      { type: 'separator' },
      { label: 'Settings', click: () => this.settingsWin.open() },
      { label: 'Quit Clawd', click: () => app.quit() },
    ])
    if (win) menu.popup({ window: win })
  }

  private wireAgent(): void {
    this.brain.on('agent', (e: AgentEvent) => this.onAgentEvent(e))
    this.brain.on('status', () => this.broadcast('integrations:changed', this.integrations()))
    this.brain.on('interrupted', (list: { id: string; request: string }[]) => {
      this.companion.bubble(`I was interrupted while working on "${list[0].request.slice(0, 60)}". It's in the task history.`, { ttl: 8 })
    })
  }

  private onAgentEvent(e: AgentEvent): void {
    this.panel.send('agent:event', e)
    this.settingsWin.send('agent:event', e)
    switch (e.type) {
      case 'phase': {
        const prev = this.phase
        this.phase = e.phase
        this.taskId = e.phase === 'idle' || e.phase === 'done' || e.phase === 'error' || e.phase === 'cancelled' ? null : e.taskId
        if (e.taskId && prev === 'idle') this.taskStarted.set(e.taskId, Date.now())
        this.companion.setAgent(e.phase)
        if (e.phase === 'error' && !this.panel.visible) this.companion.bubble(e.detail ?? 'Something went wrong.', { ttl: 8, tone: 'attention' })
        if (e.phase === 'done' || e.phase === 'error') {
          const started = e.taskId ? this.taskStarted.get(e.taskId) : undefined
          const long = started && Date.now() - started > this.settings.get().notifications.minTaskSeconds * 1000
          if (long && !this.panel.visible) {
            if (e.phase === 'done') this.notifier.show('taskDone', 'Clawd finished a task', 'Open Clawd to see the result.', { taskId: e.taskId ?? undefined })
            else this.notifier.show('taskFailed', 'A task did not finish', e.detail ?? 'Open Clawd for details.', { taskId: e.taskId ?? undefined })
          }
        }
        this.updateTray()
        break
      }
      case 'permission':
        this.pending.set(e.request.id, e.request)
        this.companion.setNeedsUser(true)
        if (!this.panel.visible) this.permissionBubble(e.request)
        this.notifier.show('permission', 'Clawd needs your OK', e.request.title, { taskId: e.request.taskId, critical: true, key: e.request.id })
        break
      case 'permission_resolved':
        this.pending.delete(e.id)
        this.companion.setNeedsUser(this.pending.size > 0 || this.asking.size > 0)
        break
      case 'clarify':
        this.asking.add(e.request.id)
        this.companion.setNeedsUser(true)
        if (!this.panel.visible) this.panel.show(true)
        break
      case 'clarify_resolved':
        this.asking.delete(e.id)
        this.companion.setNeedsUser(this.pending.size > 0 || this.asking.size > 0)
        break
      case 'speak': {
        const { speech, truncated } = spokenSummary(e.text)
        void this.voice.speak(speech)
        if (truncated && !this.panel.visible) this.panel.show(false)
        else if (!this.panel.visible) this.companion.bubble(e.text.slice(0, 260) + (e.text.length > 260 ? '…' : ''), { ttl: 12 })
        break
      }
      case 'message':
        if (e.message.role === 'assistant' && !this.panel.visible && this.companion.state.visibility !== 'hidden') {
          const t = e.message.text
          if (!this.voice.isSpeaking) this.companion.bubble(t.length > 220 ? t.slice(0, 220) + '… (open me for more)' : t, { ttl: Math.min(20, 6 + t.length / 40) })
        }
        break
      case 'memory_proposal': {
        if (this.panel.visible) break
        const id = this.companion.bubble(`Should I remember this?\n"${e.text}"`, { ttl: 20, actions: [{ id: 'yes', label: 'Remember', primary: true }, { id: 'no', label: 'No' }] })
        this.bubbleTargets.set(id, (a) => void this.brain.call('memoryProposal', e.id, a === 'yes').catch(() => {}))
        break
      }
      case 'notice':
        this.companion.bubble(e.text, { ttl: 6 })
        break
    }
  }

  private permissionBubble(r: PermissionRequest): void {
    const actions = r.risk === 'high' ? [{ id: 'review', label: 'Review', primary: true }, { id: 'deny', label: 'Deny' }] : [{ id: 'allow', label: 'Allow', primary: true }, { id: 'deny', label: 'Deny' }, { id: 'review', label: 'Details' }]
    const id = this.companion.bubble(`May I ${r.title.charAt(0).toLowerCase() + r.title.slice(1)}?\n${r.details.split('\n')[0].slice(0, 120)}`, { ttl: 0, tone: 'attention', actions })
    this.bubbleTargets.set(id, (a) => {
      if (a === 'allow') void this.brain.call('decide', r.id, 'allow_once')
      else if (a === 'deny') void this.brain.call('decide', r.id, 'deny')
      else this.panel.show(false)
    })
  }

  private wireVoice(): void {
    this.voice.on('wake', () => {
      if (this.voice.isCapturing) return
      this.companion.touch()
      if (this.voice.isSpeaking) this.voice.stopSpeaking()
      void this.summonForVoice()
    })
    this.voice.on('level', (v: number) => {
      this.companion.setLevel(v)
      if (this.listenTarget === 'panel' && this.panel.visible) this.panel.send('voice:level', v)
    })
    this.voice.on('speakLevel', (v: number) => this.companion.setLevel(v))
    this.voice.on('speaking', (on: boolean) => this.companion.setSpeaking(on))
    this.voice.on('captureEnd', (why: string) => {
      this.companion.setListening(false)
      // In the panel the ask bar says it all; a bubble would talk over it.
      if (why === 'timeout' && !(this.listenTarget === 'panel' && this.panel.visible)) this.companion.bubble("I didn't hear anything. Say \"Hey Clawd\" when you need me.", { ttl: 4 })
    })
    this.voice.on('transcript', (text: string) => {
      this.companion.setListening(false)
      const t = text.trim()
      const toPanel = this.listenTarget === 'panel' && this.panel.visible
      if (/^(cancel|stop|never ?mind|forget it)[.!]?$/i.test(t)) {
        this.cancel()
        if (toPanel) this.panel.hide()
        else this.companion.bubble('Okay, stopped.', { ttl: 3 })
        return
      }
      if (toPanel) {
        // The panel sends it like typed text (with its context toggle), marked as spoken.
        this.panel.send('panel:voiceText', { text: t })
        return
      }
      if (!t) {
        this.companion.bubble("Sorry, I didn't catch that.", { ttl: 4 })
        return
      }
      this.companion.bubble(`"${t}"`, { ttl: 5 })
      this.panel.send('panel:focusInput', { text: '' })
      void this.brain.call('send', t, { source: 'voice' }).catch((err) => this.companion.bubble(String((err as Error).message), { ttl: 6, tone: 'attention' }))
    })
    this.voice.on('status', (st) => {
      this.broadcast('voice:status', st)
      this.updateTray()
    })
  }

  private wireClaudeCode(): void {
    this.cc.on('changed', (list) => {
      this.broadcast('cc:sessions', list)
      const f = this.cc.focus()
      this.companion.setCC(f ? f.state : null)
    })
    this.cc.on('state', (s, prev) => {
      const n = this.settings.get().notifications
      if (!n.claudeCode) return
      if (s.state === 'waiting_approval' && s.certain) this.notifier.show('claudeCode', `Claude Code needs approval (${s.project})`, s.message ?? `Waiting to use ${s.tool ?? 'a tool'}`, { key: `cc-appr-${s.id}-${s.updatedAt}` })
      if (s.state === 'waiting_input') this.notifier.show('claudeCode', `Claude Code is waiting for you (${s.project})`, s.message ?? 'It finished and is waiting for input.', { key: `cc-in-${s.id}` })
      if (s.state === 'failed') this.notifier.show('claudeCode', `Claude Code hit an error (${s.project})`, s.lastError ?? 'The turn ended with an error.', { key: `cc-fail-${s.id}-${s.updatedAt}` })
      if (s.state === 'completed' && prev !== 'idle' && Date.now() - s.startedAt > 60_000 && !this.panel.visible) this.notifier.show('claudeCode', `Claude Code finished (${s.project})`, 'The session is done.', { key: `cc-done-${s.id}-${s.updatedAt}` })
    })
    this.cc.on('toolError', (s) => {
      this.suggestions.offer({
        kind: 'builds',
        key: Suggestions.keyOf('cc', s.id, String(s.lastError).slice(0, 80)),
        text: `Claude Code hit an error in ${s.project}. Want me to look into it?`,
        actions: [{ id: 'go', label: 'Look into it', primary: true }],
        run: () => void this.ask(`Investigate the latest error in the Claude Code session for ${s.project} and explain what went wrong and how to fix it.`),
      })
    })
  }

  private wireContext(): void {
    this.context.on('foreground', (w) => {
      this.focus.setForeground(w.process)
      // A quiet glance toward the newly focused window now and then.
      const now = Date.now()
      if (now - this.lastGlance > 9000 && !this.focus.isActive && this.settings.get().appearance.cursorFollow) {
        this.lastGlance = now
        const b = NativeHelper.toDip(w.bounds)
        this.companion.glance(b.x + b.w / 2, b.y + Math.min(b.h / 2, 200), 1.4)
      }
    })
    this.context.on('dialog', (w) => {
      const b = NativeHelper.toDip(w.bounds)
      this.companion.glance(b.x + b.w / 2, b.y + b.h / 2, 2)
      if (/error|failed|exception|problem|not responding|warning|crash/i.test(w.title) || /werfault/i.test(w.process)) {
        this.suggestions.offer({
          kind: 'errors',
          key: Suggestions.keyOf('dialog', w.process, w.title),
          text: `That looks like an error from ${w.process.replace(/\.exe$/i, '')}. Want me to explain it?`,
          actions: [{ id: 'explain', label: 'Explain', primary: true }],
          run: () => void this.ask(`Explain the error dialog "${w.title}" that just appeared (read it with read_window_text) and suggest how to fix it.`),
        })
      }
    })
  }

  /** Starts a task from a suggestion or bubble action. */
  async ask(text: string, source: TaskRecord['source'] = 'suggestion', context?: SummonContext): Promise<void> {
    if (context) await this.brain.call('summonContext', context)
    this.panel.show(false)
    await this.brain.call('send', text, { source })
  }

  private applyClipboardMonitor(): void {
    const on = this.settings.get().privacy.clipboardMonitor
    if (on && !this.clipTimer) {
      this.clipTimer = setInterval(() => void this.pollClipboard(), 1200)
    } else if (!on && this.clipTimer) {
      clearInterval(this.clipTimer)
      this.clipTimer = null
      this.clipSeq = -1
    }
  }

  private async pollClipboard(): Promise<void> {
    const seq = await this.native.call<number>('clipSeq').catch(() => -1)
    if (seq < 0 || seq === this.clipSeq) return
    const first = this.clipSeq === -1
    this.clipSeq = seq
    if (first) return
    const text = await clipboard.readText()
    if (!text || text.length < 40 || text.length > 50_000) return
    const kind = classifyClip(text)
    const offers: Record<string, { text: string; actions: { id: string; label: string; primary?: boolean }[]; prompts: Record<string, string> }> = {
      code: { text: 'You copied some code. Want me to explain it?', actions: [{ id: 'explain', label: 'Explain', primary: true }], prompts: { explain: 'Explain what this copied code does, step by step.' } },
      error: { text: 'That looks like an error message. Want me to explain it?', actions: [{ id: 'explain', label: 'Explain', primary: true }], prompts: { explain: 'Explain this error and how to fix it.' } },
      prose: {
        text: 'You copied a longer text. Want a summary or a polish?',
        actions: [{ id: 'summary', label: 'Summarize', primary: true }, { id: 'improve', label: 'Improve it' }],
        prompts: { summary: 'Summarize the copied text in a few bullet points.', improve: 'Improve the writing of the copied text; keep its meaning and tone.' },
      },
      url: { text: 'Want me to summarize that link?', actions: [{ id: 'sum', label: 'Summarize', primary: true }], prompts: { sum: 'Read and summarize the copied web page.' } },
    }
    const o = offers[kind]
    if (!o) return
    this.suggestions.offer({
      kind: 'clipboard',
      key: Suggestions.keyOf('clip', text.slice(0, 500)),
      text: o.text,
      actions: o.actions,
      run: (id) => void this.ask(o.prompts[id], 'clipboard', { capturedAt: Date.now(), app: 'Clipboard', selection: text, selectionMethod: 'clipboard' }),
    })
  }

  private wireSettings(): void {
    nativeTheme.on('updated', () => this.settingsWin.setTheme(this.isDark()))
    this.settings.onChange((next, prev, changed) => {
      this.broadcast('settings:changed', next)
      this.overlays.applySettings(prev, next)
      this.brain.pushSettings(next)
      if (changed.some((c) => c.startsWith('shortcuts.'))) this.shortcuts.apply(next.shortcuts)
      if (next.general.startWithWindows !== prev.general.startWithWindows) applyStartup(next.general.startWithWindows)
      if (changed.some((c) => c.startsWith('voice.') || c === 'privacy.microphone')) this.voice.apply()
      if (changed.includes('privacy.clipboardMonitor')) this.applyClipboardMonitor()
      if (changed.includes('general.theme')) {
        nativeTheme.themeSource = next.general.theme
        this.settingsWin.setTheme(this.isDark())
      }
      if (!next.privacy.microphone && prev.privacy.microphone) this.voice.cancelCapture()
    })
    nativeTheme.themeSource = this.settings.get().general.theme
  }

  private isDark(): boolean {
    return nativeTheme.shouldUseDarkColors
  }

  private updateTray(): void {
    if (!this.tray) return
    const st = this.companion.state
    const s = this.settings.get()
    const status = this.phase === 'working' || this.phase === 'thinking' ? 'working' : this.pending.size ? 'needs your OK' : st.listening ? 'listening' : this.focus.isActive ? 'focus mode' : ''
    this.tray.update({ visible: st.visibility !== 'hidden', focus: this.focus.isActive, voiceAvailable: s.voice.enabled && this.models.present, wakeOn: s.voice.wakeWord, busy: !!this.taskId, status })
  }

  // ---------- status ----------

  private browserStatus() {
    return {
      enabled: this.settings.get().integrations.browser,
      connected: this.browser.connected,
      clients: this.browser.clientList(),
      port: this.bridge.port,
      token: this.bridge.token,
      extensionPath: resourcePath('extension'),
    }
  }

  integrations(): IntegrationStatus[] {
    const s = this.settings.get()
    const cc = this.hooks.status(true, this.cc.lastEventAt)
    const voice = this.voice.status()
    return [
      { id: 'model', ok: !!this.provider?.ok, label: 'AI model', detail: this.provider ? `${this.provider.model} (${this.provider.provider}): ${this.provider.message}` : 'Not checked yet' },
      { id: 'native', ok: this.native.available, label: 'Windows integration', detail: this.native.available ? 'UI Automation, input and screenshots available' : (this.native.error ?? 'Not running') },
      { id: 'voice', ok: voice.modelsPresent && !voice.error, label: 'Voice', detail: !s.voice.enabled ? 'Turned off' : voice.modelsPresent ? (voice.error ?? `Wake word: ${voice.wakeWord}`) : `Models missing: ${voice.missing.join(', ')}` },
      { id: 'claudeCode', ok: cc.installed, label: 'Claude Code', detail: cc.installed ? `Hooks installed; ${this.cc.list().length} session(s) seen` : (cc.error ?? 'Hooks not installed') },
      { id: 'browser', ok: this.browser.connected, label: 'Browser extension', detail: this.browser.connected ? this.browser.clientList().map((c) => c.browser).join(', ') : 'Not connected' },
    ]
  }

  // ---------- host capabilities for the agent service ----------

  private hostImpl(): HostImpl {
    const ok = (message: string) => ({ ok: true, message })
    const bad = (message: string) => ({ ok: false, message })
    const impl: { [K in keyof HostApi]: (...a: Parameters<HostApi[K]>) => unknown } = {
      'context.active': () => this.context.active(),
      'context.selection': (fresh) => this.context.selection(fresh),
      'context.windowText': (max) => this.context.windowText(max),
      'context.elements': (q, max) => this.context.elements(q, max),
      'context.screenshot': async (target, maxWidth) => {
        // Keep Clawd's own panel out of the picture.
        const panel = this.panel.window
        const wasVisible = panel?.isVisible()
        if (wasVisible) panel!.setOpacity(0)
        await new Promise((r) => setTimeout(r, 80))
        try {
          return await this.context.screenshot(target, maxWidth)
        } finally {
          if (wasVisible) panel!.setOpacity(1)
        }
      },
      'pointer.point': (rect, label, hold) => this.companion.point(rect, label, hold),
      'clipboard.read': () => clipboard.readText(),
      'clipboard.write': async (text) => {
        await clipboard.writeText(text)
      },
      'web.fetchPage': (url, max) => fetchPage(url, max),
      'browser.connected': () => this.browser.connected,
      'browser.getPage': async (tabId, max, scroll) => {
        if (this.browser.connected) return this.browser.getPage(tabId, max, scroll)
        // Fallback: the browser's accessible document text, then the public URL if known.
        const w = await this.context.target()
        if (w && this.context.isBrowser(w)) {
          const r = await this.context.windowText(max)
          if (r.text.length > 400) return { url: this.browser.activeUrl() ?? '', title: r.title, text: r.text, truncated: r.truncated, method: 'uia' as const, note: "Read through Windows accessibility; install Clawd's browser extension for complete pages." }
        }
        throw new Error("Clawd's browser extension is not connected, and the browser page could not be read another way. Install the extension from Settings > Integrations.")
      },
      'browser.listTabs': () => this.browser.listTabs(),
      'browser.getDraft': () => this.browser.getDraft(),
      'apps.openUrl': async (url) => {
        if (!/^https?:\/\//i.test(url)) return bad('Only web links can be opened.')
        await shell.openExternal(url)
        return ok(`Opened ${url}`)
      },
      'apps.openPath': async (p) => {
        const err = await shell.openPath(p)
        return err ? bad(err) : ok(`Opened ${p}`)
      },
      'apps.launch': (name) => this.launchApp(name),
      'files.trash': async (p) => {
        try {
          await shell.trashItem(p)
          return ok('Moved to the Recycle Bin')
        } catch (err) {
          return bad((err as Error).message)
        }
      },
      'input.type': async (text) => {
        this.companion.control()
        await this.refocusTarget()
        await this.native.call('sendText', { text }, 60000)
        return ok('Typed')
      },
      'input.keys': async (combo) => {
        this.companion.control()
        await this.refocusTarget()
        await this.native.call('sendKeys', { keys: combo })
        return ok('Pressed')
      },
      'input.click': async (x, y, button, double) => {
        // Show where the click lands first: Clawd's cursor glides there and presses.
        this.companion.control()
        if (this.companion.point({ x: x - 12, y: y - 12, w: 24, h: 24 }, button === 'right' ? 'Right-click' : 'Click', 1.2, true)) await new Promise((r) => setTimeout(r, 950))
        this.companion.control()
        const p = NativeHelper.toPhysical(x, y)
        await this.native.call('click', { x: p.x, y: p.y, button, double })
        return ok('Clicked')
      },
      notify: (title, body, taskId) => this.notifier.show('agent', title, body, { taskId }),
      'cc.sessions': () => this.cc.list(),
      'cc.selected': () => this.cc.selected,
      'secrets.get': (provider) => this.secrets.get(provider),
    }
    return impl as unknown as HostImpl
  }

  /** Brings the user's app back to the front before simulating input into it. */
  private async refocusTarget(): Promise<void> {
    const w = this.context.lastWindow
    if (w) await this.native.call('focusWindow', { hwnd: w.hwnd }).catch(() => false)
    await new Promise((r) => setTimeout(r, 120))
  }

  private async launchApp(name: string): Promise<{ ok: boolean; message: string }> {
    const roots = [path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')]
    const want = name.toLowerCase().replace(/\.(lnk|exe)$/, '')
    const found: { file: string; score: number }[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > 4 || !fs.existsSync(dir)) return
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, depth + 1)
        else if (/\.(lnk|url)$/i.test(e.name)) {
          const base = e.name.replace(/\.(lnk|url)$/i, '').toLowerCase()
          if (/uninstall/.test(base)) continue
          const score = base === want ? 3 : base.startsWith(want) ? 2 : base.includes(want) ? 1 : 0
          if (score) found.push({ file: full, score })
        }
      }
    }
    for (const r of roots) walk(r, 0)
    found.sort((a, b) => b.score - a.score || a.file.length - b.file.length)
    const best = found[0]
    if (!best) return { ok: false, message: `No application called "${name}" was found in the Start menu.` }
    const err = await shell.openPath(best.file)
    return err ? { ok: false, message: err } : { ok: true, message: `Started ${path.basename(best.file).replace(/\.(lnk|url)$/i, '')}.` }
  }

  // ---------- applying results ----------

  private async applyResult(text: string, mode: 'copy' | 'replace' | 'insert' | 'draft'): Promise<{ ok: boolean; message: string }> {
    if (mode === 'draft') {
      // Put the refined text into the page's comment box through the extension; never submits.
      if (this.browser.connected) {
        try {
          const r = await this.browser.setDraft(text)
          if (r.ok) {
            this.panel.hide()
            const w = this.context.lastWindow
            if (w) await this.native.call('focusWindow', { hwnd: w.hwnd }).catch(() => false)
            this.companion.bubble("It's in the comment box. I didn't post anything.", { ttl: 4 })
            return r
          }
        } catch {
          /* handled below */
        }
      }
      // Pasting into whatever has focus could land anywhere: copy instead and say how to finish.
      await clipboard.writeText(text)
      return { ok: false, message: "I couldn't find the comment box. It's copied, so click the box and press Ctrl+V." }
    }
    if (mode === 'copy') {
      await clipboard.writeText(text)
      return { ok: true, message: 'Copied to the clipboard.' }
    }
    const w = this.context.lastWindow
    if (!w) return { ok: false, message: 'I do not know which window to paste into. Copy the text instead.' }
    if (this.context.isTerminal(w) && mode === 'replace') return { ok: false, message: 'Replacing text in a terminal is not supported; copy it instead.' }
    const saved = await clipboard.read().catch(() => null)
    await clipboard.writeText(text)
    this.panel.hide()
    const focused = await this.native.call<boolean>('focusWindow', { hwnd: w.hwnd }).catch(() => false)
    if (!focused) {
      return { ok: false, message: `Could not switch back to ${w.process}. The text is on your clipboard; paste it with Ctrl+V.` }
    }
    await new Promise((r) => setTimeout(r, 150))
    // Insert: collapse any selection to its end first so nothing is replaced.
    if (mode === 'insert') await this.native.call('sendKeys', { keys: 'right' }).catch(() => {})
    await this.native.call('sendKeys', { keys: 'ctrl+v' })
    setTimeout(() => {
      if (saved?.length) void clipboard.write(saved).catch(() => {})
    }, 700)
    const message = `${mode === 'replace' ? 'Replaced the selection' : 'Inserted the text'} in ${prettyApp(w.process)}.`
    this.companion.bubble(message, { ttl: 3 })
    return { ok: true, message }
  }

  // ---------- IPC handlers ----------

  private handlers(): Handlers {
    const brain = <T>(m: string, ...a: unknown[]) => this.brain.call<T>(m, ...a)
    return {
      'settings:get': () => this.settings.get(),
      'settings:set': (patch) => this.settings.set(patch),
      'settings:reset': (section) => this.settings.reset(section),
      'secrets:has': (id) => this.secrets.has(id),
      'secrets:set': (id, value) => this.secrets.set(id, value),
      'secrets:clear': (id) => this.secrets.clear(id),
      'shortcuts:status': () => this.shortcuts.list(),
      'shortcuts:check': (action: ShortcutAction, accel) => this.checkShortcut(action, accel),
      'shortcuts:recording': (on) => this.shortcuts.setRecording(on),
      'startup:status': () => startupStatus(this.settings.get().general.startWithWindows),
      'agent:send': async (text, opts) => {
        // Typing or a quick action while listening means the keyboard won; a new question ends the old answer's speech.
        if (opts?.source !== 'voice') this.voice.cancelCapture()
        this.voice.stopSpeaking()
        const taskId = await brain<string>('send', text, opts ?? {})
        return { taskId }
      },
      'agent:cancel': (taskId) => brain('cancel', taskId),
      'agent:decide': (id, d) => brain('decide', id, d),
      'agent:answer': (id, text) => brain('answer', id, text),
      'agent:conversation': () => brain('conversation'),
      'agent:newConversation': () => brain('newConversation'),
      'agent:checkModel': async () => {
        const st = await brain<ProviderStatus>('checkModel')
        this.provider = st
        return st
      },
      'agent:snapshot': async () => {
        const snap = await brain<AgentSnapshot>('snapshot')
        if (snap.provider) this.provider = snap.provider
        return snap
      },
      'agent:memoryProposal': (id, accept, text) => brain('memoryProposal', id, accept, text),
      'tasks:list': () => brain<TaskSummary[]>('tasks.list'),
      'tasks:get': (id) => brain<TaskRecord | null>('tasks.get', id),
      'tasks:undo': (id, index) => brain<UndoResult>('tasks.undo', id, index),
      'tasks:delete': (id) => brain('tasks.delete', id),
      'tasks:clear': () => brain('tasks.clear'),
      'memory:list': (q) => brain<MemoryItem[]>('memory.list', q),
      'memory:add': (text, kind) => brain<MemoryItem>('memory.add', text, kind),
      'memory:update': (id, patch) => brain<MemoryItem>('memory.update', id, patch),
      'memory:remove': (id) => brain('memory.remove', id),
      'memory:clear': () => brain('memory.clear'),
      'skills:list': () => brain<SkillInfo[]>('skills.list'),
      'skills:install': async (dir) => {
        let target = dir
        if (!target) {
          const r = await dialog.showOpenDialog({ title: 'Choose a skill folder (it contains SKILL.md)', properties: ['openDirectory'] })
          if (r.canceled || !r.filePaths[0]) return null
          target = r.filePaths[0]
        }
        return brain<SkillInfo>('skills.install', target)
      },
      'skills:remove': (id) => brain('skills.remove', id),
      'skills:enable': (id, on) => brain<SkillInfo>('skills.enable', id, on),
      'skills:openFolder': async () => {
        const dir = await brain<string>('skills.folder')
        void shell.openPath(dir)
      },
      'models:list': (provider: ProviderId) => brain('models.list', provider),
      'models:test': async (provider) => {
        const st = await brain<ProviderStatus>('models.test', provider)
        this.provider = st
        this.broadcast('integrations:changed', this.integrations())
        return st
      },
      'voice:status': () => this.voice.status(),
      'voice:toggle': () => this.toggleVoice(),
      'voice:cancel': () => this.voice.cancelCapture(),
      'voice:test': (text) => this.voice.speak(text ?? "Hi! I'm Clawd. This is how I sound."),
      'voice:stopSpeaking': () => this.voice.stopSpeaking(),
      'voice:voices': () => this.voice.voices(),
      'voice:download': () => void this.models.download(),
      'cc:sessions': () => this.cc.list(),
      'cc:select': (id) => {
        this.cc.select(id)
        const f = this.cc.focus()
        this.companion.setCC(f ? f.state : null)
      },
      'cc:status': () => this.hooks.status(true, this.cc.lastEventAt),
      'cc:install': () => {
        this.hooks.install()
        return this.hooks.status(true, this.cc.lastEventAt)
      },
      'cc:uninstall': () => {
        this.hooks.uninstall()
        return this.hooks.status(true, this.cc.lastEventAt)
      },
      'browser:status': () => this.browserStatus(),
      'browser:openExtensionFolder': () => void shell.openPath(resourcePath('extension')),
      'permissions:history': () => brain('permissions.history'),
      'permissions:clearAlways': () => brain('permissions.clearAlways'),
      'integrations:status': () => this.integrations(),
      'result:apply': (text, mode) => this.applyResult(text, mode),
      'app:info': (): AppInfo => ({ version: app.getVersion(), electron: process.versions.electron, dataDir: dataDir(), logsDir: subdir('logs'), packaged: app.isPackaged, platform: `${process.platform} ${process.getSystemVersion()}` }),
      'app:open': (target, section) => {
        if (target === 'settings') this.settingsWin.open(section)
        else this.panel.show(true)
      },
      'app:openPath': async (p) => {
        if (!fs.existsSync(p)) throw new Error('That file no longer exists.')
        await shell.openPath(p)
      },
      'app:reveal': (p) => shell.showItemInFolder(p),
      'app:openExternal': async (url) => {
        if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened.')
        await shell.openExternal(url)
      },
      'app:copy': async (text) => {
        await clipboard.writeText(text)
      },
      'app:diagnostics': () => ({
        info: { version: app.getVersion(), electron: process.versions.electron, dataDir: dataDir(), logsDir: subdir('logs'), packaged: app.isPackaged, platform: `${process.platform} ${process.getSystemVersion()}` },
        integrations: this.integrations(),
        logTail: logTail(150),
        perf: this.overlays.perf ? { ...this.overlays.perf, cpu: process.getCPUUsage().percentCPUUsage, memoryMB: Math.round(process.memoryUsage().rss / 1048576) } : null,
      }),
      'app:quit': () => app.quit(),
      'app:pickFolder': async () => {
        const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
        return r.canceled ? null : (r.filePaths[0] ?? null)
      },
      'panel:hide': () => this.panel.hide(),
      'panel:pin': (on) => this.panel.setPinned(on),
      'panel:size': (h) => this.panel.setHeight(h),
      'companion:summon': () => void this.summon(),
      'companion:hide': () => this.toggleVisible(),
    }
  }

  dispose(): void {
    this.shortcuts?.dispose()
    this.voice.dispose()
    this.brain.stop()
    this.native.stop()
    this.bridge.stop()
    this.overlays.stop()
    this.cc.dispose()
    this.focus.dispose()
    this.companion.dispose()
    this.tray?.destroy()
  }
}

export type { Settings }
