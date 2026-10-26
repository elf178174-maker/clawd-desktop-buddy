// Touching Clawd and the global shortcuts: poke, double-click to talk, high-five, drag and drop,
// real shortcut key presses, and settings that survive a restart. Pointer input goes straight to
// the overlay page (your real mouse stays put); shortcut presses are real keystrokes that only
// Clawd's own registered hotkeys receive.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { check, done, launch, ROOT, sleep } from './harness.mjs'

function native(m, a = {}) {
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
    p.stdin.write(JSON.stringify({ id: 1, m, a }) + '\n')
  })
}

let app = await launch({ settings: { companion: { gravity: true }, appearance: { reducedMotion: false } } })
const { main, dir } = app
try {
  await sleep(3000)
  // The overlay that shows Clawd.
  let overlay = null
  for (const w of app.app.windows().filter((p) => p.url().includes('/overlay/'))) {
    if (await w.evaluate(() => !!window.__clawd?.hit)) overlay = w
  }
  check('Found the overlay showing Clawd', !!overlay)
  const hit = () => overlay.evaluate(() => window.__clawd.hit)
  // After a drop (which follows the real mouse, possibly onto another monitor): back to his corner
  // on the primary display, and find his overlay again.
  const home = async () => {
    await main(() => globalThis.__clawd.settings.set({ companion: { display: 'primary', corner: 'bottom-right' } }))
    await sleep(2500)
    for (const w of app.app.windows().filter((p) => p.url().includes('/overlay/'))) {
      if (await w.evaluate(() => !!window.__clawd?.hit)) overlay = w
    }
  }
  const center = async () => {
    const h = await hit()
    return { x: h.x + h.w / 2, y: h.y + h.h * 0.55 }
  }
  // Records every engine state for a while (one-shots are short).
  const watch = (ms) => overlay.evaluate((ms) => new Promise((resolve) => {
    const seen = new Set()
    const t0 = performance.now()
    const tick = () => {
      seen.add(window.__clawd.engine.state)
      if (window.__clawd.override) seen.add('override:' + window.__clawd.override)
      if (performance.now() - t0 < ms) requestAnimationFrame(tick)
      else resolve([...seen])
    }
    tick()
  }), ms)

  // Poke
  let c = await center()
  const pokeSeen = watch(1400)
  await overlay.mouse.click(c.x, c.y)
  const poke = await pokeSeen
  check('A click pokes him', poke.includes('poke'), poke.join(','))
  await overlay.mouse.move(c.x - 400, c.y - 300)
  await sleep(1500)

  // Double-click opens the panel
  c = await center()
  const waveSeen = watch(1200)
  await overlay.mouse.click(c.x, c.y)
  await sleep(90)
  await overlay.mouse.click(c.x, c.y)
  const wave = await waveSeen
  await sleep(600)
  const panelOpen = await main(() => globalThis.__clawd.panel.visible)
  check('A double-click opens the panel and he perks up', panelOpen && wave.includes('interrupt'), wave.join(','))
  await main(() => globalThis.__clawd.panel.hide())
  await overlay.mouse.move(c.x - 400, c.y - 300)
  await sleep(2500)

  // High-five: bring the pointer over at a normal speed (a fast swipe makes him fade out of the
  // way instead), rest it on him, he raises a claw, click it.
  c = await center()
  for (let i = 40; i >= 0; i--) {
    await overlay.mouse.move(c.x - i * 10, c.y - i * 7.5)
    await sleep(16)
  }
  for (let i = 0; i < 8; i++) {
    await overlay.mouse.move(c.x + (i % 2), c.y)
    await sleep(150)
  }
  const offered = await overlay.evaluate(() => window.__clawd.override)
  check('Resting the pointer on him offers a high-five', offered === 'offerFive', String(offered))
  await sleep(300)
  const hand = await overlay.evaluate(() => window.__clawd.hand)
  const fiveSeen = watch(1200)
  await overlay.mouse.click(hand.x, hand.y + 4)
  const five = await fiveSeen
  check('Clicking his raised claw completes the high-five', five.includes('highFive'), five.join(','))
  await overlay.mouse.move(c.x - 400, c.y - 300)
  await sleep(2000)

  // Drag and drop
  c = await center()
  const before = await main(() => globalThis.__clawd.settings.get().companion)
  const dragSeen = watch(2600)
  await overlay.mouse.move(c.x, c.y)
  await overlay.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await overlay.mouse.move(c.x - i * 18, c.y - i * 10)
    await sleep(25)
  }
  await overlay.mouse.up()
  const drag = await dragSeen
  await sleep(400)
  const after = await main(() => globalThis.__clawd.settings.get().companion)
  // The drop point is the real cursor (robust across mixed-DPI monitors); if your mouse is on the
  // other display he moves there ('leave' here, 'enter' there).
  check('Dragging lifts him and dropping lands him', drag.includes('dragged') && (drag.includes('drop') || drag.includes('leave')), drag.join(','))
  check('The new spot is saved', after.corner === 'custom' && typeof after.customX === 'number', `${before.corner} -> ${after.corner} ${after.customX?.toFixed?.(3)}`)

  await home()

  // A drag that ends without a release (the window loses focus) never leaves him stuck.
  await sleep(1500)
  c = await center()
  await overlay.mouse.move(c.x, c.y)
  await overlay.mouse.down()
  for (let i = 1; i <= 6; i++) await overlay.mouse.move(c.x - i * 15, c.y - i * 8)
  await overlay.evaluate(() => window.dispatchEvent(new Event('blur')))
  await sleep(1200)
  const after2 = await overlay.evaluate(() => ({ override: window.__clawd.override, state: window.__clawd.engine.state }))
  await overlay.mouse.up()
  check('An interrupted drag ends cleanly', after2.override !== 'dragged' && after2.state !== 'dragged', JSON.stringify(after2))
  await home()

  // Three quick clicks: dizzy, and not a double-click.
  await sleep(1500)
  await main(() => globalThis.__clawd.panel.hide())
  c = await center()
  const dizzySeen = watch(1500)
  for (let i = 0; i < 3; i++) {
    await overlay.mouse.click(c.x, c.y)
    await sleep(70)
  }
  const dz = await dizzySeen
  await sleep(500)
  const opened = await main(() => globalThis.__clawd.panel.visible)
  check('Three quick clicks make him dizzy without opening the panel', dz.includes('dizzy') && !opened, `${dz.join(',')} panel=${opened}`)

  // Global shortcuts: registered, and a real key press reaches Clawd.
  const sc = await main(() => globalThis.__clawd.shortcuts.list())
  check('All six global shortcuts are registered', sc.length === 6 && sc.every((s) => s.registered), sc.map((s) => `${s.accelerator}:${s.registered}`).join(' '))
  const summon = sc.find((s) => s.action === 'summon')
  if (summon.accelerator !== 'Ctrl+Alt+Space') console.log(`NOTE  Ctrl+Alt+Space belongs to another app here; summon moved to ${summon.accelerator}`)
  await native('sendKeys', { keys: summon.accelerator.toLowerCase() })
  const summoned = await (async () => {
    for (let i = 0; i < 30; i++) {
      if (await main(() => globalThis.__clawd.panel.visible)) return true
      await sleep(100)
    }
    return false
  })()
  check(`${summon.accelerator} opens the panel (real key press)`, summoned)
  await main(() => globalThis.__clawd.panel.hide())
  await sleep(300)
  await native('sendKeys', { keys: 'ctrl+alt+h' })
  await sleep(700)
  const hidden = await main(() => globalThis.__clawd.companion.state.visibility)
  await native('sendKeys', { keys: 'ctrl+alt+h' })
  await sleep(900)
  const shown = await main(() => globalThis.__clawd.companion.state.visibility)
  check('Ctrl+Alt+H hides and shows him (real key press)', hidden === 'hidden' && shown !== 'hidden', `${hidden} -> ${shown}`)

  // A settings change that must survive a restart.
  await main(() => globalThis.__clawd.settings.set({ appearance: { shadow: false, cursorStyle: 'pixel' }, companion: { size: 9, corner: 'bottom-left' } }))
  await sleep(300)
} finally {
  await app.close({ keep: true })
}

app = await launch({ dataDir: dir, reuse: true })
try {
  await sleep(2000)
  const s = await app.main(() => globalThis.__clawd.settings.get())
  check('Settings survive a restart', s.appearance.shadow === false && s.appearance.cursorStyle === 'pixel' && s.companion.size === 9 && s.companion.corner === 'bottom-left', JSON.stringify({ shadow: s.appearance.shadow, cursor: s.appearance.cursorStyle, size: s.companion.size, corner: s.companion.corner }))
} finally {
  await app.close()
}
done()
