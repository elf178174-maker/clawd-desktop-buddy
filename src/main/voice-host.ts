// Voice host: runs the voice service (utility process) and the hidden audio window, connects them
// with a MessagePort, and exposes wake/capture/speak to the rest of the app. The microphone is
// only opened when voice is enabled and microphone access is allowed in Settings.

import { BrowserWindow, ipcMain, MessageChannelMain, session, utilityProcess, type UtilityProcess } from 'electron'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { AudioSends, VoiceStatus } from '../shared/api'
import { RpcPeer, type RpcMessage } from '../shared/rpc'
import type { Settings } from '../shared/settings'
import { logger } from './log'
import type { ModelManager } from './models'
import { modelsDir } from './paths'
import type { SettingsStore } from './settings-store'
import { loadPage, secureWindow } from './windows/common'

const log = logger('voice')

export class VoiceHost extends EventEmitter {
  private child: UtilityProcess | null = null
  private rpc: RpcPeer
  private audioWin: BrowserWindow | null = null
  private ready = false
  private audioReady = false
  private capturing = false
  private recognizing = false
  /** Cancelled while recognising: the transcript that is on its way is dropped. */
  private dropTranscript = false
  private speakingId: string | null = null
  private nativeSpeaking = false
  private devices: { deviceId: string; label: string }[] = []
  private micOn = false
  private micPermission: VoiceStatus['micPermission'] = 'unknown'
  private lastError: string | undefined
  private kwsError: string | null = null
  private restarts = 0

  constructor(
    private settings: SettingsStore,
    private models: ModelManager,
  ) {
    super()
    this.rpc = new RpcPeer((m) => this.child?.postMessage(m))
    this.rpc.onEvent((event, data) => this.onEvent(event, data))
    ipcMain.on('audio:ready', () => {
      this.audioReady = true
      this.connectPorts()
      this.applyMic()
    })
    ipcMain.on('audio:level', (_e, v: AudioSends['audio:level']) => this.emit('speakLevel', v))
    ipcMain.on('audio:devices', (_e, d: AudioSends['audio:devices']) => {
      this.devices = d
      this.emitStatus()
    })
    ipcMain.on('audio:micState', (_e, s: AudioSends['audio:micState']) => {
      this.micOn = s.on
      this.micPermission = s.permission === 'unknown' ? this.micPermission : s.permission
      this.lastError = s.error
      this.emitStatus()
    })
    ipcMain.on('audio:nativeSpeech', (_e, s: AudioSends['audio:nativeSpeech']) => {
      this.nativeSpeaking = s.state === 'start'
      this.emit('speaking', this.nativeSpeaking)
      this.emitStatus()
    })
    models.on('progress', () => this.emitStatus())
    models.on('done', () => this.apply())
  }

  private get wanted(): boolean {
    const s = this.settings.get()
    return s.voice.enabled && s.privacy.microphone
  }

  /** Starts, stops or reconfigures everything to match the settings. */
  apply(): void {
    const s = this.settings.get()
    const needsProcess = this.models.present && (this.wanted || (s.voice.speak && s.voice.ttsEngine === 'kokoro'))
    if (needsProcess && !this.child) this.startProcess()
    if (!needsProcess && this.child) this.stopProcess()
    if ((this.wanted || s.voice.speak) && !this.audioWin) this.createAudioWindow()
    if (this.ready) void this.configure(s)
    this.applyMic()
    this.audioWin?.webContents.send('audio:volume', s.voice.volume)
    this.emitStatus()
  }

  private startProcess(): void {
    const entry = path.join(__dirname, 'voice.js')
    const child = utilityProcess.fork(entry, [], { serviceName: 'Clawd Voice', stdio: 'pipe' })
    this.child = child
    child.stderr?.on('data', (b: Buffer) => log.warn(b.toString().trim()))
    child.on('message', (m: RpcMessage) => {
      if ((m as { t?: string; e?: string }).t === 'evt' && (m as { e?: string }).e === 'ready') {
        this.ready = true
        this.restarts = 0
        void this.configure(this.settings.get())
        this.connectPorts()
        return
      }
      void this.rpc.receive(m)
    })
    child.on('exit', (code) => {
      this.ready = false
      this.child = null
      this.rpc.failAll('Voice service stopped.')
      this.capturing = false
      if (code !== 0 && this.wanted && this.restarts++ < 5) {
        log.error('voice service exited; restarting', { code })
        setTimeout(() => this.apply(), 2000 * this.restarts)
      }
      this.emitStatus()
    })
  }

  private stopProcess(): void {
    this.child?.kill()
    this.child = null
    this.ready = false
  }

