// The companion overlay: a transparent, click-through window covering one display's work area.
// Clawd lives on a small canvas inside it. Only his pixels (and his speech bubble) catch the mouse.

import { ClawdEngine, type EngineFrame } from '../../character/engine'
import { Director } from '../../character/director'
import { drawRects, rectSignature, type RenderView } from '../../character/render'
import type { StateName } from '../../character/states'
import type { Bubble, OverlayInit, PointRequest } from '../../shared/api'
import type { Settings } from '../../shared/settings'
import type { CompanionState } from '../../shared/types'
import { onOverlay, sendBubbleAction, sendOverlay } from '../shared/bridge'
import { EdgeGlow } from './glow'
import { PointerFx } from './pointer'
import { Sounds } from './sound'

const CANVAS_U_W = 40
const CANVAS_U_H = 34
const BELOW_GROUND_U = 4

const root = document.getElementById('root')!
const canvas = document.getElementById('clawd') as HTMLCanvasElement
const ctx = canvas.getContext('2d', { alpha: true })!
const bubbleEl = document.getElementById('bubble')!
const glow = new EdgeGlow(root)
const pointer = new PointerFx(root)
let controlling = false
const sounds = new Sounds()

let settings: Settings | null = null
let W = window.innerWidth
let H = window.innerHeight
let onEdge = true
let reducedMotionOS = false
let dpr = window.devicePixelRatio || 1
let scale = 7
let anchor = { x: W - 120, y: H }
let lastFrame: EngineFrame | null = null
let lastSig = ''
let hitRect: { x: number; y: number; w: number; h: number } | null = null
let interactive = false
let level = 0
let state: CompanionState = {
  visibility: 'hidden',
  focus: false,
  agent: 'idle',
  cc: null,
  listening: false,
  speaking: false,
  panelOpen: false,
  needsUser: false,
}

const engine = new ClawdEngine({ seed: (Date.now() % 100000) + 7 })
const director = new Director(engine, { laptopProp: true, focusIntensity: 0.45 })

// ---------- configuration ----------

function reducedMotion(): boolean {
  const pref = settings?.appearance.reducedMotion ?? 'system'
  return pref === 'on' || (pref === 'system' && reducedMotionOS)
}

/** CSS pixels per art unit, rounded so one art unit is a whole number of device pixels at any display scaling. */
const snapScale = (size: number) => Math.max(1, Math.round(size * dpr)) / dpr

function applySettings(s: Settings): void {
  settings = s
  scale = snapScale(s.companion.size)
  const focus = state.focus
  engine.configure({
    reducedMotion: reducedMotion(),
    intensity: s.appearance.animationIntensity * (focus ? 0.45 : 1),
    idleFrequency: s.appearance.idleFrequency * (focus ? 0.2 : 1),
    sitAfter: s.appearance.sitAfterSeconds,
    napAfter: s.appearance.napAfterMinutes * 60,
  })
  engine.cursorFollow = s.appearance.cursorFollow
  director.configure({ laptopProp: s.appearance.laptopProp })
  sounds.enabled = s.sound.interactionSounds && !focus
  sounds.volume = s.sound.volume
  pointer.configure(s.appearance.cursorStyle, s.appearance.cursorTheme, reducedMotion())
  if (s.appearance.edgeGlow !== 'off') glow.setPalette(s.appearance.edgeGlow)
  glow.setReduced(reducedMotion())
  updateGlow()
  sizeCanvas()
  wake()
}

function sizeCanvas(): void {
  dpr = window.devicePixelRatio || 1
  if (settings) scale = snapScale(settings.companion.size)
  const cssW = CANVAS_U_W * scale
  const cssH = CANVAS_U_H * scale
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  canvas.style.width = `${canvas.width / dpr}px`
  canvas.style.height = `${canvas.height / dpr}px`
  lastSig = ''
}

function view(): RenderView {
  const cssW = canvas.width / dpr
  const cssH = canvas.height / dpr
  return { scale, dpr, originX: cssW / 2, originY: cssH - BELOW_GROUND_U * scale, snap: settings?.appearance.pixelSnap ?? 'device' }
}

