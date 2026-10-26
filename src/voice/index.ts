// Voice service (Electron utility process): local wake-word spotting, voice activity detection,
// speech recognition and Kokoro speech synthesis, all with sherpa-onnx. Microphone audio arrives
// as 16 kHz mono frames over a MessagePort from the hidden audio window; nothing leaves the PC.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RpcPeer, type RpcMessage } from '../shared/rpc'
import { keywordsFile, loadPieceScores, loadVocab } from './kws-tokens'

// sherpa-onnx-node is a native module loaded at runtime (kept out of the bundle).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sherpa = require('sherpa-onnx-node') as SherpaModule

interface SherpaStream {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void
}
interface SherpaModule {
  KeywordSpotter: new (cfg: unknown) => {
    createStream(): SherpaStream
    isReady(s: SherpaStream): boolean
    decode(s: SherpaStream): void
    reset(s: SherpaStream): void
    getResult(s: SherpaStream): { keyword: string }
  }
  Vad: new (cfg: unknown, bufferSeconds: number) => {
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    isDetected(): boolean
    /** Pass false: Electron's V8 memory cage forbids external buffers (throws and kills the process). */
    front(enableExternalBuffer: boolean): { samples: Float32Array; start: number }
    pop(): void
    clear(): void
    flush(): void
    reset(): void
  }
  OfflineRecognizer: new (cfg: unknown) => {
    createStream(): SherpaStream
    decode(s: SherpaStream): void
    getResult(s: SherpaStream): { text: string }
  }
  OfflineTts: new (cfg: unknown) => {
    sampleRate: number
    numSpeakers: number
    generateAsync(o: { text: string; sid: number; speed: number; enableExternalBuffer: boolean }): Promise<{ samples: Float32Array; sampleRate: number }>
  }
}

interface ParentPort {
  on(event: 'message', fn: (e: { data: unknown; ports: MessagePortLike[] }) => void): void
  postMessage(msg: unknown): void
}
interface MessagePortLike {
  on(event: 'message', fn: (e: { data: unknown }) => void): void
  postMessage(msg: unknown, transfer?: unknown[]): void
  start(): void
}

const port = (process as unknown as { parentPort: ParentPort }).parentPort
const rpc = new RpcPeer((m) => port.postMessage(m))
let audio: MessagePortLike | null = null

port.on('message', (e) => {
  const d = e.data as { type?: string } | RpcMessage
  if ((d as { type?: string }).type === 'audio-port' && e.ports?.[0]) {
    audio = e.ports[0]
    audio.on('message', (m) => onAudio(m.data as AudioMsg))
    audio.start()
    return
  }
  void rpc.receive(d as RpcMessage)
})

type AudioMsg = { type: 'frame'; samples: Float32Array } | { type: 'played'; id: string }

// Kokoro multi-lang v1.0 speaker order (sid = index).
const KOKORO_VOICES = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
]

interface Config {
  modelsDir: string
  wakeWord: boolean
  wakePhrase: string
  sensitivity: number
  endSilenceMs: number
  maxUtteranceSec: number
}

let cfg: Config | null = null
let kws: InstanceType<SherpaModule['KeywordSpotter']> | null = null
let kwsStream: SherpaStream | null = null
let vad: InstanceType<SherpaModule['Vad']> | null = null
let asr: InstanceType<SherpaModule['OfflineRecognizer']> | null = null
let tts: InstanceType<SherpaModule['OfflineTts']> | null = null
let mode: 'idle' | 'capture' = 'idle'
let captureStarted = 0
let heardSpeech = false
let captureTimeout = 6
let levelAt = 0
let speakSeq = 0
let speaking: string | null = null

function dir(name: string): string {
  return path.join(cfg!.modelsDir, name)
}

function threads(): number {
  return Math.max(1, Math.min(4, Math.floor(os.cpus().length / 3)))
}

