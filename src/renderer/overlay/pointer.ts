// Clawd's own pointer. It glides like a cursor in a polished screen recording: a gentle curved
// path, smootherstep timing scaled to the distance, a slight tilt toward the direction of travel,
// a faint motion trail at speed, and a squish + ripple when it "clicks". Positions are sub-pixel
// (the sprite is supersampled), and it chains from one target to the next without disappearing.
// It is drawn on the overlay only; the real mouse is untouched unless the user approved a click.

import { CURSOR_SPRITE_FINE, CURSOR_THEMES, cursorRects, drawSmoothCursor, focusRingRects, type CursorThemeName } from '../../character/cursor'
import { drawRects } from '../../character/render'

type Pt = { x: number; y: number }
interface Job {
  p0: Pt
  p1: Pt
  p2: Pt
  p3: Pt
  box: { x: number; y: number; w: number; h: number }
  t0: number
  travel: number
  hold: number
  label?: string
  click: boolean
  rippled: boolean
  /** Chained from a moving pointer: ease out from its current speed instead of starting at rest. */
  chained: boolean
}

const CSS_SIZE = 44
const HOT = 8
const RING_MARGIN = 28
// Many faint, closely spaced ghosts read as a motion streak; a few far-apart ones read as extra cursors.
const TRAIL = [0.18, 0.14, 0.1, 0.07, 0.05, 0.03]
const TRAIL_STEP = 0.012

const smootherstep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const timing = (j: Job, u: number) => (j.chained ? easeOutCubic(u) : smootherstep(u))
const bezier = (j: Job, u: number): Pt => {
  const a = 1 - u
  return {
    x: a * a * a * j.p0.x + 3 * a * a * u * j.p1.x + 3 * a * u * u * j.p2.x + u * u * u * j.p3.x,
    y: a * a * a * j.p0.y + 3 * a * a * u * j.p1.y + 3 * a * u * u * j.p2.y + u * u * u * j.p3.y,
  }
}

export class PointerFx {
  private cursor = document.createElement('canvas')
  private ghosts: HTMLCanvasElement[] = []
  private ring = document.createElement('canvas')
  private ripple = document.createElement('div')
  private tag = document.createElement('div')
  private job: Job | null = null
  private style: 'smooth' | 'pixel' = 'smooth'
  private theme: CursorThemeName = 'ember'
  private dpr = window.devicePixelRatio || 1
  private ringT = -1
  private pos: Pt | null = null
  private lastT = 0
  private vel = { x: 0, y: 0 }
  private shown = false
  private reduced = false

  constructor(root: HTMLElement) {
    this.ring.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;opacity:0;will-change:transform,opacity'
    root.appendChild(this.ring)
    for (let i = 0; i < TRAIL.length; i++) {
      const g = document.createElement('canvas')
      g.className = 'cursor-ghost'
      g.style.opacity = '0'
      root.appendChild(g)
      this.ghosts.push(g)
    }
    this.cursor.className = 'cursor-ghost'
    this.cursor.style.opacity = '0'
    root.appendChild(this.cursor)
    this.ripple.className = 'ripple'
    root.appendChild(this.ripple)
    this.tag.className = 'point-tag'
    this.tag.style.opacity = '0'
    root.appendChild(this.tag)
    this.drawCursor()
  }

  configure(style: 'smooth' | 'pixel', theme: CursorThemeName, reduced = false): void {
    this.reduced = reduced
    if (style === this.style && theme === this.theme) return
    this.style = style
    this.theme = theme
    this.drawCursor()
  }

  private drawCursor(): void {
    this.dpr = window.devicePixelRatio || 1
    // Supersample the smooth cursor so sub-pixel motion and scaling stay crisp.
    const ss = this.style === 'smooth' ? 2 : 1
    for (const c of [this.cursor, ...this.ghosts]) {
      c.width = Math.round(CSS_SIZE * this.dpr * ss)
      c.height = Math.round(CSS_SIZE * this.dpr * ss)
      c.style.width = `${CSS_SIZE}px`
      c.style.height = `${CSS_SIZE}px`
      c.style.transformOrigin = `${HOT}px ${HOT}px`
      const ctx = c.getContext('2d')!
      ctx.clearRect(0, 0, c.width, c.height)
      const theme = CURSOR_THEMES[this.theme]
      if (this.style === 'smooth') {
        ctx.save()
        ctx.scale(this.dpr * ss, this.dpr * ss)
        drawSmoothCursor(ctx, HOT, HOT, 2.15, theme)
        ctx.restore()
      } else drawRects(ctx, cursorRects(CURSOR_SPRITE_FINE, theme), { scale: 1.6, dpr: this.dpr, originX: HOT, originY: HOT, snap: 'device' })
    }
  }