/** Overlay position (CSS px) of an art-space point relative to the anchor. */
function toOverlay(xu: number, yu: number): { x: number; y: number } {
  return { x: anchor.x + xu * scale, y: anchor.y - yu * scale }
}

// ---------- local overrides (drag, high-five offer, walking) ----------

type Override = { name: StateName; params?: Record<string, number>; until?: number }
let override: Override | null = null

function setOverride(o: Override | null): void {
  override = o
  applyState()
}

function applyState(): void {
  if (override && state.visibility !== 'hidden') engine.setBase(override.name, override.params ?? {})
  else director.apply(state, onEdge)
}

// ---------- locomotion ----------

interface Move {
  kind: 'walk' | 'hop' | 'fall'
  from: { x: number; y: number }
  to: { x: number; y: number }
  t: number
  dur: number
}
let move: Move | null = null

function startMove(to: { x: number; y: number }, kind: Move['kind']): void {
  const from = { ...anchor }
  const dx = to.x - from.x
  if (kind === 'walk') {
    const speed = 7.5 * scale
    move = { kind, from, to, t: 0, dur: Math.max(0.3, Math.abs(dx) / speed) }
    setOverride({ name: 'walk', params: { dir: Math.sign(dx) || 1 } })
  } else if (kind === 'hop') {
    move = { kind, from, to, t: 0, dur: 0.85 }
    engine.play('hop', { h: 2.6 })
  } else {
    const dist = Math.max(0, to.y - from.y)
    move = { kind, from, to, t: 0, dur: Math.sqrt((2 * dist) / 2600) }
    if (move.dur < 0.05) {
      anchor = { ...to }
      move = null
    }
  }
  wake()
}

function stepMove(dt: number): void {
  const m = move
  if (!m) return
  m.t += dt
  const u = Math.min(1, m.t / m.dur)
  if (m.kind === 'walk') {
    const e = u < 0.1 ? (u / 0.1) * (u / 0.1) * 0.05 : u > 0.9 ? 1 - ((1 - u) / 0.1) * ((1 - u) / 0.1) * 0.05 : 0.05 + ((u - 0.1) / 0.8) * 0.9
    anchor = { x: m.from.x + (m.to.x - m.from.x) * e, y: m.from.y + (m.to.y - m.from.y) * e }
  } else if (m.kind === 'hop') {
    // Horizontal travel only while airborne (0.14..0.52 of the hop clip).
    const air = Math.min(1, Math.max(0, (m.t - 0.14) / 0.38))
    anchor = { x: m.from.x + (m.to.x - m.from.x) * air, y: m.from.y + (m.to.y - m.from.y) * air }
  } else {
    anchor = { x: m.to.x, y: m.from.y + (m.to.y - m.from.y) * u * u }
  }
  if (u >= 1) {
    anchor = { ...m.to }
    move = null
    if (m.kind === 'walk') setOverride(null)
    if (m.kind === 'fall') land()
  }
}

// ---------- rendering loop ----------

let raf = 0
let lastT = 0
let frames = 0
let frameMsSum = 0
let perfT = 0

/** The edge glow shows while Clawd's cursor is out, while he controls input, and while he listens. */
function updateGlow(): void {
  const a = settings?.appearance
  const want = !!a && a.edgeGlow !== 'off' && state.visibility !== 'hidden' && (pointer.active || controlling || (state.listening && a.glowWhileListening))
  glow.set(want)
}

function wake(): void {
  if (!raf) {
    lastT = performance.now()
    raf = requestAnimationFrame(loop)
  }
}

let pointerPos: { x: number; y: number } | null = null
let pointerMovedAt = -1e9
const drag = { down: false, dragging: false, sx: 0, sy: 0, ox: 0, oy: 0, vx: 0, vy: 0, lastX: 0, lastY: 0, lastT: 0, sentAt: 0, pointerId: -1 }
/** Released after a drag: still dangling until main says whether he falls or stays put. */
let awaitingLanding = 0

function land(): void {
  window.clearTimeout(awaitingLanding)
  awaitingLanding = 0
  if (override?.name === 'dragged') setOverride(null)
  engine.play('drop')
}