function initKws(): string | null {
  kws = null
  kwsStream = null
  if (!cfg?.wakeWord) return null
  const d = dir('sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01')
  if (!fs.existsSync(path.join(d, 'tokens.txt'))) return 'Wake-word model is not downloaded.'
  const vocab = loadVocab(fs.readFileSync(path.join(d, 'tokens.txt'), 'utf8'))
  const bpe = path.join(d, 'bpe.model')
  const scores = fs.existsSync(bpe) ? loadPieceScores(fs.readFileSync(bpe)) : undefined
  const kw = keywordsFile(cfg.wakePhrase, vocab, cfg.sensitivity, scores)
  if (!kw.lines) return `"${cfg.wakePhrase}" cannot be spelled with the wake-word model's vocabulary. Use plain English words.`
  const kwFile = path.join(os.tmpdir(), `clawd-keywords-${process.pid}.txt`)
  fs.writeFileSync(kwFile, kw.text)
  const pick = (base: string) => [`${base}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`, `${base}-epoch-12-avg-2-chunk-16-left-64.onnx`].map((f) => path.join(d, f)).find((f) => fs.existsSync(f)) ?? findOnnx(d, base)
  kws = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: pick('encoder'), decoder: pick('decoder'), joiner: pick('joiner') },
      tokens: path.join(d, 'tokens.txt'),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: 1.0,
    keywordsThreshold: 0.25,
    keywordsFile: kwFile,
  })
  kwsStream = kws.createStream()
  return null
}

function findOnnx(d: string, prefix: string): string {
  const f = fs.readdirSync(d).find((x) => x.startsWith(prefix) && x.endsWith('.int8.onnx')) ?? fs.readdirSync(d).find((x) => x.startsWith(prefix) && x.endsWith('.onnx'))
  if (!f) throw new Error(`Missing ${prefix} model in ${d}`)
  return path.join(d, f)
}

function initVad(): void {
  const file = path.join(cfg!.modelsDir, 'silero_vad.onnx')
  if (!fs.existsSync(file)) throw new Error('Voice activity model is not downloaded.')
  vad = new sherpa.Vad(
    {
      sileroVad: { model: file, threshold: 0.5, minSilenceDuration: cfg!.endSilenceMs / 1000, minSpeechDuration: 0.2, maxSpeechDuration: cfg!.maxUtteranceSec, windowSize: 512 },
      sampleRate: 16000,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    cfg!.maxUtteranceSec + 10,
  )
}

function initAsr(): void {
  const d = dir('sherpa-onnx-moonshine-base-en-int8')
  if (!fs.existsSync(path.join(d, 'tokens.txt'))) throw new Error('Speech recognition model is not downloaded.')
  asr = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      moonshine: {
        preprocessor: path.join(d, 'preprocess.onnx'),
        encoder: path.join(d, 'encode.int8.onnx'),
        uncachedDecoder: path.join(d, 'uncached_decode.int8.onnx'),
        cachedDecoder: path.join(d, 'cached_decode.int8.onnx'),
      },
      tokens: path.join(d, 'tokens.txt'),
      numThreads: threads(),
      provider: 'cpu',
      debug: 0,
    },
  })
}

function initTts(): void {
  const d = dir('kokoro-multi-lang-v1_0')
  if (!fs.existsSync(path.join(d, 'voices.bin'))) throw new Error('Voice model is not downloaded.')
  const lexicon = ['lexicon-us-en.txt', 'lexicon-gb-en.txt'].map((f) => path.join(d, f)).filter((f) => fs.existsSync(f)).join(',')
  tts = new sherpa.OfflineTts({
    model: {
      kokoro: {
        model: path.join(d, 'model.onnx'),
        voices: path.join(d, 'voices.bin'),
        tokens: path.join(d, 'tokens.txt'),
        dataDir: path.join(d, 'espeak-ng-data'),
        lexicon,
        lang: 'en-us',
      },
      numThreads: threads(),
      provider: 'cpu',
      debug: 0,
    },
    maxNumSentences: 1,
  })
}

function rms(s: Float32Array): number {
  let sum = 0
  for (let i = 0; i < s.length; i++) sum += s[i] * s[i]
  return Math.sqrt(sum / Math.max(1, s.length))
}

function onAudio(m: AudioMsg): void {
  if (!m || typeof m !== 'object') return
  if (m.type === 'played') {
    if (speaking === m.id) {
      speaking = null
      rpc.emit('speakEnd', { id: m.id })
    }
    return
  }
  if (m.type !== 'frame' || !(m.samples instanceof Float32Array)) return
  const samples = m.samples
  if (mode === 'capture') return capture(samples)
  if (kws && kwsStream) {
    kwsStream.acceptWaveform({ sampleRate: 16000, samples })
    while (kws.isReady(kwsStream)) kws.decode(kwsStream)
    const r = kws.getResult(kwsStream)
    if (r.keyword) {
      kws.reset(kwsStream)
      rpc.emit('wake', { keyword: r.keyword })
    }
  }
}

