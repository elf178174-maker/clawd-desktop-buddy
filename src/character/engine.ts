// The animation engine: a base state chosen by the app (idle, listening, typing...), one-shot
// reactions layered over it, cross-fades between them, and procedural layers for breathing,
// gaze, blinking, idle variation and follow-through. Pure TypeScript, no DOM, so it is unit-tested.

import { FxSystem, type FxKind } from './fx'
import { computeGeometry, type Geometry, type Rect } from './geometry'
import { clamp, ease, lerp, Rng, smoothstep, Spring } from './math'
import { blendPose, clonePose, neutralPose, poseIsFinite, type Pose } from './pose'
import { STATES, type StateCtx, type StateName } from './states'

export type { StateName } from './states'

export interface EngineOptions {
  seed?: number
  reducedMotion?: boolean
  /** 0..1 overall animation intensity. */
  intensity?: number
  /** Multiplier on how often idle micro-behaviours happen (0 disables them). */
  idleFrequency?: number
  /** Seconds of quiet before Clawd sits down, and before he naps. 0 disables. */
  sitAfter?: number
  napAfter?: number
}

export interface EngineInput {
  dt: number
  /** Look target (usually the pointer) relative to Clawd's anchor, art units, y up. */
  look?: { x: number; y: number } | null
  /** True while the pointer has moved recently. */
  lookActive?: boolean
  /** Microphone level (listening) or speech level (speaking), 0..1. */
  level?: number
  dragVX?: number
  dragVY?: number
}

export interface EngineEvent {
  type: 'sound' | 'oneShotDone' | 'state'
  name: string
}

export interface EngineFrame {
  pose: Pose
  geometry: Geometry
  /** Effect rectangles, drawn after the character. */
  fx: Rect[]
  clipGround: boolean
  state: StateName
  events: EngineEvent[]
}

type Params = Record<string, number>

interface Cue {
  t: number
  sound?: string
  fx?: FxKind
  /** Where the effect bursts, relative to the head. */
  at?: 'handR' | 'head'
}

const CUES: Partial<Record<StateName, Cue[]>> = {
  enter: [{ t: 0.74, sound: 'hop' }, { t: 1.1, sound: 'land' }],
  leave: [{ t: 0.16, sound: 'hop' }],
  hop: [{ t: 0.14, sound: 'hop' }, { t: 0.52, sound: 'land' }],
  celebrate: [{ t: 0.14, sound: 'hop' }, { t: 0.56, sound: 'land', fx: 'sparkles' }, { t: 0.76, sound: 'hop' }, { t: 1.12, sound: 'land' }],
  highFive: [{ t: 0, sound: 'slap', fx: 'slap', at: 'handR' }, { t: 0.32, sound: 'hop' }, { t: 0.7, sound: 'land', fx: 'sparkles' }],
  poke: [{ t: 0, sound: 'poke' }],
  drop: [{ t: 0, sound: 'land' }],
  error: [{ t: 0, sound: 'error' }, { t: 0.18, fx: 'sweat' }],
  attention: [{ t: 0, sound: 'alert' }],
  permission: [{ t: 0, sound: 'ask' }],
  wave: [{ t: 0.1, sound: 'hello' }],
  wake: [{ t: 0.05, sound: 'wake' }],
  interrupt: [{ t: 0, sound: 'interrupt' }],
}

/** Saccadic gaze: fixations jump quickly between targets instead of tracking continuously. */
class Gaze {
  private fx = 0
  private fy = 0
  readonly ex = new Spring(0, 36, 0.92)
  readonly ey = new Spring(0, 36, 0.92)
  readonly turn = new Spring(0, 4.5, 1)
  private lastSaccade = -1
  private offAxis = 0
  private wander: { x: number; y: number; until: number } | null = null
  interest = 0
  /** Magnitude of the last saccade, consumed by the blink controller. */
  saccade = 0

  setWander(x: number, y: number, until: number): void {
    this.wander = { x, y, until }
  }