function loop(t: number): void {
  raf = 0
  const t0 = performance.now()
  const dt = Math.min(0.1, Math.max(0, (t - lastT) / 1000))
  lastT = t
  stepMove(dt)
  if (drag.dragging && t - drag.lastT > 40) {
    const k = Math.exp(-dt * 10)
    drag.vx *= k
    drag.vy *= k
  }
  if (override?.until && t / 1000 > override.until) setOverride(null)

  const look = pointerPos ? { x: (pointerPos.x - anchor.x) / scale, y: (anchor.y - pointerPos.y) / scale } : null
  const frame = engine.update({
    dt,
    look,
    lookActive: t - pointerMovedAt < 1500,
    level,
    dragVX: drag.dragging ? drag.vx / scale : 0,
    dragVY: drag.dragging ? drag.vy / scale : 0,
  })
  lastFrame = frame
  for (const ev of frame.events) if (ev.type === 'sound') sounds.play(ev.name)

  draw(frame)
  const pointing = pointer.update(t)
  updateGlow()
  if (state.listening) glow.setLevel(level)
  positionBubble()

  const hidden = frame.state === 'hidden' && !engine.fx.active && !move && !pointing
  frames++
  frameMsSum += performance.now() - t0
  if (t - perfT > 5000) {
    sendOverlay('overlay:perf', { fps: (frames * 1000) / (t - perfT), frameMs: frameMsSum / Math.max(1, frames) })
    perfT = t
    frames = 0
    frameMsSum = 0
  }
  if (!hidden) raf = requestAnimationFrame(loop)
  else canvas.style.visibility = 'hidden'
}

function draw(frame: EngineFrame): void {
  const v = view()
  const showShadow = settings?.appearance.shadow ?? true
  const rects = showShadow ? frame.geometry.rects : frame.geometry.rects.filter((r) => r.part !== 'shadow')
  const sig = rectSignature(rects, v) + '|' + rectSignature(frame.fx, v) + (frame.clipGround ? 'c' : '')
  // Position the canvas so the anchor lands on whole device pixels.
  const left = Math.round((anchor.x - v.originX) * dpr) / dpr
  const top = Math.round((anchor.y - v.originY) * dpr) / dpr
  canvas.style.transform = `translate(${left}px, ${top}px)`
  canvas.style.visibility = 'visible'
  updateHit(frame)
  if (sig === lastSig) return
  lastSig = sig
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (frame.clipGround && onEdge) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, canvas.width, Math.round(v.originY * dpr))
    ctx.clip()
    drawRects(ctx, rects, v)
    ctx.restore()
  } else drawRects(ctx, rects, v)
  drawRects(ctx, frame.fx, v)
}

function updateHit(frame: EngineFrame): void {
  const b = frame.geometry.bounds
  if (frame.state === 'hidden' || !Number.isFinite(b.x0) || frame.pose.alpha < 0.2) {
    hitRect = null
    return
  }
  const p0 = toOverlay(b.x0, b.y1)
  const p1 = toOverlay(b.x1, b.y0)
  const pad = 3
  hitRect = { x: p0.x - pad, y: p0.y - pad, w: p1.x - p0.x + pad * 2, h: p1.y - p0.y + pad * 2 }
}

// ---------- hit testing and interaction ----------

