// The packaged app (dist/win-unpacked/Clawd.exe, from npm run dist): bundled resources resolve,
// the native helper and the speech engine load from outside the asar, and the agent answers.
import fs from 'node:fs'
import path from 'node:path'
import { check, done, launch, ROOT, sleep } from './harness.mjs'

const exe = path.join(ROOT, 'dist', 'win-unpacked', 'Clawd.exe')
if (!fs.existsSync(exe)) {
  console.log('FAIL  Packaged app not found; run npm run dist first')
  process.exit(1)
}
const { main, page, close } = await launch({ exe, settings: { voice: { enabled: true, speak: true, volume: 0 } } })
try {
  await sleep(4000)
  const info = await main(({ app }) => {
    const c = globalThis.__clawd
    return { packaged: app.isPackaged, native: c.native.available, bridge: !!c.bridge.port, overlay: c.overlays.perf }
  })
  check('Runs as the packaged app', info.packaged === true)
  check('Native helper starts from resources/native', info.native === true)
  check('Bridge server is up', info.bridge)
  const res = await main(() => {
    const fs = process.mainModule.require('node:fs')
    const path = process.mainModule.require('node:path')
    const base = path.join(process.resourcesPath, 'app-resources')
    return ['hooks/clawd-cc-hook.js', 'extension/manifest.json', 'skills/comment-refine/SKILL.md', 'models.json'].map((p) => [p, fs.existsSync(path.join(base, p))])
  })
  check('Bundled resources resolve (hook, extension, skills, model list)', res.every(([, ok]) => ok), JSON.stringify(res))
  const skills = await main(() => globalThis.__clawd.brain.call('skills.list'))
  check('Built-in skills load in the agent service', skills.length >= 5, skills.map((s) => s.name).join(', '))

  // Speech engine (native addon from app.asar.unpacked): Kokoro speaks at volume 0.
  const spoke = await main(async () => {
    const c = globalThis.__clawd
    const seen = []
    const on = (v) => seen.push(v)
    c.voice.on('speaking', on)
    await c.voice.speak('Hello from the installed Clawd.')
    const t0 = Date.now()
    while (Date.now() - t0 < 25000 && !(seen.includes(true) && seen.at(-1) === false)) await new Promise((r) => setTimeout(r, 100))
    c.voice.off('speaking', on)
    return { seen, error: c.voice.status().error ?? null }
  })
  check('Speech engine loads and speaks', spoke.seen.includes(true) && !spoke.error, JSON.stringify(spoke))

  // A real request through the panel.
  await main(() => globalThis.__clawd.panel.show(true, { context: null }))
  const panel = await page('panel')
  await panel.waitForSelector('.askbar textarea')
  await panel.fill('.askbar textarea', 'What is 12 times 12? Reply with just the number.')
  await panel.keyboard.press('Enter')
  await panel.waitForFunction(() => document.querySelector('.result .answer .md')?.textContent.trim().length > 0, null, { timeout: 120000 }).catch(() => {})
  const answer = await panel.evaluate(() => document.querySelector('.result .answer .md')?.textContent.trim() ?? '')
  check('The agent answers', /144/.test(answer), answer.slice(0, 60))
} finally {
  await close()
}
done()