function startCapture(timeoutSec = 6): void {
  if (!vad) initVad()
  vad!.clear()
  vad!.reset()
  mode = 'capture'
  captureStarted = Date.now()
  heardSpeech = false
  captureTimeout = timeoutSec
  rpc.emit('capture', { state: 'listening' })
}

function stopCapture(reason: 'timeout' | 'cancel' | 'done'): void {
  mode = 'idle'
  if (kws && kwsStream) kws.reset(kwsStream)
  if (reason !== 'done') rpc.emit('capture', { state: reason })
}

function capture(samples: Float32Array): void {
  const now = Date.now()
  if (now - levelAt > 66) {
    levelAt = now
    rpc.emit('level', Math.min(1, rms(samples) * 9))
  }
  vad!.acceptWaveform(samples)
  if (vad!.isDetected()) heardSpeech = true
  const elapsed = (now - captureStarted) / 1000
  if (!heardSpeech && elapsed > captureTimeout) return stopCapture('timeout')
  if (elapsed > cfg!.maxUtteranceSec + 2) vad!.flush()
  if (!vad!.isEmpty()) {
    // One finished utterance: recognise it.
    const chunks: Float32Array[] = []
    while (!vad!.isEmpty()) {
      chunks.push(vad!.front(false).samples)
      vad!.pop()
    }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const all = new Float32Array(total)
    let o = 0
    for (const c of chunks) {
      all.set(c, o)
      o += c.length
    }
    stopCapture('done')
    rpc.emit('capture', { state: 'recognizing' })
    try {
      if (!asr) initAsr()
      const t0 = Date.now()
      const stream = asr!.createStream()
      stream.acceptWaveform({ sampleRate: 16000, samples: all })
      asr!.decode(stream)
      const text = asr!.getResult(stream).text.trim()
      rpc.emit('transcript', { text, seconds: total / 16000, ms: Date.now() - t0 })
    } catch (err) {
      rpc.emit('error', { message: (err as Error).message })
    }
  }
}

/** Splits text into speakable chunks (sentences, capped in length). */
export function sentences(text: string): string[] {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    // Kokoro's lexicon has no "Clawd"; "Claude" is the same sound.
    .replace(/\bClawd\b/gi, 'Claude')
    .replace(/[*_#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const parts = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []
  const out: string[] = []
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (p.length <= 220) out.push(p)
    else for (let i = 0; i < p.length; i += 200) out.push(p.slice(i, i + 200))
  }
  return out
}

rpc.setHandlers({
  configure(c: Config) {
    const kwsChanged = !cfg || cfg.wakeWord !== c.wakeWord || cfg.wakePhrase !== c.wakePhrase || cfg.sensitivity !== c.sensitivity || cfg.modelsDir !== c.modelsDir
    const vadChanged = !cfg || cfg.endSilenceMs !== c.endSilenceMs || cfg.maxUtteranceSec !== c.maxUtteranceSec
    cfg = c
    if (vadChanged) vad = null
    return { kwsError: kwsChanged ? initKws() : null }
  },
  startCapture(timeoutSec?: number) {
    startCapture(timeoutSec)
  },
  cancelCapture() {
    if (mode === 'capture') stopCapture('cancel')
  },
  voices: () => KOKORO_VOICES,
  async speak(text: string, voice: string, speed: number) {
    if (!tts) initTts()
    const id = `s${++speakSeq}`
    speaking = id
    const sid = Math.max(0, KOKORO_VOICES.indexOf(voice))
    const parts = sentences(text)
    rpc.emit('speakStart', { id })
    for (let i = 0; i < parts.length; i++) {
      if (speaking !== id) return { id, cancelled: true }
      const audioOut = await tts!.generateAsync({ text: parts[i], sid, speed, enableExternalBuffer: false })
      if (speaking !== id) return { id, cancelled: true }
      audio?.postMessage({ type: 'tts', id, samples: audioOut.samples, sampleRate: audioOut.sampleRate, last: i === parts.length - 1 })
    }
    if (!parts.length) {
      speaking = null
      rpc.emit('speakEnd', { id })
    }
    return { id, cancelled: false }
  },
  stopSpeaking() {
    const id = speaking
    speaking = null
    audio?.postMessage({ type: 'stop' })
    if (id) rpc.emit('speakEnd', { id, interrupted: true })
  },
  ping: () => 'pong',
})

rpc.emit('ready', null)