function overClawd(x: number, y: number): boolean {
  const r = hitRect
  return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

function overBubble(x: number, y: number): boolean {
  if (bubbleEl.hidden) return false
  const r = bubbleEl.getBoundingClientRect()
  return x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4
}

function setInteractive(on: boolean): void {
  if (settings?.companion.clickThrough === 'always') on = overBubble(pointerPos?.x ?? -1, pointerPos?.y ?? -1)
  if (on === interactive) return
  interactive = on
  sendOverlay('overlay:interactive', on)
}

let hoverSince = 0
/** The high-five was offered during this hover already (no dipping and re-raising). */
let offeredThisHover = false
let fade = 1
function onHover(x: number, y: number, speed: number): void {
  const over = overClawd(x, y)
  const avoid = settings?.companion.avoidCovering ?? 'fade'
  // A fast pass across him while working elsewhere: fade (or step aside) instead of grabbing the mouse.
  if (over && !drag.down && speed > 1400 && avoid !== 'off' && !interactive) {
    if (avoid === 'fade') setFade(0.25, 1600)
    else if (avoid === 'move' && !move) stepAside()
    return
  }
  if (fade < 1 && over) return
  setInteractive(drag.down || over || overBubble(x, y))
  if (over) {
    if (!hoverSince) {
      hoverSince = performance.now()
      engine.nudge()
    }
  } else {
    hoverSince = 0
    offeredThisHover = false
  }
}

let fadeTimer = 0
function setFade(v: number, ms: number): void {
  fade = v
  canvas.style.transition = 'opacity 160ms ease-out'
  canvas.style.opacity = String(v)
  window.clearTimeout(fadeTimer)
  fadeTimer = window.setTimeout(() => {
    fade = 1
    canvas.style.transition = 'opacity 420ms ease-in-out'
    canvas.style.opacity = '1'
  }, ms)
}

function stepAside(): void {
  const dir = anchor.x > W / 2 ? -1 : 1
  startMove({ x: anchor.x + dir * 16 * scale, y: anchor.y }, 'hop')
}

// High-five: resting the pointer on Clawd makes him raise a claw; clicking it completes the five.
setInterval(() => {
  if (!hoverSince || offeredThisHover || drag.down || override || state.visibility === 'hidden') return
  const base = engine.base
  if ((base === 'idle' || base === 'sit') && !engine.isOneShot && performance.now() - hoverSince > 750) {
    offeredThisHover = true
    setOverride({ name: 'offerFive', until: performance.now() / 1000 + 3.2 })
  }
}, 120)

function onHand(x: number, y: number): boolean {
  if (!lastFrame) return false
  const h = toOverlay(lastFrame.geometry.handR.x, lastFrame.geometry.handR.y)
  return Math.abs(x - h.x) < 3.2 * scale && y > h.y - 2 * scale && y < h.y + 4 * scale
}

let clickTimer = 0
let clicks: number[] = []

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !overClawd(e.clientX, e.clientY)) return
  canvas.setPointerCapture(e.pointerId)
  Object.assign(drag, { down: true, dragging: false, sx: e.clientX, sy: e.clientY, ox: e.clientX - anchor.x, oy: e.clientY - anchor.y, vx: 0, vy: 0, lastX: e.clientX, lastY: e.clientY, lastT: performance.now(), pointerId: e.pointerId })
  setInteractive(true)
})

let nativeMoveAt = -1e9
window.addEventListener('pointermove', (e) => {
  const now = performance.now()
  nativeMoveAt = now
  const speed = pointerPos ? Math.hypot(e.clientX - pointerPos.x, e.clientY - pointerPos.y) / Math.max(1, now - pointerMovedAt) * 1000 : 0
  pointerPos = { x: e.clientX, y: e.clientY }
  pointerMovedAt = now
  if (drag.down) {
    const dist = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy)
    if (!drag.dragging && dist > 5) {
      drag.dragging = true
      move = null
      setOverride({ name: 'dragged' })
      sendOverlay('overlay:drag', { phase: 'start', screenX: e.screenX, screenY: e.screenY })
    }
    if (drag.dragging) {
      const dtt = Math.max(1, now - drag.lastT) / 1000
      drag.vx = drag.vx * 0.7 + ((e.clientX - drag.lastX) / dtt) * 0.3
      drag.vy = drag.vy * 0.7 + ((e.clientY - drag.lastY) / dtt) * 0.3
      drag.lastX = e.clientX
      drag.lastY = e.clientY
      drag.lastT = now
      // Hold him by the middle of his body.
      anchor = { x: e.clientX - drag.ox, y: e.clientY - drag.oy }
      if (now - drag.sentAt > 50) {
        drag.sentAt = now
        sendOverlay('overlay:drag', { phase: 'move', screenX: e.screenX, screenY: e.screenY })
      }
      wake()
    }
    return
  }
  onHover(e.clientX, e.clientY, speed)
  wake()
})

