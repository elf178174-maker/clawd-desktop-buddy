// Voice-first summon: opening Clawd starts listening at once; typing switches to the keyboard;
// a spoken request goes through the panel like a typed one. The microphone is Chromium's fake
// capture device playing a request spoken by Kokoro, so the real VAD and recogniser run.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { check, done, launch, ROOT, SHOTS, sleep } from './harness.mjs'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

// --- the "microphone": 2.5 s of quiet, the request, then quiet (16-bit PCM WAV, played once) ---
const kd = path.join(ROOT, 'models', 'kokoro-multi-lang-v1_0')
const tts = new sherpa.OfflineTts({
  model: {
    kokoro: { model: path.join(kd, 'model.onnx'), voices: path.join(kd, 'voices.bin'), tokens: path.join(kd, 'tokens.txt'), dataDir: path.join(kd, 'espeak-ng-data'), lexicon: ['lexicon-us-en.txt', 'lexicon-gb-en.txt'].map((f) => path.join(kd, f)).join(','), lang: 'en-us' },
    numThreads: 4,
    provider: 'cpu',
    debug: 0,
  },
  maxNumSentences: 1,
})
const spoken = tts.generate({ text: 'What is the capital of France?', sid: 18, speed: 1.0 })
const rate = spoken.sampleRate
const pad = (sec) => new Float32Array(Math.round(sec * rate))
const parts = [pad(2.5), spoken.samples, pad(4)]
const total = parts.reduce((n, p) => n + p.length, 0)
const pcm = Buffer.alloc(44 + total * 2)
pcm.write('RIFF', 0)
pcm.writeUInt32LE(36 + total * 2, 4)
pcm.write('WAVEfmt ', 8)
pcm.writeUInt32LE(16, 16)
pcm.writeUInt16LE(1, 20)
pcm.writeUInt16LE(1, 22)
pcm.writeUInt32LE(rate, 24)
pcm.writeUInt32LE(rate * 2, 28)
pcm.writeUInt16LE(2, 32)
pcm.writeUInt16LE(16, 34)
pcm.write('data', 36)
pcm.writeUInt32LE(total * 2, 40)
let o = 44
for (const p of parts) for (const s of p) (pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), o), (o += 2))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-voicefirst-'))
const wav = path.join(tmp, 'request.wav')
fs.writeFileSync(wav, pcm)

const { main, page, close } = await launch({
  settings: { voice: { enabled: true, listenOnSummon: true, speak: false } },
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav.replace(/\\/g, '/')}%noloop`],
})
const capturing = () => main(() => globalThis.__clawd.voice.isCapturing)
const panelShown = () => main(() => globalThis.__clawd.panel.visible)
const waitFor = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await sleep(100)
  }
  return false
}

try {
  await sleep(3000)
  // 1. Summon: the panel opens already listening.
  await main(() => void globalThis.__clawd.summon())
  const panel = await page('panel')
  await panel.waitForSelector('.askbar textarea')
  const listening = await waitFor(capturing, 4000)
  check('Summon starts listening right away', listening)
  await waitFor(panelShown, 4000)
  const bar = await panel.waitForSelector('.askbar.listening', { timeout: 3000 }).then(() => true, () => false)
  const placeholder = await panel.evaluate(() => document.querySelector('.askbar textarea').placeholder)
  check('Ask bar shows it is listening and invites typing', bar && /Listening… or just start typing/.test(placeholder), placeholder)
  const focused = await panel.evaluate(() => document.activeElement === document.querySelector('.askbar textarea'))
  check('Text box is focused, ready to type', focused)
  await panel.screenshot({ path: path.join(SHOTS, 'voice-first-listening.png') })

  // 2. Typing switches to the keyboard: listening stops at the first key.
  await panel.type('.askbar textarea', 'w')
  const stopped = await waitFor(async () => !(await capturing()), 1500)
  check('Typing stops listening', stopped)
  const barAfter = await panel.evaluate(() => document.querySelector('.askbar').className)
  check('Ask bar goes back to typing mode', !/listening/.test(barAfter), barAfter)
  const companionListening = await main(() => globalThis.__clawd.companion.state.listening)
  check('Clawd stops his listening pose', companionListening === false)

  // 3. Closing the panel while listening stops the microphone.
  await panel.fill('.askbar textarea', '')
  await main(() => globalThis.__clawd.panel.hide())
  await sleep(400)
  await main(() => void globalThis.__clawd.summon())
  await waitFor(capturing, 4000)
  await waitFor(panelShown, 4000)
  await main(() => globalThis.__clawd.panel.hide())
  check('Closing the panel stops listening', await waitFor(async () => !(await capturing()), 1500))

  // 4. Speak: the request goes through the panel as a voice task and gets answered.
  await sleep(400)
  await main(() => void globalThis.__clawd.summon())
  check('Summon listens again', await waitFor(capturing, 4000))
  const t0 = Date.now()
  const heard = await panel.waitForFunction(() => document.querySelector('.result-request')?.textContent.trim().length > 5, null, { timeout: 20000 }).then(() => true, () => false)
  const request = heard ? await panel.evaluate(() => document.querySelector('.result-request').textContent.trim()) : ''
  check('What you say lands in the panel as the request', /capital of france/i.test(request), `${request} (${Date.now() - t0} ms)`)
  await panel.waitForFunction(() => document.querySelector('.result .answer .md')?.textContent.trim().length > 2, null, { timeout: 120000 }).catch(() => {})
  const answer = await panel.evaluate(() => document.querySelector('.result .answer .md')?.textContent.trim() ?? '')
  check('Clawd answers the spoken request', /paris/i.test(answer), answer.slice(0, 120))
  const source = await main(async () => {
    const list = await globalThis.__clawd.brain.call('tasks.list')
    const t = list[0] && (await globalThis.__clawd.brain.call('tasks.get', list[0].id))
    return t?.source
  })
  check('The task is marked as spoken', source === 'voice', String(source))
  await panel.screenshot({ path: path.join(SHOTS, 'voice-first-answer.png') })

  // 5. Kokoro speaks inside Electron (at volume 0 so the test stays silent).
  const spokeOk = await main(async () => {
    const c = globalThis.__clawd
    c.settings.set({ voice: { speak: true, volume: 0 } })
    const seen = []
    const onSpeaking = (on) => seen.push(on)
    c.voice.on('speaking', onSpeaking)
    await c.voice.speak('Paris is the capital of France.')
    const t0 = Date.now()
    while (Date.now() - t0 < 20000 && !(seen.includes(true) && seen.at(-1) === false)) await new Promise((r) => setTimeout(r, 100))
    c.voice.off('speaking', onSpeaking)
    return { seen, error: c.voice.status().error ?? null }
  })
  check('Kokoro speaks an answer inside the app', spokeOk.seen.includes(true) && spokeOk.seen.at(-1) === false && !spokeOk.error, JSON.stringify(spokeOk))
} finally {
  await close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
done()