  private createAudioWindow(): void {
    // Microphone access is granted to the audio window only, and only while allowed in Settings.
    const ses = session.defaultSession
    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
      const isAudio = !!this.audioWin && wc.id === this.audioWin.webContents.id
      const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      const audioOnly = mediaTypes.every((t) => t === 'audio')
      cb(permission === 'media' && isAudio && audioOnly && this.settings.get().privacy.microphone)
    })
    ses.setPermissionCheckHandler((wc, permission) => permission === 'media' && !!wc && !!this.audioWin && wc.id === this.audioWin.webContents.id && this.settings.get().privacy.microphone)
    const win = secureWindow({ show: false, width: 200, height: 100, skipTaskbar: true, webPreferences: { backgroundThrottling: false, spellcheck: false } })
    win.on('closed', () => {
      this.audioWin = null
      this.audioReady = false
    })
    void loadPage(win, 'audio')
    this.audioWin = win
  }

  private connectPorts(): void {
    if (!this.ready || !this.audioReady || !this.child || !this.audioWin) return
    const { port1, port2 } = new MessageChannelMain()
    this.audioWin.webContents.postMessage('voice-port', null, [port1])
    this.child.postMessage({ type: 'audio-port' }, [port2])
  }

  private async configure(s: Settings): Promise<void> {
    try {
      const r = (await this.rpc.call('configure', [
        { modelsDir: modelsDir(), wakeWord: s.voice.wakeWord && s.voice.wakeConsent && this.wanted, wakePhrase: s.voice.wakePhrase, sensitivity: s.voice.sensitivity, endSilenceMs: s.voice.endSilenceMs, maxUtteranceSec: s.voice.maxUtteranceSec },
      ])) as { kwsError: string | null }
      if (r.kwsError !== undefined) this.kwsError = r.kwsError
      this.emitStatus()
    } catch (err) {
      this.lastError = (err as Error).message
    }
  }

  private applyMic(): void {
    if (!this.audioWin || !this.audioReady) return
    const v = this.settings.get().voice
    const want = this.wanted && this.models.present && ((v.wakeWord && v.wakeConsent) || this.capturing)
    this.audioWin.webContents.send('audio:mic', { on: want, deviceId: this.settings.get().voice.micDevice })
  }

  private onEvent(event: string, data: unknown): void {
    switch (event) {
      case 'wake':
        log.info('wake word detected')
        this.emit('wake')
        break
      case 'capture': {
        const st = (data as { state: string }).state
        this.capturing = st === 'listening'
        this.recognizing = st === 'recognizing'
        if (st === 'timeout' || st === 'cancel') {
          this.emit('captureEnd', st)
          this.applyMic()
        }
        this.emit('capture', st)
        this.emitStatus()
        break
      }
      case 'level':
        this.emit('level', data as number)
        break
      case 'transcript':
        this.capturing = false
        this.recognizing = false
        this.applyMic()
        if (this.dropTranscript) {
          this.dropTranscript = false
          this.emit('captureEnd', 'cancel')
        } else this.emit('transcript', (data as { text: string }).text)
        this.emitStatus()
        break
      case 'speakStart':
        this.speakingId = (data as { id: string }).id
        this.emit('speaking', true)
        this.emitStatus()
        break
      case 'speakEnd':
        if (this.speakingId === (data as { id: string }).id) {
          this.speakingId = null
          this.emit('speaking', false)
          this.emitStatus()
        }
        break
      case 'error':
        this.lastError = (data as { message: string }).message
        this.recognizing = false
        this.emit('captureEnd', 'error')
        this.emitStatus()
        break
    }
  }

  /** Start listening for a request now (after the wake word, or from the shortcut). */
  async startCapture(timeoutSec = 6): Promise<boolean> {
    if (!this.wanted) return false
    if (!this.models.present) return false
    if (!this.child) this.apply()
    this.stopSpeaking()
    this.capturing = true
    this.dropTranscript = false
    this.applyMic()
    try {
      await this.rpc.call('startCapture', [timeoutSec], 5000)
      return true
    } catch (err) {
      this.capturing = false
      this.lastError = (err as Error).message
      this.emitStatus()
      return false
    }
  }

  cancelCapture(): void {
    if (this.capturing) void this.rpc.call('cancelCapture').catch(() => {})
    else if (this.recognizing) this.dropTranscript = true
  }

  get isCapturing(): boolean {
    return this.capturing
  }

  get isSpeaking(): boolean {
    return !!this.speakingId || this.nativeSpeaking
  }

  async speak(text: string): Promise<void> {
    const s = this.settings.get().voice
    if (!s.speak || !text.trim()) return
    if (s.ttsEngine === 'system' || !this.models.present) {
      if (!this.audioWin) this.createAudioWindow()
      this.audioWin?.webContents.send('audio:say', { text: text.replace(/```[\s\S]*?```/g, ' ').slice(0, 3000), voice: s.systemVoice, rate: s.speed, volume: s.volume })
      return
    }
    if (!this.child) this.apply()
    try {
      await this.rpc.call('speak', [text, s.ttsVoice, s.speed])
    } catch (err) {
      this.lastError = (err as Error).message
      this.emitStatus()
    }
  }

  stopSpeaking(): void {
    if (this.speakingId) void this.rpc.call('stopSpeaking').catch(() => {})
    this.audioWin?.webContents.send('audio:stop', null)
  }

  async voices(): Promise<string[]> {
    if (!this.child) return []
    return this.rpc.call<string[]>('voices').catch(() => [])
  }

  status(): VoiceStatus {
    const missing = this.models.missing()
    const s = this.settings.get()
    let wake: VoiceStatus['wakeWord'] = 'off'
    if (this.wanted && s.voice.wakeWord && !s.voice.wakeConsent) wake = 'paused'
    else if (this.wanted && s.voice.wakeWord) wake = this.kwsError || !this.micOn ? 'error' : this.capturing ? 'paused' : 'listening'
    return {
      devices: this.devices,
      available: this.ready || this.models.present,
      modelsPresent: missing.length === 0,
      missing,
      downloading: this.models.downloading,
      wakeWord: wake,
      micPermission: this.micPermission,
      listening: this.capturing,
      recognizing: this.recognizing,
      speaking: this.isSpeaking,
      error: this.kwsError ?? this.lastError ?? this.models.error ?? undefined,
      engine: s.voice.ttsEngine === 'kokoro' && this.models.present ? `Kokoro (${s.voice.ttsVoice})` : 'Windows voices',
    }
  }

  private emitStatus(): void {
    this.emit('status', this.status())
  }

  listDevices(): void {
    this.audioWin?.webContents.send('audio:listDevices', null)
  }

  dispose(): void {
    this.stopProcess()
    this.audioWin?.destroy()
  }
}