/** Ends a press however it ends (release, cancel, lost capture, window blur): never leaves a drag stuck. */
function endDrag(e: { clientX: number; clientY: number; screenX: number; screenY: number } | null, click: boolean): void {
  if (!drag.down) return
  drag.down = false
  if (drag.dragging) {
    drag.dragging = false
    sendOverlay('overlay:drag', { phase: 'end', screenX: e?.screenX ?? 0, screenY: e?.screenY ?? 0 })
    // Main replies with an anchor: fall to the ground (land on arrival) or stay put (land now).
    window.clearTimeout(awaitingLanding)
    awaitingLanding = window.setTimeout(land, 700)
    return
  }
  if (click && e) {
    handleClick(e.clientX, e.clientY)
    onHover(e.clientX, e.clientY, 0)
  }
}
window.addEventListener('pointerup', (e) => endDrag(e, true))
window.addEventListener('pointercancel', (e) => endDrag(e, false))
canvas.addEventListener('lostpointercapture', (e) => endDrag(e, false))
window.addEventListener('blur', () => endDrag(null, false))

function handleClick(x: number, y: number): void {
  if (override?.name === 'offerFive' && onHand(x, y)) {
    setOverride(null)
    engine.play('highFive')
    sendOverlay('overlay:interaction', { kind: 'highFive' })
    return
  }
  const now = performance.now()
  clicks = clicks.filter((c) => now - c < 900)
  clicks.push(now)
  if (override?.name === 'offerFive') setOverride(null)
  // Three quick clicks make him dizzy (and are not a double-click).
  if (clicks.length >= 3) {
    window.clearTimeout(clickTimer)
    clickTimer = 0
    clicks = []
    engine.play('dizzy')
    sendOverlay('overlay:interaction', { kind: 'poke' })
    return
  }
  // Every click gets an instant reaction.
  engine.play('poke')
  sendOverlay('overlay:interaction', { kind: 'poke' })
  // Two quick clicks talk to Clawd, once it is clear no third one is coming (the summon itself
  // makes him perk up).
  if (clicks.length === 2 && now - clicks[0] < 380) {
    clickTimer = window.setTimeout(() => {
      clickTimer = 0
      clicks = []
      sendOverlay('overlay:interaction', { kind: 'doubleClick' })
    }, 240)
  }
}

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (overClawd(e.clientX, e.clientY)) sendOverlay('overlay:interaction', { kind: 'contextMenu' })
})

window.addEventListener('pointerleave', () => {
  if (!drag.down) {
    hoverSince = 0
    offeredThisHover = false
    setInteractive(false)
  }
})

// ---------- speech bubble ----------

let bubble: Bubble | null = null
let bubbleTimer = 0

function showBubble(b: Bubble | null): void {
  window.clearTimeout(bubbleTimer)
  bubble = b
  if (!b) {
    bubbleEl.classList.remove('show')
    window.setTimeout(() => {
      if (!bubble) bubbleEl.hidden = true
    }, 180)
    return
  }
  bubbleEl.hidden = false
  bubbleEl.className = `bubble ${b.tone ?? 'normal'}`
  bubbleEl.replaceChildren()
  const text = document.createElement('div')
  text.className = 'bubble-text'
  text.textContent = b.text
  bubbleEl.appendChild(text)
  if (b.actions?.length) {
    const row = document.createElement('div')
    row.className = 'bubble-actions'
    for (const a of b.actions) {
      const btn = document.createElement('button')
      btn.textContent = a.label
      if (a.primary) btn.className = 'primary'
      btn.addEventListener('click', () => {
        sendBubbleAction(b.id, a.id)
        showBubble(null)
      })
      row.appendChild(btn)
    }
    bubbleEl.appendChild(row)
  }
  requestAnimationFrame(() => bubbleEl.classList.add('show'))
  if (b.ttl) bubbleTimer = window.setTimeout(() => showBubble(null), b.ttl * 1000)
  positionBubble()
  wake()
}

function positionBubble(): void {
  if (bubbleEl.hidden || !lastFrame) return
  const head = toOverlay(lastFrame.geometry.head.x, lastFrame.geometry.head.y)
  const r = bubbleEl.getBoundingClientRect()
  let x = head.x - r.width / 2
  x = Math.max(8, Math.min(W - r.width - 8, x))
  const y = Math.max(8, head.y - r.height - 5 * scale)
  bubbleEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  bubbleEl.style.setProperty('--tail', `${Math.round(Math.max(14, Math.min(r.width - 14, head.x - x)))}px`)
}

// ---------- pointing ----------