  update(now: number, dt: number, look: { x: number; y: number } | null | undefined, active: boolean, follow: boolean): void {
    // Pointer interest rises quickly while it moves and fades after a few quiet seconds.
    this.interest = clamp(this.interest + (active && follow ? dt * 4 : -dt * 0.22), 0, 1)
    let dx = 0
    let dy = 0
    if (this.wander && now > this.wander.until) this.wander = null
    if (this.wander && this.interest < 0.5) {
      dx = this.wander.x
      dy = this.wander.y
    } else if (look && follow && this.interest > 0.05) {
      // Eye centre sits ~6.5 units above the anchor.
      const rx = look.x
      const ry = look.y - 6.5
      const k = smoothstep(0, 0.4, this.interest)
      dx = Math.tanh(rx / 24) * 0.95 * k
      dy = Math.tanh(ry / 18) * 0.85 * k
    }
    const err = Math.hypot(dx - this.fx, dy - this.fy)
    if (err > 0.09 && now - this.lastSaccade > 0.075) {
      this.saccade = err
      this.fx = dx
      this.fy = dy
      this.lastSaccade = now
    }
    this.ex.step(this.fx, dt)
    this.ey.step(this.fy, dt)
    // Turn the body toward targets that stay off to one side.
    this.offAxis = Math.abs(this.fx) > 0.55 ? this.offAxis + dt : 0
    const turnTarget = this.offAxis > 1.5 ? Math.sign(this.fx) * Math.min(0.25, Math.abs(this.fx) * 0.35) : 0
    this.turn.omega = turnTarget === 0 ? 2.2 : 4.5
    this.turn.step(turnTarget, dt)
  }
}

/** Blinks at irregular intervals, sometimes doubled, sometimes triggered by a big eye movement. */
class Blinker {
  private next: number
  private start = -10
  private double = false
  constructor(private rng: Rng) {
    this.next = rng.range(1.5, 4)
  }
  trigger(now: number): void {
    if (now - this.start > 0.35) {
      this.start = now
      this.double = this.rng.chance(0.15)
      this.next = now + this.rng.range(2.2, 6.2)
    }
  }
  value(now: number, rate = 1): number {
    if (now >= this.next) this.trigger(now)
    if (rate <= 0) return 1
    const shape = (d: number) => (d < 0 ? 1 : d < 0.055 ? 1 - d / 0.055 : d < 0.085 ? 0 : d < 0.175 ? (d - 0.085) / 0.09 : 1)
    const d = now - this.start
    let v = shape(d)
    if (this.double) v = Math.min(v, shape(d - 0.24))
    return v
  }
}

interface Micro {
  name: string
  t0: number
  dur: number
  dir: number
}

const MICRO_WEIGHTS: [string, number][] = [
  ['look', 3],
  ['shift', 2],
  ['glance', 1.2],
  ['tap', 1.4],
  ['sway', 1],
  ['turn', 1],
  ['stretch', 0.5],
  ['hop', 0.35],
]

export class ClawdEngine {
  private rng: Rng
  private opts: Required<EngineOptions>
  private now = 0
  private baseName: StateName = 'hidden'
  private baseParams: Params = {}
  private cur: StateName = 'hidden'
  private curParams: Params = {}
  private curT = 0
  private curSeed = 0
  private curRng: Rng
  private oneShot = false
  private from: Pose | null = null
  private blendT = 0
  private blendDur = 0
  private last: Pose = neutralPose()
  /** The last pose before the per-frame gaze, blink and lag layers: where cross-fades start. */
  private lastBase: Pose | null = null
  private gaze = new Gaze()
  private gazeW = new Spring(0, 10, 1)
  private blinker: Blinker
  private yaw = new Spring(0, 9, 0.95)
  private laptop = new Spring(0, 8, 1)
  private armLag = new Spring(0, 14, 0.45)
  private lastVY = 0
  private lastY = 0
  private rest = 0
  private micro: Micro | null = null
  private nextMicro = 4
  private recentMicros: string[] = []
  private cueIdx = 0
  private events: EngineEvent[] = []
  readonly fx = new FxSystem()
  cursorFollow = true

  constructor(opts: EngineOptions = {}) {
    this.opts = {
      seed: opts.seed ?? 1,
      reducedMotion: opts.reducedMotion ?? false,
      intensity: opts.intensity ?? 1,
      idleFrequency: opts.idleFrequency ?? 1,
      sitAfter: opts.sitAfter ?? 75,
      napAfter: opts.napAfter ?? 600,
    }
    this.rng = new Rng(this.opts.seed)
    this.curRng = new Rng(this.opts.seed + 1)
    this.blinker = new Blinker(new Rng(this.opts.seed + 2))
    this.last = this.evaluate('hidden', {}, 0, 0, this.curRng, 0, 0, 0)
  }

