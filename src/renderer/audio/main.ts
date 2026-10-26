// Hidden audio window: owns the microphone (16 kHz frames to the voice service) and plays Clawd's
// voice, reporting its loudness so his speaking animation follows the actual audio.

import workletUrl from './capture.worklet.ts?worker&url'
import '../shared/bridge'

type Send = (ch: string, payload: unknown) => void
const send: Send = (ch, p) => window.clawd.send(ch, p)
const on = (ch: string, cb: (p: never) => void) => window.clawd.on(ch, cb as (p: unknown) => void)

let port: MessagePort | null = null
let micCtx: AudioContext | null = null
let micStream: MediaStream | null = null
let micNode: AudioWorkletNode | null = null
let playCtx: AudioContext | null = null
let gain: GainNode | null = null
let analyser: AnalyserNode | null = null
let nextTime = 0
let sources: AudioBufferSourceNode[] = []
let volume = 0.85
let levelTimer = 0
let pendingLast: { id: string; endAt: number } | null = null

window.addEventListener('message', (e) => {
  if (e.data === 'voice-port' && e.ports[0]) {
    port = e.ports[0]
    port.onmessage = (m) => onVoice(m.data)
    port.start()
  }
})

async function startMic(deviceId: string): Promise<void> {
  await stopMic()
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    micCtx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
    await micCtx.audioWorklet.addModule(workletUrl)
    const src = micCtx.createMediaStreamSource(micStream)
    micNode = new AudioWorkletNode(micCtx, 'clawd-capture')
    micNode.port.onmessage = (m) => {
      const samples = m.data as Float32Array
      // Copied, not transferred: the main-process port cannot receive transferred buffers.
      port?.postMessage({ type: 'frame', samples })
    }
    src.connect(micNode)
    send('audio:micState', { on: true, permission: 'granted' })
    void listDevices()
  } catch (err) {
    const e = err as DOMException
    const denied = e.name === 'NotAllowedError' || e.name === 'SecurityError'
    send('audio:micState', { on: false, error: denied ? 'Microphone access was denied.' : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'That microphone is not available.' : e.message, permission: denied ? 'denied' : 'unknown' })
  }
}

async function stopMic(): Promise<void> {
  micNode?.disconnect()
  micStream?.getTracks().forEach((t) => t.stop())
  if (micCtx && micCtx.state !== 'closed') await micCtx.close()
  micNode = null
  micStream = null
  micCtx = null
}

async function listDevices(): Promise<void> {
  const all = await navigator.mediaDevices.enumerateDevices()
  send(
    'audio:devices',
    all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
  )
}

function ensurePlayback(): AudioContext {
  if (!playCtx) {
    playCtx = new AudioContext({ latencyHint: 'playback' })
    gain = playCtx.createGain()
    gain.gain.value = volume
    analyser = playCtx.createAnalyser()
    analyser.fftSize = 512
    gain.connect(analyser)
    analyser.connect(playCtx.destination)
  }
  if (playCtx.state === 'suspended') void playCtx.resume()
  return playCtx
}

function meter(): void {
  if (!analyser) return
  const data = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(data)
  let sum = 0
  for (const v of data) sum += v * v
  send('audio:level', Math.min(1, Math.sqrt(sum / data.length) * 5))
  if (pendingLast && playCtx && playCtx.currentTime >= pendingLast.endAt) {
    port?.postMessage({ type: 'played', id: pendingLast.id })
    pendingLast = null
  }
  if (sources.length || pendingLast) levelTimer = window.setTimeout(meter, 33)
  else {
    levelTimer = 0
    send('audio:level', 0)
  }
}

function onVoice(msg: { type: string; id?: string; samples?: Float32Array; sampleRate?: number; last?: boolean }): void {
  if (msg.type === 'stop') return stopPlayback()
  if (msg.type !== 'tts' || !msg.samples || !msg.sampleRate) return
  const ctx = ensurePlayback()
  const buf = ctx.createBuffer(1, msg.samples.length, msg.sampleRate)
  buf.copyToChannel(msg.samples as Float32Array<ArrayBuffer>, 0)
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(gain!)
  const at = Math.max(ctx.currentTime + 0.03, nextTime)
  src.start(at)
  nextTime = at + buf.duration
  sources.push(src)
  src.onended = () => (sources = sources.filter((s) => s !== src))
  if (msg.last && msg.id) pendingLast = { id: msg.id, endAt: nextTime }
  if (!levelTimer) meter()
}

function stopPlayback(): void {
  for (const s of sources) {
    try {
      s.stop()
    } catch {
      /* already stopped */
    }
  }
  sources = []
  nextTime = 0
  if (pendingLast) port?.postMessage({ type: 'played', id: pendingLast.id })
  pendingLast = null
  speechSynthesis.cancel()
}

// Windows voices through the Web Speech API (fallback engine).
function sayNative(p: { text: string; voice: string; rate: number; volume: number }): void {
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(p.text)
  const v = speechSynthesis.getVoices().find((x) => x.name === p.voice)
  if (v) u.voice = v
  u.rate = p.rate
  u.volume = p.volume
  u.onstart = () => send('audio:nativeSpeech', { state: 'start' })
  u.onend = () => send('audio:nativeSpeech', { state: 'end' })
  u.onerror = () => send('audio:nativeSpeech', { state: 'end' })
  u.onboundary = () => send('audio:level', 0.5 + Math.random() * 0.4)
  speechSynthesis.speak(u)
}

on('audio:mic', (p: { on: boolean; deviceId: string }) => {
  if (p.on) void startMic(p.deviceId)
  else void stopMic().then(() => send('audio:micState', { on: false, permission: 'unknown' }))
})
on('audio:volume', (v: number) => {
  volume = v
  if (gain) gain.gain.value = v
})
on('audio:say', sayNative)
on('audio:stop', stopPlayback)
on('audio:listDevices', () => void listDevices())

navigator.mediaDevices.addEventListener('devicechange', () => void listDevices())
send('audio:ready', null)