function point(req: PointRequest | null): void {
  if (!req) {
    pointer.clear()
    return
  }
  const cx = req.box.x + req.box.w / 2
  const cy = req.box.y + req.box.h / 2
  const dir = cx >= anchor.x ? 1 : -1
  const up = Math.max(-1, Math.min(1, (anchor.y - 6 * scale - cy) / 400))
  const hold = req.hold ?? 4
  setOverride({ name: 'point', params: { dir, up }, until: performance.now() / 1000 + hold + 1.4 })
  window.setTimeout(() => {
    const hand = lastFrame ? toOverlay(dir > 0 ? lastFrame.geometry.handR.x : lastFrame.geometry.handL.x, dir > 0 ? lastFrame.geometry.handR.y : lastFrame.geometry.handL.y) : anchor
    pointer.point(hand, req.box, { hold, label: req.label, click: req.click })
    wake()
  }, 260)
}

// ---------- wiring ----------

onOverlay('overlay:init', (init: OverlayInit) => {
  W = init.width
  H = init.height
  onEdge = init.onScreenEdge
  reducedMotionOS = init.reducedMotion
  anchor = { ...init.anchor }
  applySettings(init.settings)
  applyState()
})

onOverlay('overlay:state', (s) => {
  const focusChanged = s.focus !== state.focus
  state = s
  if (focusChanged && settings) applySettings(settings)
  if (state.visibility === 'hidden') {
    override = null
    move = null
    showBubble(null)
  }
  updateGlow()
  applyState()
  wake()
})

onOverlay('overlay:pointer', (p) => {
  // While this window gets its own pointer events, they are the source of truth: mixing them with
  // main's 60 Hz poll (different timing) would make the pointer speed spike.
  if (performance.now() - nativeMoveAt < 150) return
  if (!p) {
    pointerPos = null
    return
  }
  if (!drag.down) pointerPos = { x: p.x, y: p.y }
  if (p.moving) pointerMovedAt = performance.now()
  if (state.visibility !== 'hidden') wake()
})

onOverlay('overlay:anchor', (a) => {
  if (a.animate === 'none') {
    anchor = { x: a.x, y: a.y }
    if (move?.kind === 'walk') setOverride(null)
    move = null
    if (awaitingLanding) land()
  } else {
    if (move?.kind === 'walk') setOverride(null)
    startMove({ x: a.x, y: a.y }, a.animate)
    // Falling: keep dangling until the landing.
    if (a.animate === 'fall' && awaitingLanding) {
      window.clearTimeout(awaitingLanding)
      awaitingLanding = -1
    }
  }
  wake()
})

onOverlay('overlay:play', ({ name, params }) => {
  engine.play(name as StateName, params ?? {})
  wake()
})

onOverlay('overlay:point', point)
onOverlay('overlay:bubble', showBubble)
onOverlay('overlay:level', (v) => {
  level = v
})
onOverlay('overlay:control', (on) => {
  controlling = on
  updateGlow()
  wake()
})
onOverlay('overlay:glance', ({ x, y, seconds }) => {
  engine.glance((x - anchor.x) / scale, (anchor.y - y) / scale, seconds)
  wake()
})

window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
  reducedMotionOS = e.matches
  if (settings) applySettings(settings)
})
window.addEventListener('resize', () => {
  W = window.innerWidth
  H = window.innerHeight
  if (Math.abs((window.devicePixelRatio || 1) - dpr) > 0.01) sizeCanvas()
})

// Test hook: lets the e2e harness read the animation state.
;(window as unknown as { __clawd: unknown }).__clawd = {
  engine,
  get state() {
    return state
  },
  get anchor() {
    return anchor
  },
  get hit() {
    return hitRect
  },
  get frame() {
    return lastFrame && { state: lastFrame.state, bounds: lastFrame.geometry.bounds, fx: lastFrame.fx.length }
  },
  get hand() {
    return lastFrame && toOverlay(lastFrame.geometry.handR.x, lastFrame.geometry.handR.y)
  },
  get override() {
    return override?.name ?? null
  },
  get hover() {
    return { since: hoverSince, offered: offeredThisHover, fade, interactive, base: engine.base, oneShot: engine.isOneShot }
  },
}

sizeCanvas()
sendOverlay('overlay:ready', null)