  /** True while the pointer is on screen (travelling, holding or fading). */
  get active(): boolean {
    return this.job !== null
  }

  point(from: Pt, box: Job['box'], opts: { hold?: number; label?: string; click?: boolean } = {}): void {
    const end = { x: box.x + Math.min(box.w * 0.62, box.w - 6), y: box.y + Math.min(box.h * 0.68, box.h - 4) }
    // Reduced motion: no flight, it simply fades in at the target.
    const start = this.reduced ? { ...end } : this.shown && this.pos ? { ...this.pos } : { ...from }
    const moving = !this.reduced && this.shown && Math.hypot(this.vel.x, this.vel.y) > 80
    const dx = end.x - start.x
    const dy = end.y - start.y
    const d = Math.hypot(dx, dy) || 1
    const dir = { x: dx / d, y: dy / d }
    // Bow the path gently upward, like a relaxed hand movement.
    let perp = { x: -dir.y, y: dir.x }
    if (perp.y > 0) perp = { x: -perp.x, y: -perp.y }
    const bow = Math.min(110, d * 0.16)
    const travel = this.reduced ? 0.2 : Math.min(1.15, Math.max(0.42, 0.36 + 0.2 * Math.log2(1 + d / 90)))
    // Retargeting mid-flight: the first control point continues the current velocity (an ease-out
    // cubic starts at 3x the average speed, hence travel / 9), so there is no stop-and-go.
    const p1 = moving
      ? { x: start.x + (this.vel.x * travel) / 9, y: start.y + (this.vel.y * travel) / 9 }
      : { x: start.x + dir.x * d * 0.3 + perp.x * bow, y: start.y + dir.y * d * 0.3 + perp.y * bow }
    const job: Job = {
      p0: start,
      p1,
      p2: { x: start.x + dir.x * d * 0.8 + perp.x * bow * 0.45, y: start.y + dir.y * d * 0.8 + perp.y * bow * 0.45 },
      p3: end,
      box,
      t0: performance.now() / 1000,
      travel,
      hold: opts.hold ?? 4,
      label: opts.label,
      click: !!opts.click,
      rippled: false,
      chained: moving,
    }
    this.job = job
    this.ringT = -1
    if (!this.shown) this.pos = { ...start }
    const r = this.ring
    r.width = Math.round((box.w + RING_MARGIN * 2) * this.dpr)
    r.height = Math.round((box.h + RING_MARGIN * 2) * this.dpr)
    r.style.width = `${box.w + RING_MARGIN * 2}px`
    r.style.height = `${box.h + RING_MARGIN * 2}px`
    // Whole device pixels, or the ring's pixel art blurs.
    const snap = (v: number) => Math.round(v * this.dpr) / this.dpr
    r.style.transform = `translate(${snap(box.x - RING_MARGIN)}px, ${snap(box.y - RING_MARGIN)}px)`
    r.style.opacity = '0'
    this.tag.textContent = opts.label ?? ''
    this.tag.style.opacity = '0'
  }

  /** Expected seconds until the pointer arrives (used to time a real click after the preview). */
  get arrivalIn(): number {
    const j = this.job
    return j ? Math.max(0, j.t0 + j.travel - performance.now() / 1000) : 0
  }

  clear(): void {
    if (!this.job) return
    const now = performance.now() / 1000
    this.job.hold = Math.max(0, now - this.job.t0 - this.job.travel - 0.3)
  }

