// End-to-end check of the local voice stack with real models (no microphone needed):
// Kokoro speaks "Hey Clawd, ..." -> resample to 16 kHz -> keyword spotter must fire ->
// VAD segments the request -> Moonshine transcribes it. Also reports timings.
// Usage: node tests/integration/voice-pipeline.mjs [modelsDir]
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')
const models = path.resolve(process.argv[2] ?? 'models')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-voice-'))
await build({ entryPoints: ['src/voice/kws-tokens.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: path.join(tmp, 'kt.cjs'), logLevel: 'error' })
const kt = require(path.join(tmp, 'kt.cjs'))

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// --- TTS ---
const kd = path.join(models, 'kokoro-multi-lang-v1_0')
let t0 = Date.now()
const tts = new sherpa.OfflineTts({
  model: {
    kokoro: { model: path.join(kd, 'model.onnx'), voices: path.join(kd, 'voices.bin'), tokens: path.join(kd, 'tokens.txt'), dataDir: path.join(kd, 'espeak-ng-data'), lexicon: ['lexicon-us-en.txt', 'lexicon-gb-en.txt'].map((f) => path.join(kd, f)).join(','), lang: 'en-us' },
    numThreads: 4,
    provider: 'cpu',
    debug: 0,
  },
  maxNumSentences: 1,
})
check('Kokoro loads', tts.sampleRate > 0, `${tts.numSpeakers} voices, ${tts.sampleRate} Hz, ${Date.now() - t0} ms`)

function speak(text, sid = 18) {
  const t = Date.now()
  const a = tts.generate({ text, sid, speed: 1.0 })
  return { ...a, ms: Date.now() - t }
}
function resample(samples, from, to) {
  const ratio = from / to
  const out = new Float32Array(Math.floor(samples.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio
    const i0 = Math.floor(x)
    const f = x - i0
    out[i] = (samples[i0] ?? 0) * (1 - f) + (samples[i0 + 1] ?? 0) * f
  }
  return out
}
const silence = (sec) => new Float32Array(Math.round(sec * 16000))
const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const wake = speak('Hey Claude!') // spoken 'Hey Clawd': Kokoro has no 'Clawd' in its lexicon
const req = speak('What is the weather like in Stockholm today?')
check('Kokoro synthesises', wake.samples.length > 0 && req.samples.length > 0, `wake ${wake.ms} ms for ${(wake.samples.length / wake.sampleRate).toFixed(2)} s, request ${req.ms} ms for ${(req.samples.length / req.sampleRate).toFixed(2)} s (RTF ${(req.ms / 1000 / (req.samples.length / req.sampleRate)).toFixed(2)})`)
const wake16 = resample(wake.samples, wake.sampleRate, 16000)
const req16 = resample(req.samples, req.sampleRate, 16000)

// --- KWS ---
const kwd = path.join(models, 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01')
const vocab = kt.loadVocab(fs.readFileSync(path.join(kwd, 'tokens.txt'), 'utf8'))
const scores = kt.loadPieceScores(fs.readFileSync(path.join(kwd, 'bpe.model')))
const kwFile = path.join(tmp, 'kw.txt')
fs.writeFileSync(kwFile, kt.keywordsFile('Hey Clawd', vocab, 0.5, scores).text)
const m = (b) => path.join(kwd, `${b}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`)
const kws = new sherpa.KeywordSpotter({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { transducer: { encoder: m('encoder'), decoder: m('decoder'), joiner: m('joiner') }, tokens: path.join(kwd, 'tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0 },
  maxActivePaths: 4,
  numTrailingBlanks: 1,
  keywordsScore: 1.0,
  keywordsThreshold: 0.25,
  keywordsFile: kwFile,
})
function spot(samples) {
  const s = kws.createStream()
  const hits = []
  t0 = Date.now()
  for (let i = 0; i < samples.length; i += 1600) {
    s.acceptWaveform({ sampleRate: 16000, samples: samples.subarray(i, i + 1600) })
    while (kws.isReady(s)) kws.decode(s)
    const r = kws.getResult(s)
    if (r.keyword) {
      hits.push({ keyword: r.keyword, at: i / 16000 })
      kws.reset(s)
    }
  }
  return { hits, ms: Date.now() - t0 }
}
const stream = concat(silence(0.6), wake16, silence(0.4), req16, silence(1.2))
const pos = spot(stream)
check('Wake word fires on "Hey Clawd"', pos.hits.length >= 1, `${JSON.stringify(pos.hits)} (${pos.ms} ms for ${(stream.length / 16000).toFixed(1)} s audio)`)
// Other voices too.
let voiceHits = 0
for (const sid of [3, 11, 16, 21, 26]) {
  const w = speak('Hey Claude.', sid)
  if (spot(concat(silence(0.4), resample(w.samples, w.sampleRate, 16000), silence(0.8))).hits.length) voiceHits++
}
check('Wake word fires across 5 other voices', voiceHits >= 4, `${voiceHits}/5`)
let falseHits = 0
for (const text of ['The weather in Stockholm is cloudy with light rain.', 'Hey there, how are you doing today?', 'Please close the window before you leave.', 'I clawed my way out of the meeting.', 'Cloud computing costs went down.']) {
  const n = speak(text)
  falseHits += spot(concat(silence(0.3), resample(n.samples, n.sampleRate, 16000), silence(0.6))).hits.length
}
check('No false triggers on 5 non-wake sentences', falseHits === 0, `${falseHits} false hits`)

// --- VAD + ASR ---
const vad = new sherpa.Vad({ sileroVad: { model: path.join(models, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.9, minSpeechDuration: 0.2, maxSpeechDuration: 20, windowSize: 512 }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0 }, 30)
const utter = concat(silence(0.5), req16, silence(1.5))
let detected = false
const segs = []
for (let i = 0; i < utter.length; i += 1600) {
  vad.acceptWaveform(utter.subarray(i, i + 1600))
  if (vad.isDetected()) detected = true
  while (!vad.isEmpty()) {
    segs.push(vad.front().samples)
    vad.pop()
  }
}
check('VAD finds the spoken request', detected && segs.length >= 1, `${segs.length} segment(s), ${(segs.reduce((n, s) => n + s.length, 0) / 16000).toFixed(2)} s`)
const md = path.join(models, 'sherpa-onnx-moonshine-base-en-int8')
const asr = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { moonshine: { preprocessor: path.join(md, 'preprocess.onnx'), encoder: path.join(md, 'encode.int8.onnx'), uncachedDecoder: path.join(md, 'uncached_decode.int8.onnx'), cachedDecoder: path.join(md, 'cached_decode.int8.onnx') }, tokens: path.join(md, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0 },
})
t0 = Date.now()
const s = asr.createStream()
s.acceptWaveform({ sampleRate: 16000, samples: segs.length ? concat(...segs) : req16 })
asr.decode(s)
const text = asr.getResult(s).text.trim()
const want = /weather/i.test(text) && /stockholm/i.test(text)
check('Moonshine transcribes the request', want, `"${text}" in ${Date.now() - t0} ms`)

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
