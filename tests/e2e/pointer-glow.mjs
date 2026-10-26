// Visual check on the real desktop: Clawd points at a spot; capture the cursor in flight, the
// arrival with its focus ring, and the screen-edge glow.
import path from 'node:path'
import { spawn } from 'node:child_process'
import { check, done, launch, ROOT, SHOTS, sleep } from './harness.mjs'

function capture(file, a) {
  return new Promise((resolve, reject) => {
    const p = spawn(path.join(ROOT, 'native', 'bin', 'clawd-native.exe'), [], { stdio: ['pipe', 'pipe', 'inherit'] })
    let out = ''
    p.stdout.on('data', (b) => {
      out += b
      if (out.includes('\n')) {
        const r = JSON.parse(out.split('\n')[0])
        p.stdin.end()
        r.ok ? resolve(r.v) : reject(new Error(r.e))
      }
    })
    p.stdin.write(JSON.stringify({ id: 1, m: 'screenshot', a: { ...a, file, maxWidth: a.maxWidth ?? 0 } }) + '\n')
  })
}

const { page, main, close } = await launch({ settings: { general: { onboarded: true } } })
try {
  const overlay = await page('overlay')
  await overlay.waitForFunction(() => window.__clawd?.frame?.state === 'idle', null, { timeout: 15000 })
  const disp = await main(({ screen }) => {
    const d = screen.getPrimaryDisplay()
    return { b: d.bounds, wa: d.workArea, sf: d.scaleFactor }
  })
  // Point at a box in the middle-left of the primary display.
  const rect = { x: disp.wa.x + 420, y: disp.wa.y + 300, w: 180, h: 40 }
  await main((_e, r) => globalThis.__clawd.companion.point(r, 'Right here', 3), rect)
  const t0 = Date.now()
  await sleep(520)
  await capture(path.join(SHOTS, 'pointer-flight.png'), { target: 'screen', maxWidth: 1600 })
  await sleep(900)
  await capture(path.join(SHOTS, 'pointer-arrived.png'), { target: 'rect', x: Math.round((rect.x - 80) * disp.sf), y: Math.round((rect.y - 80) * disp.sf), w: Math.round(420 * disp.sf), h: Math.round(220 * disp.sf) })
  const glowOn = await overlay.evaluate(() => document.querySelector('.glow')?.classList.contains('on'))
  check('Edge glow shows while pointing', !!glowOn)
  await capture(path.join(SHOTS, 'glow-corner.png'), { target: 'rect', x: 0, y: Math.round(disp.wa.y * disp.sf), w: Math.round(520 * disp.sf), h: Math.round(300 * disp.sf) })
  await sleep(4200)
  const glowOff = await overlay.evaluate(() => document.querySelector('.glow')?.classList.contains('on'))
  check('Edge glow fades when the pointer is done', !glowOff, `${((Date.now() - t0) / 1000).toFixed(1)} s after start`)
} finally {
  await close()
}
done()