  configure(opts: EngineOptions): void {
    Object.assign(this.opts, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)))
  }

  get state(): StateName {
    return this.cur
  }
  get base(): StateName {
    return this.baseName
  }
  get isOneShot(): boolean {
    return this.oneShot
  }
  get time(): number {
    return this.now
  }
  get options(): Readonly<Required<EngineOptions>> {
    return this.opts
  }
  get restSeconds(): number {
    return this.rest
  }

  private get motion(): number {
    return clamp(this.opts.intensity, 0, 1) * (this.opts.reducedMotion ? 0.35 : 1)
  }

  /** The continuous state the app is in. Rest (sit, nap) is layered on top of 'idle' automatically. */
  setBase(name: StateName, params: Params = {}): void {
    const same = name === this.baseName && JSON.stringify(params) === JSON.stringify(this.baseParams)
    this.baseName = name
    this.baseParams = params
    if (same) return
    if (name !== 'idle') this.rest = 0
    if (!this.oneShot) this.transition(this.resolveBase(), name === this.baseName ? params : {}, false)
  }

  /** Plays a one-shot reaction; it returns to the base state on its own. */
  play(name: StateName, params: Params = {}): void {
    const def = STATES[name]
    if (!def.oneShot) {
      this.setBase(name, params)
      return
    }
    this.rest = 0
    this.transition(name, params, true)
  }

  /** User activity near Clawd: resets the rest timer and wakes him if he is napping. */
  nudge(): void {
    const wasResting = this.cur === 'sleep' || this.cur === 'sit'
    const sleeping = this.cur === 'sleep'
    this.rest = 0
    if (sleeping) this.play('wake')
    else if (wasResting && !this.oneShot && this.baseName === 'idle') this.transition('idle', {}, false)
  }

  /** Cancels a running one-shot and returns to the base state immediately (with a blend). */
  settle(): void {
    if (this.oneShot) this.transition(this.resolveBase(), this.baseParams, false)
  }

  /** Briefly looks at a point of interest (art units relative to the anchor). */
  glance(x: number, y: number, seconds = 1.6): void {
    this.gaze.setWander(Math.tanh(x / 24) * 0.95, Math.tanh((y - 6.5) / 18) * 0.85, this.now + seconds)
  }

  private resolveBase(): StateName {
    if (this.baseName !== 'idle') return this.baseName
    const { sitAfter, napAfter } = this.opts
    if (napAfter > 0 && this.rest >= napAfter) return 'sleep'
    if (sitAfter > 0 && this.rest >= sitAfter) return 'sit'
    return 'idle'
  }

  private transition(name: StateName, params: Params, oneShot: boolean): void {
    const prev = this.cur
    const def = STATES[name]
    // Blend from whatever is on screen right now, so interruptions never pop.
    // (Without the gaze, blink and lag layers, which are added on top again every frame.)
    this.from = clonePose(this.lastBase ?? this.last)
    this.blendT = 0
    this.blendDur = def.blendIn
    this.cur = name
    this.curParams = oneShot ? params : name === this.baseName ? this.baseParams : params
    this.curT = 0
    this.curSeed = this.rng.next()
    this.curRng = new Rng(Math.floor(this.curSeed * 2 ** 31))
    this.oneShot = oneShot
    this.cueIdx = 0
    this.micro = null
    // Effects follow the state: release what the new state does not hold.
    const keep = new Set(def.fx ?? [])
    for (const k of this.fx.kinds()) if (!keep.has(k)) this.fx.release(k, this.now)
    for (const k of keep) this.fx.hold(k, this.now)
    if (prev !== name) {
      this.events.push({ type: 'state', name })
      if (this.rng.chance(0.3) && def.blink) this.blinker.trigger(this.now)
    }
  }

  private evaluate(name: StateName, params: Params, t: number, seed: number, rng: Rng, level: number, dvx: number, dvy: number): Pose {
    const p = neutralPose()
    const ctx: StateCtx = { t, rng, seed, params, m: this.motion, reduced: this.opts.reducedMotion, level, dragVX: dvx, dragVY: dvy }
    STATES[name].pose(ctx, p)
    return p
  }

  private pickMicro(): Micro | null {
    const banned = new Set(this.recentMicros)
    if (this.cur === 'sit') for (const n of ['stretch', 'hop', 'shift', 'turn']) banned.add(n)
    const calm = this.opts.reducedMotion
    const pool = MICRO_WEIGHTS.filter(([n]) => !banned.has(n) && (!calm || n === 'look' || n === 'glance'))
    if (!pool.length) return null
    const total = pool.reduce((s, [, w]) => s + w, 0)
    let r = this.rng.next() * total
    let name = pool[0][0]
    for (const [n, w] of pool) {
      r -= w
      if (r <= 0) {
        name = n
        break
      }
    }
    // Pointer-driven looking wins over invented looks.
    if ((name === 'look' || name === 'turn') && this.gaze.interest > 0.5) name = 'glance'
    const dur = { look: [1.4, 2.6], shift: [2.2, 3.2], glance: [1.1, 1.7], tap: [1.3, 1.8], sway: [2.4, 3.4], turn: [2.4, 3.4], stretch: [2.0, 2.4], hop: [0.85, 0.85] }[name] ?? [1.5, 2]
    this.recentMicros.push(name)
    if (this.recentMicros.length > 2) this.recentMicros.shift()
    const m: Micro = { name, t0: this.now, dur: this.rng.range(dur[0], dur[1]), dir: this.rng.sign() }
    if (name === 'look') this.gaze.setWander(m.dir * this.rng.range(0.45, 0.9), this.rng.range(-0.3, 0.6), this.now + m.dur)
    if (name === 'glance') this.gaze.setWander(0, 0.05, this.now + m.dur)
    if (name === 'hop') this.events.push({ type: 'sound', name: 'hop' })
    return m
  }

  private applyMicro(p: Pose): void {
    const mc = this.micro
    if (!mc) return
    const t = this.now - mc.t0
    const u = t / mc.dur
    if (u >= 1) {
      this.micro = null
      return
    }
    const e = Math.min(smoothstep(0, 0.22, u), smoothstep(1, 0.75, u))
    const m = this.motion
    switch (mc.name) {
      case 'shift':
        p.lean += mc.dir * 0.3 * e * m
        p.bodyY -= 0.06 * e * m
        p.legs[mc.dir > 0 ? 0 : 3] += 0.12 * e * m
        break
      case 'glance':
        p.happy = Math.max(p.happy, 0.35 * smoothstep(0.15, 0.4, u) * smoothstep(1, 0.7, u))
        break
      case 'tap': {
        const leg = mc.dir > 0 ? 3 : 0
        p.legs[leg] += Math.max(0, Math.sin(t * 13)) * 0.38 * e * m
        p.eyeY -= 0.15 * e
        break
      }
      case 'sway':
        p.armL.lift += Math.sin(t * 3.2) * 0.22 * e * m
        p.armR.lift += Math.sin(t * 3.2 + Math.PI) * 0.22 * e * m
        p.lean += Math.sin(t * 1.6) * 0.1 * e * m
        break
      case 'turn': {
        const k = Math.sin(u * Math.PI * 2) * e
        p.yaw += mc.dir * 0.55 * k
        p.eyeX += mc.dir * 0.4 * k
        break
      }
      case 'stretch': {
        const s = Math.min(smoothstep(0.05, 0.35, u), smoothstep(0.95, 0.7, u))
        p.armL.raise += 0.85 * s
        p.armR.raise += 0.85 * s
        p.sy += 0.07 * s * m
        p.sx -= 0.035 * s * m
        p.eyeOpen *= 1 - 0.85 * s
        break
      }
      case 'hop': {
        const tt = t
        if (tt < 0.12) {
          const a = tt / 0.12
          p.crouch = Math.max(p.crouch, 0.5 * a * m)
          p.sy *= 1 - 0.1 * a * m
        } else if (tt < 0.45) {
          const v = (tt - 0.12) / 0.33
          p.y += 4 * 1.1 * m * v * (1 - v)
          p.sy *= 1 + 0.1 * Math.max(0, 1 - v / 0.3) * m
        } else {
          const d = tt - 0.45
          p.sy *= 1 - 0.12 * Math.exp(-d * 9) * Math.cos(d * 22) * m
        }
        break
      }
    }
  }

  update(input: EngineInput): EngineFrame {
    const dt = clamp(input.dt, 0, 0.1)
    this.now += dt
    this.curT += dt
    this.events = []
    const level = clamp(input.level ?? 0, 0, 1)

    // Rest progression while idle.
    if (this.baseName === 'idle' && !this.oneShot) {
      this.rest += dt
      const want = this.resolveBase()
      if (want !== this.cur) this.transition(want, {}, false)
    }

    // One-shot finished: return to the base state.
    const def = STATES[this.cur]
    if (this.oneShot && def.duration !== undefined && this.curT >= def.duration) {
      const done = this.cur
      this.transition(this.resolveBase(), this.baseParams, false)
      this.events.push({ type: 'oneShotDone', name: done })
    }

    const cdef = STATES[this.cur]
    // Cues (sounds and effect bursts) fire as state time crosses them.
    const cues = CUES[this.cur] ?? []
    while (this.cueIdx < cues.length && cues[this.cueIdx].t <= this.curT) {
      const cue = cues[this.cueIdx++]
      if (cue.sound) this.events.push({ type: 'sound', name: cue.sound })
      if (cue.fx) {
        const g = computeGeometry(this.last)
        const at = cue.at === 'handR' ? g.handR : g.head
        this.fx.burst(cue.fx, this.now, at.x - g.head.x, at.y - g.head.y)
      }
    }

    let p = this.evaluate(this.cur, this.curParams, this.curT, this.curSeed, this.curRng, level, input.dragVX ?? 0, input.dragVY ?? 0)

    // Idle micro-behaviours.
    if (cdef.idle && this.opts.idleFrequency > 0) {
      if (!this.micro && this.now >= this.nextMicro) {
        this.micro = this.pickMicro()
        const f = this.opts.idleFrequency
        this.nextMicro = this.now + (this.micro?.dur ?? 0) + this.rng.range(3.5, 9) / Math.max(0.15, f)
      }
      this.applyMicro(p)
    } else {
      this.micro = null
      if (this.nextMicro < this.now + 2) this.nextMicro = this.now + 2 + this.rng.range(0, 3)
    }

    // Breathing.
    if (cdef.breathe > 0) {
      const period = this.cur === 'sleep' ? 4.8 : 3.6
      const b = Math.sin((this.now / period) * Math.PI * 2)
      const a = cdef.breathe * this.motion
      p.bodyY += 0.14 * b * a
    }

    // Cross-fade from the pose that was on screen when the transition started.
    if (this.from && this.blendT < this.blendDur) {
      this.blendT += dt
      const w = ease.inOutCubic(clamp(this.blendT / this.blendDur, 0, 1))
      p = blendPose(this.from, p, w, p)
      if (this.blendT >= this.blendDur) this.from = null
    }
    this.lastBase = clonePose(p)

    // Gaze: free states hand the eyes to the gaze controller.
    this.gaze.update(this.now, dt, input.look, input.lookActive ?? false, this.cursorFollow)
    const gw = this.gazeW.step(cdef.gaze === 'free' ? 1 : 0, dt)
    p.eyeX = lerp(p.eyeX, p.eyeX + this.gaze.ex.value, gw)
    p.eyeY = lerp(p.eyeY, p.eyeY + this.gaze.ey.value, gw)
    p.yaw += this.yaw.step(this.gaze.turn.value * gw, dt)

    // Blinking (big saccades sometimes come with a blink).
    if (this.gaze.saccade > 0.55 && this.rng.chance(0.25)) this.blinker.trigger(this.now)
    this.gaze.saccade = 0
    if (cdef.blink) p.eyeOpen *= this.blinker.value(this.now)

    // Follow-through: the nubs lag behind fast vertical body motion.
    const yNow = p.y + p.bodyY
    const vy = dt > 0 ? (yNow - this.lastY) / dt : 0
    this.lastY = yNow
    this.lastVY = vy
    const lag = this.armLag.step(this.motion > 0 ? -clamp(vy * 0.035, -0.5, 0.5) : 0, dt)
    if (p.armL.raise < 0.5 && p.armL.type < 0.5) p.armL.lift += lag
    if (p.armR.raise < 0.5 && p.armR.type < 0.5) p.armR.lift += lag

    // The laptop slides in and out on its own spring.
    p.laptop = clamp(this.laptop.step(p.laptop, dt), 0, 1.2)

    if (!poseIsFinite(p)) p = neutralPose()
    this.last = p

    this.fx.update(this.now)
    const geometry = computeGeometry(p)
    const fxRects: Rect[] = []
    if (this.fx.active) this.fx.render(this.now, { head: geometry.head, level, motion: this.motion }, fxRects)
    return { pose: p, geometry, fx: fxRects, clipGround: !!cdef.clipGround, state: this.cur, events: this.events }
  }

  /** Last vertical velocity of the body (art units/s), exposed for tests. */
  get verticalVelocity(): number {
    return this.lastVY
  }
}
