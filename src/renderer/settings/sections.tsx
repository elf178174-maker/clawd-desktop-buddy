// Settings sections: General, Appearance & motion, Voice, Shortcuts, AI model.

import { useEffect, useRef, useState } from 'react'
import { Check, Download, KeyRound, Loader, Mic, Play, RefreshCw, RotateCcw, Square, Volume2 } from 'lucide-react'
import type { ShortcutStatus, StartupStatus, VoiceStatus } from '../../shared/api'
import { acceleratorFromEvent } from '../../shared/keybinds'
import { DEFAULT_SHORTCUTS, PROVIDERS, SHORTCUT_LABELS, type ProviderId, type ShortcutAction } from '../../shared/settings'
import type { ProviderStatus } from '../../shared/types'
import { CURSOR_SPRITE_FINE, CURSOR_THEMES, cursorRects, drawSmoothCursor } from '../../character/cursor'
import { drawRects } from '../../character/render'
import type { StateName } from '../../character/states'
import { invoke, on } from '../shared/bridge'
import { ClawdMini } from '../shared/ClawdMini'
import { Badge, Segmented, Select, Slider, Spinner, Toggle } from '../shared/ui'
import type { SectionProps } from './App'
import { Callout, Row, Section } from './kit'

export function GeneralSection({ s, set }: SectionProps) {
  const [startup, setStartup] = useState<StartupStatus | null>(null)
  useEffect(() => void invoke('startup:status').then(setStartup), [s.general.startWithWindows])
  return (
    <>
      <Section title="Startup">
        <Row
          label="Start with Windows"
          desc="Clawd opens when you sign in. Uses a per-user startup entry; no administrator rights."
          keywords="login boot autostart"
          warn={startup?.note}
        >
          <div className="inline">
            {startup && <Badge tone={startup.registered === s.general.startWithWindows ? 'ok' : 'warn'} dot>{startup.registered ? 'Registered' : 'Not registered'}</Badge>}
            <Toggle checked={s.general.startWithWindows} onChange={(v) => set({ general: { startWithWindows: v } })} label="Start with Windows" />
          </div>
        </Row>
        <Row label="Start tucked away" desc="When starting with Windows, keep Clawd hidden until you summon him." keywords="tray minimized">
          <Toggle checked={s.general.startInTray} onChange={(v) => set({ general: { startInTray: v } })} />
        </Row>
        <Row label="Show Clawd when the app starts" desc="Otherwise he waits in the tray.">
          <Toggle checked={s.general.showOnStartup} onChange={(v) => set({ general: { showOnStartup: v } })} />
        </Row>
      </Section>
      <Section title="Look">
        <Row label="Theme" desc="Applies to the panel, settings and speech bubbles." keywords="dark light mode">
          <Segmented value={s.general.theme} onChange={(v) => set({ general: { theme: v } })} options={[{ value: 'system', label: 'System' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
        </Row>
        <Row label="Language" desc="More languages are planned; speech recognition is English-only today.">
          <Select value={s.general.language} onChange={() => {}} options={[{ value: 'en', label: 'English' }]} />
        </Row>
      </Section>
      <Section title="Companion">
        <Row label="Size" desc="Pixels per Clawd pixel (he is 12 × 8 of them)." keywords="scale big small">
          <Slider value={s.companion.size} min={4} max={16} step={1} onChange={(v) => set({ companion: { size: v } })} format={(v) => `${v * 12}×${v * 8}`} />
        </Row>
        <Row label="Position" desc="Where Clawd lives. Drag him anywhere to place him freely." keywords="corner location place">
          <Select
            value={s.companion.corner}
            onChange={(v) => set({ companion: { corner: v } })}
            options={[
              { value: 'bottom-right', label: 'Bottom right (on the taskbar)' },
              { value: 'bottom-left', label: 'Bottom left (on the taskbar)' },
              { value: 'top-right', label: 'Top right' },
              { value: 'top-left', label: 'Top left' },
              { value: 'custom', label: 'Where I dropped him' },
            ]}
          />
        </Row>
        <Row label="Distance from the screen edge">
          <Slider value={s.companion.edgeOffset} min={0} max={800} step={10} onChange={(v) => set({ companion: { edgeOffset: v } })} format={(v) => `${v}px`} />
        </Row>
        <Row label="Clicks" desc="Smart: only Clawd's own pixels catch the mouse; everything around him stays clickable." keywords="click-through mouse">
          <Select
            value={s.companion.clickThrough}
            onChange={(v) => set({ companion: { clickThrough: v } })}
            options={[
              { value: 'smart', label: 'Smart (recommended)' },
              { value: 'always', label: 'Always click-through' },
              { value: 'never', label: 'Never click-through' },
            ]}
          />
        </Row>
        <Row label="Don't cover my work" desc="When your pointer sweeps across him, Clawd fades out or hops aside so he never blocks a button." keywords="avoid overlap obstruct">
          <Select
            value={s.companion.avoidCovering}
            onChange={(v) => set({ companion: { avoidCovering: v } })}
            options={[
              { value: 'fade', label: 'Fade out' },
              { value: 'move', label: 'Hop aside' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </Row>
        <Row label="Gravity" desc="When you drop him, he falls to the bottom of the screen.">
          <Toggle checked={s.companion.gravity} onChange={(v) => set({ companion: { gravity: v } })} />
        </Row>
        <Row label="Hide after inactivity" desc="Clawd slips away when you haven't interacted with him for a while. His work and conversation keep going." keywords="idle timeout auto hide">
          <Slider value={s.general.hideAfterIdleMinutes} min={0} max={120} step={5} onChange={(v) => set({ general: { hideAfterIdleMinutes: v } })} format={(v) => (v ? `${v} min` : 'Never')} />
        </Row>
      </Section>
    </>
  )
}

function CursorPreview({ style, theme }: { style: 'smooth' | 'pixel'; theme: keyof typeof CURSOR_THEMES }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current!
    const dpr = window.devicePixelRatio || 1
    c.width = 120 * dpr
    c.height = 44 * dpr
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.fillStyle = '#f3f1ec'
    ctx.fillRect(0, 0, 60 * dpr, c.height)
    ctx.fillStyle = '#0e0e10'
    ctx.fillRect(60 * dpr, 0, 60 * dpr, c.height)
    for (const x of [20, 80]) {
      if (style === 'smooth') {
        ctx.save()
        ctx.scale(dpr, dpr)
        drawSmoothCursor(ctx, x, 8, 2.15, CURSOR_THEMES[theme])
        ctx.restore()
      } else drawRects(ctx, cursorRects(CURSOR_SPRITE_FINE, CURSOR_THEMES[theme]), { scale: 1.6, dpr, originX: x, originY: 8, snap: 'device' })
    }
  }, [style, theme])
  return <canvas ref={ref} style={{ width: 120, height: 44, borderRadius: 6, border: '1px solid var(--border)' }} />
}

export function AppearanceSection({ s, set }: SectionProps) {
  const a = s.appearance
  const [play, setPlay] = useState<{ name: StateName; key: number } | undefined>()
  return (
    <>
      <Section title="Preview">
        <div className="preview">
          <ClawdMini scale={7} width={150} height={92} intensity={a.animationIntensity} snap={a.pixelSnap} play={play} />
          <div className="preview-actions">
            {(['wave', 'celebrate', 'highFive', 'poke', 'confused', 'hop'] as StateName[]).map((n) => (
              <button key={n} className="btn sm" onClick={() => setPlay({ name: n === 'highFive' ? 'highFive' : n, key: Date.now() })}>
                <Play size={12} /> {n === 'highFive' ? 'high five' : n}
              </button>
            ))}
          </div>
        </div>
      </Section>
      <Section title="Motion">
        <Row label="Animation intensity" desc="How big his movements are. Focus mode lowers it further." keywords="motion amount">
          <Slider value={a.animationIntensity} min={0} max={1} step={0.05} onChange={(v) => set({ appearance: { animationIntensity: v } })} format={(v) => `${Math.round(v * 100)}%`} />
        </Row>
        <Row label="Idle activity" desc="How often he looks around, stretches or taps his foot when nothing is happening." keywords="idle frequency fidget">
          <Slider value={a.idleFrequency} min={0} max={2} step={0.1} onChange={(v) => set({ appearance: { idleFrequency: v } })} format={(v) => (v === 0 ? 'Still' : `${v.toFixed(1)}×`)} />
        </Row>
        <Row label="Reduced motion" desc="No jumps or squash; gentle fades instead. Follows Windows' animation setting by default." keywords="accessibility">
          <Segmented value={a.reducedMotion} onChange={(v) => set({ appearance: { reducedMotion: v } })} options={[{ value: 'system', label: 'System' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
        </Row>
        <Row label="Follow the pointer with his eyes" keywords="gaze cursor look">
          <Toggle checked={a.cursorFollow} onChange={(v) => set({ appearance: { cursorFollow: v } })} />
        </Row>
        <Row label="Pixel grid" desc="Smooth moves one screen pixel at a time; Retro snaps every part to his pixel grid." keywords="snap retro">
          <Segmented value={a.pixelSnap} onChange={(v) => set({ appearance: { pixelSnap: v } })} options={[{ value: 'device', label: 'Smooth' }, { value: 'art', label: 'Retro' }]} />
        </Row>
        <Row label="Sit down after" desc="Seconds of quiet before he sits.">
          <Slider value={a.sitAfterSeconds} min={0} max={600} step={15} onChange={(v) => set({ appearance: { sitAfterSeconds: v } })} format={(v) => (v ? `${v}s` : 'Never')} />
        </Row>
        <Row label="Nap after" desc="Minutes of quiet before he takes a nap." keywords="sleep">
          <Slider value={a.napAfterMinutes} min={0} max={120} step={1} onChange={(v) => set({ appearance: { napAfterMinutes: v } })} format={(v) => (v ? `${v} min` : 'Never')} />
        </Row>
      </Section>
      <Section title="Details">
        <Row label="Ground shadow">
          <Toggle checked={a.shadow} onChange={(v) => set({ appearance: { shadow: v } })} />
        </Row>
        <Row label="Laptop while Claude Code works" desc="A tiny laptop slides in while a Claude Code session is busy." keywords="coding prop">
          <Toggle checked={a.laptopProp} onChange={(v) => set({ appearance: { laptopProp: v } })} />
        </Row>
        <Row label="Clawd's cursor" desc="The pointer he uses to show you things. Your own mouse is never replaced." keywords="pointer teardrop">
          <div className="inline">
            <CursorPreview style={a.cursorStyle} theme={a.cursorTheme} />
            <Segmented value={a.cursorStyle} onChange={(v) => set({ appearance: { cursorStyle: v } })} options={[{ value: 'smooth', label: 'Smooth' }, { value: 'pixel', label: 'Pixel' }]} />
            <Select width={120} value={a.cursorTheme} onChange={(v) => set({ appearance: { cursorTheme: v } })} options={[{ value: 'ember', label: 'Ember' }, { value: 'clawd', label: 'Clawd' }, { value: 'paper', label: 'Paper' }]} />
          </div>
        </Row>
      </Section>
      <Section title="Screen glow">
        <Row label="Edge glow" desc="A soft glow around the screen edges while Clawd moves his cursor or controls your keyboard and mouse." keywords="apple intelligence siri border">
          <Segmented value={a.edgeGlow} onChange={(v) => set({ appearance: { edgeGlow: v } })} options={[{ value: 'aurora', label: 'Aurora' }, { value: 'clawd', label: 'Clawd' }, { value: 'off', label: 'Off' }]} />
        </Row>
        <Row label="Glow while listening" desc="The edges breathe with your voice while Clawd listens.">
          <Toggle checked={a.glowWhileListening} disabled={a.edgeGlow === 'off'} onChange={(v) => set({ appearance: { glowWhileListening: v } })} />
        </Row>
      </Section>
      <Section title="Sound">
        <Row label="Interaction sounds" desc="Soft blips when you poke, high-five or drop him. Muted in focus mode." keywords="audio sfx">
          <Toggle checked={s.sound.interactionSounds} onChange={(v) => set({ sound: { interactionSounds: v } })} />
        </Row>
        <Row label="Sound volume">
          <Slider value={s.sound.volume} min={0} max={1} step={0.05} onChange={(v) => set({ sound: { volume: v } })} format={(v) => `${Math.round(v * 100)}%`} />
        </Row>
      </Section>
    </>
  )
}

export function VoiceSection({ s, set }: SectionProps) {
  const [st, setSt] = useState<VoiceStatus | null>(null)
  const [voices, setVoices] = useState<string[]>([])
  const [phrase, setPhrase] = useState(s.voice.wakePhrase)
  useEffect(() => {
    void invoke('voice:status').then(setSt)
    void invoke('voice:voices').then(setVoices)
    return on('voice:status', setSt)
  }, [])
  useEffect(() => {
    if (st?.modelsPresent && !voices.length) void invoke('voice:voices').then(setVoices)
  }, [st?.modelsPresent])
  const v = s.voice
  const dl = st?.downloading
  return (
    <>
      {st && !st.modelsPresent && (
        <Callout tone="warn">
          <div style={{ flex: 1 }}>
            <strong>Voice models are not downloaded.</strong> Wake word, speech recognition and Clawd's voice run entirely on this PC and need about 620 MB of models: {st.missing.join(', ')}.
            {dl && (
              <div className="progress">
                <div style={{ width: `${Math.round((dl.received / dl.total) * 100)}%` }} />
                <span>
                  {dl.file}: {Math.round(dl.received / 1e6)} / {Math.round(dl.total / 1e6)} MB
                </span>
              </div>
            )}
          </div>
          <button className="btn primary" disabled={!!dl} onClick={() => void invoke('voice:download')}>
            {dl ? <Loader size={14} className="spin" /> : <Download size={14} />} Download
          </button>
        </Callout>
      )}
      <Section title="Listening">
        <Row label="Voice input" desc="Talk to Clawd with your voice. Audio never leaves your PC." keywords="speech microphone">
          <Toggle checked={v.enabled} onChange={(x) => set({ voice: { enabled: x } })} />
        </Row>
        <Row
          label="Microphone"
          desc={st?.micPermission === 'denied' ? 'Windows denied microphone access. Allow it in Windows Settings > Privacy > Microphone.' : 'The microphone Clawd listens with.'}
          warn={!s.privacy.microphone ? 'Microphone access is turned off in Permissions & privacy.' : undefined}
        >
          <div className="inline">
            {st && <Badge tone={st.micPermission === 'granted' ? 'ok' : st.micPermission === 'denied' ? 'danger' : undefined} dot>{st.micPermission === 'granted' ? 'Allowed' : st.micPermission === 'denied' ? 'Denied' : 'Not used yet'}</Badge>}
            <Select value={v.micDevice} onChange={(x) => set({ voice: { micDevice: x } })} options={[{ value: 'default', label: 'System default' }, ...(st?.devices ?? []).filter((d) => d.deviceId !== 'default').map((d) => ({ value: d.deviceId, label: d.label }))]} />
          </div>
        </Row>
        <Row label="Listen when I open Clawd" desc="The panel opens ready for your voice. Start typing and Clawd stops listening." keywords="voice first summon speak type">
          <Toggle checked={v.listenOnSummon} disabled={!v.enabled} onChange={(x) => set({ voice: { listenOnSummon: x } })} />
        </Row>
        <Row label="Wake word" desc={`Say "${v.wakePhrase}" and Clawd jumps in to listen. Detected locally by a small keyword model.`} keywords="hey clawd hotword" warn={st?.wakeWord === 'error' && v.enabled ? st.error ?? 'The wake word is not active.' : undefined}>
          <div className="inline">
            {v.enabled && v.wakeWord && st && <Badge tone={st.wakeWord === 'listening' ? 'ok' : st.wakeWord === 'error' ? 'danger' : undefined} dot>{st.wakeWord === 'listening' ? 'Listening for it' : st.wakeWord}</Badge>}
            <Toggle checked={v.wakeWord && v.wakeConsent} onChange={(x) => set({ voice: { wakeWord: x, wakeConsent: x ? true : v.wakeConsent } })} />
          </div>
        </Row>
        <Row label="Wake phrase" desc="Plain English words. Clawd also hears the same sound spelled “Claude”.">
          <div className="inline">
            <input className="input" style={{ width: 180 }} value={phrase} onChange={(e) => setPhrase(e.target.value)} onBlur={() => /^[a-zA-Z' ]{3,40}$/.test(phrase.trim()) ? set({ voice: { wakePhrase: phrase.trim() } }) : setPhrase(v.wakePhrase)} />
          </div>
        </Row>
        <Row label="Wake word sensitivity" desc="Higher reacts more easily but may trigger by mistake.">
          <Slider value={v.sensitivity} min={0} max={1} step={0.05} onChange={(x) => set({ voice: { sensitivity: x } })} format={(x) => `${Math.round(x * 100)}%`} />
        </Row>
        <Row label="End of request" desc="How long a pause ends what you're saying.">
          <Slider value={v.endSilenceMs} min={300} max={2500} step={50} onChange={(x) => set({ voice: { endSilenceMs: x } })} format={(x) => `${(x / 1000).toFixed(2)} s`} />
        </Row>
        <Row label="Try it" desc="Start listening now (same as the voice shortcut).">
          <button className="btn" disabled={!st?.modelsPresent || !v.enabled} onClick={() => void invoke('voice:toggle')}>
            {st?.listening ? <Square size={13} /> : <Mic size={13} />} {st?.listening ? 'Listening…' : 'Listen'}
          </button>
        </Row>
      </Section>
      <Section title="Speaking">
        <Row label="Speak answers" desc="Clawd reads his answers aloud.">
          <Toggle checked={v.speak} onChange={(x) => set({ voice: { speak: x } })} />
        </Row>
        <Row label="When">
          <Segmented value={v.speakWhen} onChange={(x) => set({ voice: { speakWhen: x } })} options={[{ value: 'voice', label: 'When I spoke to him' }, { value: 'always', label: 'Always' }]} />
        </Row>
        <Row label="Voice engine" desc="Kokoro is a natural local voice. Windows voices are the built-in fallback.">
          <Segmented value={v.ttsEngine} onChange={(x) => set({ voice: { ttsEngine: x } })} options={[{ value: 'kokoro', label: 'Kokoro (local)' }, { value: 'system', label: 'Windows' }]} />
        </Row>
        {v.ttsEngine === 'kokoro' && (
          <Row label="Voice">
            <Select value={v.ttsVoice} onChange={(x) => set({ voice: { ttsVoice: x } })} options={(voices.length ? voices : [v.ttsVoice]).map((x) => ({ value: x, label: voiceLabel(x) }))} />
          </Row>
        )}
        <Row label="Speed">
          <Slider value={v.speed} min={0.6} max={1.6} step={0.05} onChange={(x) => set({ voice: { speed: x } })} format={(x) => `${x.toFixed(2)}×`} />
        </Row>
        <Row label="Volume">
          <Slider value={v.volume} min={0} max={1} step={0.05} onChange={(x) => set({ voice: { volume: x } })} format={(x) => `${Math.round(x * 100)}%`} />
        </Row>
        <Row label="Test the voice">
          <div className="inline">
            <button className="btn" onClick={() => void invoke('voice:test')}>
              <Volume2 size={14} /> Play sample
            </button>
            {st?.speaking && (
              <button className="btn ghost" onClick={() => void invoke('voice:stopSpeaking')}>
                <Square size={13} /> Stop
              </button>
            )}
          </div>
        </Row>
      </Section>
    </>
  )
}

function voiceLabel(id: string): string {
  const [code, name] = id.split('_')
  const region = code[0] === 'a' ? 'American' : code[0] === 'b' ? 'British' : ''
  const gender = code[1] === 'm' ? 'male' : 'female'
  return `${name ? name[0].toUpperCase() + name.slice(1) : id} (${region} ${gender})`
}

export function ShortcutsSection({ s, set }: SectionProps) {
  const [status, setStatus] = useState<ShortcutStatus[]>([])
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [candidate, setCandidate] = useState<string | null>(null)
  const [check, setCheck] = useState<{ ok: boolean; error?: string; warnings: string[] } | null>(null)
  useEffect(() => {
    void invoke('shortcuts:status').then(setStatus)
    return on('shortcuts:changed', setStatus)
  }, [])
  useEffect(() => {
    if (!recording) return
    void invoke('shortcuts:recording', true)
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey) {
        stop()
        return
      }
      const accel = acceleratorFromEvent(e)
      if (!accel) return
      setCandidate(accel)
      void invoke('shortcuts:check', recording, accel).then(setCheck)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      void invoke('shortcuts:recording', false)
    }
  }, [recording])
  const stop = () => {
    setRecording(null)
    setCandidate(null)
    setCheck(null)
  }
  const save = (action: ShortcutAction, accel: string) => {
    set({ shortcuts: { [action]: accel } })
    stop()
  }
  return (
    <>
      <Section title="Global shortcuts" desc="They work from any application. Each is checked against Windows, other apps that already own it, and your keyboard layout (AltGr).">
        {(Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]).map((action) => {
          const st = status.find((x) => x.action === action)
          const current = s.shortcuts[action]
          const isRec = recording === action
          return (
            <Row key={action} label={SHORTCUT_LABELS[action]} keywords="keybinding hotkey" warn={!isRec && st?.error && current ? st.error : undefined}>
              <div className="inline">
                {isRec ? (
                  <>
                    <span className={`kbd recording ${check && !check.ok ? 'bad' : ''}`}>{candidate ?? 'Press keys…'}</span>
                    <button className="btn sm primary" disabled={!candidate || !check?.ok} onClick={() => candidate && save(action, candidate)}>
                      <Check size={13} /> Save
                    </button>
                    <button className="btn sm ghost" onClick={stop}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    {current ? current.split('+').map((k, i) => <span key={i} className="kbd">{k}</span>) : <span className="faint">Off</span>}
                    {st?.registered && <Badge tone="ok" dot>Active</Badge>}
                    <button className="btn sm" onClick={() => setRecording(action)}>
                      Change
                    </button>
                    {current !== DEFAULT_SHORTCUTS[action] && (
                      <button className="btn sm ghost icon" title={`Reset to ${DEFAULT_SHORTCUTS[action]}`} onClick={() => set({ shortcuts: { [action]: DEFAULT_SHORTCUTS[action] } })}>
                        <RotateCcw size={13} />
                      </button>
                    )}
                    {current && (
                      <button className="btn sm ghost" onClick={() => set({ shortcuts: { [action]: '' } })}>
                        Disable
                      </button>
                    )}
                  </>
                )}
              </div>
            </Row>
          )
        })}
        {recording && check && (check.error || check.warnings.length > 0) && (
          <div className={`check-msg ${check.ok ? 'warn' : 'bad'}`}>
            {check.error}
            {check.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        )}
      </Section>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => set({ shortcuts: { ...DEFAULT_SHORTCUTS } })}>
          <RotateCcw size={13} /> Reset all to defaults
        </button>
      </div>
    </>
  )
}

const PROVIDER_INFO: Record<ProviderId, { label: string; desc: string; key: boolean; local?: boolean }> = {
  ollama: { label: 'Ollama', desc: 'Runs models locally on this PC. Free and private.', key: false, local: true },
  openai: { label: 'OpenAI', desc: 'GPT models through the OpenAI API.', key: true },
  anthropic: { label: 'Anthropic', desc: 'Claude models through the Anthropic API.', key: true },
  gemini: { label: 'Google Gemini', desc: 'Gemini models through the Gemini API.', key: true },
  compatible: { label: 'OpenAI-compatible', desc: 'Any server with an OpenAI-style API: LM Studio, OpenRouter, Groq, vLLM…', key: true },
}

export function AISection({ s, set }: SectionProps) {
  const ai = s.ai
  const pid = ai.provider
  const [models, setModels] = useState<{ models: string[]; error?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [test, setTest] = useState<ProviderStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const refreshModels = async () => {
    setLoading(true)
    setModels(await invoke('models:list', pid))
    setLoading(false)
  }
  useEffect(() => {
    setModels(null)
    setTest(null)
    void invoke('secrets:has', pid).then(setHasKey)
    void refreshModels()
  }, [pid, hasKey])
  const cfg = pid === 'compatible' ? ai.compatible : ai[pid]
  const model = cfg.model
  const setModel = (m: string) => set({ ai: { [pid]: { model: m } } })
  return (
    <>
      <Section title="Provider" desc="Clawd's personality, memory, tools and skills stay the same whichever model powers him.">
        <div className="providers">
          {PROVIDERS.map((p) => (
            <button key={p} className={`provider ${pid === p ? 'active' : ''}`} onClick={() => set({ ai: { provider: p } })}>
              <div className="provider-name">
                {PROVIDER_INFO[p].label} {PROVIDER_INFO[p].local && <Badge tone="ok">local</Badge>}
              </div>
              <div className="faint" style={{ fontSize: 12 }}>
                {PROVIDER_INFO[p].desc}
              </div>
            </button>
          ))}
        </div>
      </Section>
      <Section title={`${PROVIDER_INFO[pid].label} connection`}>
        <Row label="Server address" desc={pid === 'ollama' ? 'Where Ollama listens (default http://127.0.0.1:11434).' : 'API base URL.'} keywords="url endpoint base">
          <input className="input" style={{ width: 300 }} defaultValue={cfg.baseUrl} key={pid} onBlur={(e) => set({ ai: { [pid]: { baseUrl: e.target.value.trim() } } })} />
        </Row>
        {pid === 'compatible' && (
          <Row label="Display name">
            <input className="input" style={{ width: 200 }} defaultValue={ai.compatible.name} onBlur={(e) => set({ ai: { compatible: { name: e.target.value } } })} />
          </Row>
        )}
        {PROVIDER_INFO[pid].key && (
          <Row label="API key" desc="Stored encrypted with Windows (DPAPI). Never shown again or sent anywhere except this provider." keywords="secret credential token">
            <div className="inline">
              {hasKey ? <Badge tone="ok" dot>Saved</Badge> : <Badge tone="warn" dot>Not set</Badge>}
              <input className="input" type="password" autoComplete="off" spellCheck={false} placeholder={hasKey ? 'Replace key…' : 'Paste key'} value={key} onChange={(e) => setKey(e.target.value)} style={{ width: 200 }} />
              <button
                className="btn"
                disabled={!key.trim()}
                onClick={async () => {
                  await invoke('secrets:set', pid, key.trim())
                  setKey('')
                  setHasKey(true)
                }}
              >
                <KeyRound size={13} /> Save
              </button>
              {hasKey && (
                <button
                  className="btn ghost"
                  onClick={async () => {
                    await invoke('secrets:clear', pid)
                    setHasKey(false)
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          </Row>
        )}
        <Row label="Model" desc={models?.error ? `Could not list models: ${models.error}` : 'Models available from this provider.'} keywords="llm">
          <div className="inline">
            {models?.models.length ? (
              <Select width={260} value={model} onChange={setModel} options={[...(model && !models.models.includes(model) ? [model] : []), ...models.models].map((m) => ({ value: m, label: m }))} />
            ) : (
              <input className="input" style={{ width: 260 }} placeholder={pid === 'anthropic' ? 'claude-opus-5-5' : 'model name'} defaultValue={model} key={pid + model} onBlur={(e) => setModel(e.target.value.trim())} />
            )}
            <button className="btn icon" title="Refresh the list" onClick={() => void refreshModels()}>
              {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
            </button>
          </div>
        </Row>
        {pid === 'ollama' && (
          <Row label="Context window" desc="Tokens the local model keeps in mind. Larger uses more GPU memory.">
            <Select value={String(ai.ollama.numCtx)} onChange={(v) => set({ ai: { ollama: { numCtx: Number(v) } } })} options={[8192, 16384, 32768, 65536].map((n) => ({ value: String(n), label: `${n / 1024}K tokens` }))} />
          </Row>
        )}
        <Row label="Connection test" desc="Sends a tiny request and checks the reply.">
          <div className="inline">
            {test && (
              <Badge tone={test.ok ? 'ok' : 'danger'} dot>
                {test.ok ? `${test.message}${test.tools ? ' · tools' : ''}${test.vision ? ' · vision' : ''}` : 'Failed'}
              </Badge>
            )}
            <button
              className="btn primary"
              onClick={async () => {
                setTesting(true)
                setTest(await invoke('models:test', pid))
                setTesting(false)
              }}
            >
              {testing ? <Spinner size={13} /> : null} Test
            </button>
          </div>
        </Row>
        {test && !test.ok && <Callout tone="danger">{test.message}</Callout>}
        {pid === 'ollama' && (
          <Callout>
            To add a model, run <code>ollama pull qwen3.5:4b</code> in a terminal. Models with tool support work best; Clawd falls back to a text protocol for others.
          </Callout>
        )}
      </Section>
      <Section title="Behaviour">
        <Row label="Thinking effort" desc="Deeper reasoning is slower. Used by models that support it." keywords="reasoning">
          <Segmented value={ai.reasoning} onChange={(v) => set({ ai: { reasoning: v } })} options={[{ value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
        </Row>
        <Row label="Creativity" desc="Sampling temperature (ignored by models that fix it).">
          <Slider value={ai.temperature} min={0} max={1.5} step={0.05} onChange={(v) => set({ ai: { temperature: v } })} format={(v) => v.toFixed(2)} />
        </Row>
        <Row label="Maximum steps per task" desc="Stops runaway tasks. Clawd summarises his progress when he reaches it.">
          <Slider value={ai.maxSteps} min={4} max={80} step={1} onChange={(v) => set({ ai: { maxSteps: v } })} />
        </Row>
        <Row label="Tool timeout" desc="Default limit for one action.">
          <Slider value={ai.toolTimeoutSec} min={10} max={600} step={10} onChange={(v) => set({ ai: { toolTimeoutSec: v } })} format={(v) => `${v}s`} />
        </Row>
        <Row label="Let the model see screenshots" desc="Only for models that accept images, and only after you allow each screenshot." keywords="vision image">
          <Segmented value={ai.vision} onChange={(v) => set({ ai: { vision: v } })} options={[{ value: 'auto', label: 'When supported' }, { value: 'off', label: 'Never' }]} />
        </Row>
        <Row label="If the provider is unreachable" desc="Fall back to the local Ollama model, or report the problem.">
          <Segmented value={ai.fallback} onChange={(v) => set({ ai: { fallback: v } })} options={[{ value: 'none', label: 'Tell me' }, { value: 'ollama', label: 'Use Ollama' }]} />
        </Row>
      </Section>
    </>
  )
}