  update(nowMs: number): boolean {
    const job = this.job
    if (!job) return false
    const now = nowMs / 1000
    const dt = Math.max(1 / 240, Math.min(0.05, now - (this.lastT || now)))
    this.lastT = now
    const t = now - job.t0
    const fadeStart = job.travel + 0.3 + job.hold
    const out = Math.min(1, Math.max(0, (t - fadeStart) / 0.38))
    if (out >= 1) {
      for (const c of [this.cursor, ...this.ghosts, this.ring, this.tag]) c.style.opacity = '0'
      this.job = null
      this.shown = false
      this.pos = null
      return false
    }
    const u = Math.min(1, Math.max(0, t / job.travel))
    const p = bezier(job, timing(job, u))
    // Smoothed velocity drives tilt, stretch and the trail.
    if (this.pos) {
      const k = 1 - Math.exp(-dt * 18)
      this.vel.x += ((p.x - this.pos.x) / dt - this.vel.x) * k
      this.vel.y += ((p.y - this.pos.y) / dt - this.vel.y) * k
    }
    this.pos = p
    this.shown = true
    const speed = Math.hypot(this.vel.x, this.vel.y)
    const calm = this.reduced ? 0 : 1
    const tilt = Math.max(-1, Math.min(1, this.vel.x / 2600)) * 11 * calm
    let scale = 1 + Math.min(0.07, speed / 42000) * calm
    // Arrival: a press (squish) for clicks, a softer tap otherwise, and a ripple.
    const at = t - job.travel
    if (at > 0 && at < 0.26) scale *= 1 - (job.click ? 0.2 : 0.1) * Math.sin((at / 0.26) * Math.PI) * calm
    if (at > 0.04 && !job.rippled) {
      job.rippled = true
      if (job.click) {
        this.ripple.style.left = `${p.x}px`
        this.ripple.style.top = `${p.y}px`
        this.ripple.classList.remove('go')
        void this.ripple.offsetWidth
        this.ripple.classList.add('go')
      }
    }
    const bob = at > 0.3 ? Math.sin((at - 0.3) * 3.1) * 1.2 * calm : 0
    const appear = Math.min(1, t / 0.14)
    const alpha = appear * (1 - out)
    const fadeScale = 1 - 0.12 * out
    const place = (x: number, y: number) => (this.style === 'pixel' ? [Math.round(x * this.dpr) / this.dpr, Math.round(y * this.dpr) / this.dpr] : [x, y])
    const [cx, cy] = place(p.x - HOT, p.y - HOT + bob)
    this.cursor.style.transform = `translate3d(${cx}px, ${cy}px, 0) rotate(${tilt}deg) scale(${scale * fadeScale})`
    this.cursor.style.opacity = String(alpha)
    // Motion trail: earlier points of the same path, only while moving fast.
    const trail = u < 1 && !this.reduced ? Math.min(1, speed / 1600) : 0
    this.ghosts.forEach((g, i) => {
      if (trail < 0.05) {
        g.style.opacity = '0'
        return
      }
      const gu = Math.max(0, u - (i + 1) * TRAIL_STEP)
      const gp = bezier(job, timing(job, gu))
      const [gx, gy] = place(gp.x - HOT, gp.y - HOT)
      g.style.transform = `translate3d(${gx}px, ${gy}px, 0) rotate(${tilt}deg) scale(${scale})`
      g.style.opacity = String(TRAIL[i] * trail * alpha)
    })
    // Focus ring closes in after arrival.
    const rt = Math.min(1, Math.max(0, (t - job.travel + 0.05) / 0.42))
    if (rt > 0 && Math.abs(rt - this.ringT) > 0.004) {
      this.ringT = rt
      const ctx = this.ring.getContext('2d')!
      ctx.clearRect(0, 0, this.ring.width, this.ring.height)
      drawRects(ctx, focusRingRects({ x: RING_MARGIN, y: RING_MARGIN, w: job.box.w, h: job.box.h }, rt, 2), { scale: 1, dpr: this.dpr, originX: 0, originY: 0, snap: 'device' })
    }
    this.ring.style.opacity = rt > 0 ? String(1 - out) : '0'
    if (job.label) {
      this.tag.style.transform = `translate(${Math.round(job.box.x)}px, ${Math.round(job.box.y + job.box.h + 14)}px)`
      this.tag.style.opacity = String(Math.min(1, Math.max(0, (t - job.travel - 0.2) / 0.25)) * (1 - out))
    }
    return true
  }
}
