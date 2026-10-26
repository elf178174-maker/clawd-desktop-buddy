// First end-to-end smoke test: Clawd appears on the desktop, the panel and settings open, a real
// request goes through the agent (local Ollama model), and idle CPU stays low.
import path from 'node:path'
import { check, done, launch, SHOTS, sleep } from './harness.mjs'

const { app, page, main, close } = await launch({ settings: { general: { onboarded: true } } })
try {
  const overlay = await page('overlay')
  // Wait for the entrance to finish.
  await overlay.waitForFunction(() => window.__clawd?.frame?.state === 'idle', null, { timeout: 15000 })
  const st = await overlay.evaluate(() => ({ vis: window.__clawd.state.visibility, anchor: window.__clawd.anchor, hit: window.__clawd.hit }))
  check('Clawd is visible on the desktop', st.vis === 'present', JSON.stringify(st.anchor))
  const bounds = await main(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/overlay/'))
    return { b: w.getBounds(), sf: screen.getDisplayMatching(w.getBounds()).scaleFactor }
  })
  // Desktop screenshot around Clawd (physical pixels).
  const sf = bounds.sf
  const cx = Math.round((bounds.b.x + st.anchor.x) * sf)
  const cy = Math.round((bounds.b.y + st.anchor.y) * sf)
  await desktopShotRect(path.join(SHOTS, 'desktop-clawd.png'), cx - 220, cy - 200, 440, 240)
  check('Desktop capture written', true, 'tests/e2e/shots/desktop-clawd.png')

  // Panel
  await main(() => globalThis.__clawd.summon())
  const panel = await page('panel')
  await panel.waitForSelector('.askbar textarea', { timeout: 10000 })
  await sleep(600)
  await panel.screenshot({ path: path.join(SHOTS, 'panel-empty.png') })
  check('Panel opens with an input', true)

  // A real request through the agent and the local model.
  await panel.fill('.askbar textarea', 'What is 17 times 23? Reply with just the number.')
  await panel.keyboard.press('Enter')
  const t0 = Date.now()
  await panel.waitForFunction(() => document.querySelector('.result .answer .md')?.textContent.trim().length > 0, null, { timeout: 180000 })
  const answer = await panel.evaluate(() => document.querySelector('.result .answer .md').textContent.trim())
  check('Agent answers through the local model', /391/.test(answer), `"${answer.slice(0, 80)}" in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  await sleep(500)
  await panel.screenshot({ path: path.join(SHOTS, 'panel-answer.png') })

  // Settings
  await main(() => globalThis.__clawd.settingsWin.open('ai'))
  const settings = await page('settings')
  await settings.waitForSelector('.providers', { timeout: 10000 })
  await sleep(800)
  await settings.screenshot({ path: path.join(SHOTS, 'settings-ai.png') })
  check('Settings opens on the AI page', true)

  // Idle cost: hide the panel and settings, then sample CPU for the overlay renderer.
  await main(() => {
    globalThis.__clawd.panel.hide()
    globalThis.__clawd.settingsWin.window?.close()
  })
  await sleep(4000)
  const m1 = await main(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name, cpu: m.cpu.percentCPUUsage })))
  await sleep(8000)
  const m2 = await main(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name, cpu: m.cpu.percentCPUUsage, mem: m.memory.workingSetSize })))
  const total = m2.reduce((s, m) => s + m.cpu, 0)
  console.log(m2.map((m) => `   ${m.type.padEnd(8)} ${String(m.name ?? '').padEnd(14)} ${m.cpu.toFixed(2)}%  ${(m.mem / 1024).toFixed(0)} MB`).join('\n'))
  const perf = await main(() => globalThis.__clawd.overlays.perf)
  check('Overlay animates at display rate', perf && perf.fps > 50, perf ? `${perf.fps.toFixed(1)} fps, ${perf.frameMs.toFixed(3)} ms/frame` : 'no perf')
  check('Idle CPU across all processes is low', total < 8, `${total.toFixed(2)}% total (one core = 100%)`)
  void m1
} finally {
  await close()
}
done()

function desktopShotRect(file, x, y, w, h) {
  return import('node:child_process').then(({ spawn }) => new Promise((resolve, reject) => {
    const p = spawn(path.join(process.cwd(), 'native', 'bin', 'clawd-native.exe'), [], { stdio: ['pipe', 'pipe', 'inherit'] })
    let out = ''
    p.stdout.on('data', (b) => {
      out += b
      if (out.includes('\n')) {
        const r = JSON.parse(out.split('\n')[0])
        p.stdin.end()
        r.ok ? resolve(r.v) : reject(new Error(r.e))
      }
    })
    p.stdin.write(JSON.stringify({ id: 1, m: 'screenshot', a: { target: 'rect', x, y, w, h, maxWidth: 0, file } }) + '\n')
  }))
}
