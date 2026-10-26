// Clawd's animation states. Each state is a pure function of time-in-state that writes a target pose;
// the engine blends between states and layers breathing, gaze, blinking and secondary motion on top.

import type { FxKind } from './fx'
import { clamp, curve, ease, lerp, noise1, Rng, smoothstep } from './math'
import { type Pose } from './pose'

export type StateName =
  | 'hidden'
  | 'enter'
  | 'leave'
  | 'idle'
  | 'sit'
  | 'sleep'
  | 'wake'
  | 'walk'
  | 'hop'
  | 'listen'
  | 'think'
  | 'work'
  | 'speak'
  | 'interrupt'
  | 'celebrate'
  | 'error'
  | 'confused'
  | 'curious'
  | 'permission'
  | 'type'
  | 'waitCC'
  | 'attention'
  | 'offerFive'
  | 'highFive'
  | 'dragged'
  | 'drop'
  | 'poke'
  | 'dizzy'
  | 'wave'
  | 'point'

export interface StateCtx {
  /** Seconds since the state was entered. */
  t: number
  /** Per-entry random source, so every entry varies a little. */
  rng: Rng
  /** Per-entry seed in [0, 1) for noise. */
  seed: number
  params: Readonly<Record<string, number>>
  /** 0..1 amplitude scale (animation intensity x reduced motion). */
  m: number
  reduced: boolean
  /** Microphone or speech level 0..1. */
  level: number
  /** Drag velocity in art units/s (dragged state). */
  dragVX: number
  dragVY: number
}

export interface StateDef {
  /** One-shots return to the base state when `duration` elapses. */
  oneShot: boolean
  duration?: number
  /** Blend-in time in seconds. */
  blendIn: number
  /** 'free' lets the gaze controller drive the eyes; 'locked' uses the state's own eye targets. */
  gaze: 'free' | 'locked'
  blink: boolean
  /** Breathing amplitude multiplier. */
  breathe: number
  /** Whether idle micro-behaviours may play. */
  idle: boolean
  /** Effects held while the state is active. */
  fx?: FxKind[]
  /** Parts below the ground line are clipped (emerging from or sinking behind the screen edge). */
  clipGround?: boolean
  pose(c: StateCtx, p: Pose): void
}

/** Parabolic hop: returns height for local time u in [0,1]. */
const arc = (u: number, h: number) => 4 * h * u * (1 - u)

/** Squash-and-settle after a landing at time tl, as a damped oscillation of sy. */
function landing(t: number, tl: number, depth: number, m: number): { sy: number; sx: number; crouch: number } {
  const d = t - tl
  if (d < 0) return { sy: 1, sx: 1, crouch: 0 }
  const k = Math.exp(-d * 9) * Math.cos(d * 22)
  const sy = 1 - depth * k * m
  return { sy, sx: 1 + (1 - sy) * 0.75, crouch: clamp(k, 0, 1) * 0.6 * m }
}

/** A single hop between t0 and t1 with anticipation and landing. Writes y, sx, sy, crouch. */
function hop(p: Pose, t: number, t0: number, t1: number, h: number, m: number, antic = 0.12): void {
  if (t < t0 - antic) return
  if (t < t0) {
    const a = ease.outQuad((t - (t0 - antic)) / antic)
    p.crouch = Math.max(p.crouch, 0.65 * a * m)
    p.sy *= 1 - 0.12 * a * m
    p.sx *= 1 + 0.08 * a * m
    return
  }
  if (t < t1) {
    const u = (t - t0) / (t1 - t0)
    p.y += arc(u, h * m)
    // Stretch on take-off and just before touch-down, round at the apex.
    const st = Math.max(1 - u / 0.3, 0) * 0.14 + Math.max((u - 0.75) / 0.25, 0) * 0.06
    p.sy *= 1 + st * m
    p.sx *= 1 - st * 0.6 * m
    p.legs = p.legs.map((l) => l + Math.sin(u * Math.PI) * 0.25) as Pose['legs']
    return
  }
  const l = landing(t, t1, 0.16, m)
  p.sy *= l.sy
  p.sx *= l.sx
  p.crouch = Math.max(p.crouch, l.crouch)
}

const loop = (blendIn = 0.25): Pick<StateDef, 'oneShot' | 'blendIn'> => ({ oneShot: false, blendIn })

export const STATES: Record<StateName, StateDef> = {
  hidden: {
    ...loop(0.2),
    gaze: 'locked',
    blink: false,
    breathe: 0,
    idle: false,
    clipGround: true,
    pose(_c, p) {
      p.y = -11
      p.shadow = 0
      p.alpha = 0
    },
  },

  // Rises from behind the screen edge: eyes peek, a quick look around, then a hop up and a landing.
  enter: {
    oneShot: true,
    duration: 1.55,
    blendIn: 0,
    gaze: 'locked',
    blink: false,
    breathe: 0,
    idle: false,
    clipGround: true,
    pose(c, p) {
      const { t, m } = c
      if (c.params.edge === 0 || c.reduced) {
        // Not standing on a screen edge (or reduced motion): fade and pop in place.
        const u = clamp(t / 0.45, 0, 1)
        p.alpha = ease.outCubic(u)
        const s = c.reduced ? 1 : lerp(0.6, 1, ease.outBack(u, 2.4))
        p.sx = s
        p.sy = s
        p.shadow = u
        return
      }
      p.y = curve(
        [
          [0, -10.5],
          [0.32, -4.9, ease.outCubic],
          [0.62, -4.9],
          [0.74, -5.5, ease.inOutQuad],
        ],
        t,
      )
      p.eyeX = curve([[0.34, 0], [0.42, -0.7, ease.outCubic], [0.52, -0.7], [0.58, 0.6, ease.outCubic], [0.66, 0.6], [0.74, 0, ease.outCubic]], t)
      p.eyeY = curve([[0.3, 0.3], [0.7, 0.3], [0.8, 0]], t)
      p.eyeH = curve([[0.62, 1], [0.7, 1.18], [1.1, 1.05], [1.5, 1]], t)
      if (t > 0.62 && t < 0.74) {
        const a = (t - 0.62) / 0.12
        p.sy = 1 - 0.1 * a * m
        p.sx = 1 + 0.07 * a * m
      }
      if (t >= 0.74) {
        // Hop from y=-5.5 up past the edge and down to the ground at t=1.1.
        const t0 = 0.74
        const t1 = 1.1
        if (t < t1) {
          const u = (t - t0) / (t1 - t0)
          p.y = lerp(-5.5, 0, u) + arc(u, 3.4 * m)
          const st = Math.max(1 - u / 0.35, 0) * 0.16
          p.sy = 1 + st * m
          p.sx = 1 - st * 0.6 * m
          p.armL.lift = p.armR.lift = Math.sin(u * Math.PI) * 0.5
        } else {
          p.y = 0
          const l = landing(t, t1, 0.18, m)
          p.sy = l.sy
          p.sx = l.sx
          p.crouch = l.crouch
        }
      }
      p.shadow = smoothstep(0.85, 1.1, t)
    },
  },

  // Hops up and sinks behind the screen edge (or fades out when not on an edge).
  leave: {
    oneShot: true,
    duration: 0.95,
    blendIn: 0.12,
    gaze: 'locked',
    blink: false,
    breathe: 0,
    idle: false,
    clipGround: true,
    pose(c, p) {
      const { t, m } = c
      if (c.params.edge === 0 || c.reduced) {
        const u = clamp(t / 0.4, 0, 1)
        p.alpha = 1 - ease.inCubic(u)
        const s = c.reduced ? 1 : lerp(1, 0.7, ease.inCubic(u))
        p.sx = s
        p.sy = s
        p.shadow = 1 - u
        return
      }
      p.happy = curve([[0, 0], [0.12, 0.85], [0.6, 0.85], [0.7, 0]], t)
      if (t < 0.16) {
        const a = ease.outQuad(t / 0.16)
        p.crouch = 0.6 * a * m
        p.sy = 1 - 0.1 * a * m
        p.sx = 1 + 0.07 * a * m
      } else {
        const u = (t - 0.16) / 0.79
        // Up 1.6 units, then accelerate down past the edge.
        p.y = u < 0.3 ? 1.6 * m * ease.outQuad(u / 0.3) : 1.6 * m - 12.6 * Math.pow((u - 0.3) / 0.7, 2)
        p.sy = 1 + 0.12 * m * (1 - Math.abs(u - 0.4))
        p.sx = 1 - 0.06 * m
        p.armL.raise = p.armR.raise = clamp(u * 2.5, 0, 0.7)
      }
      p.shadow = 1 - smoothstep(0.2, 0.6, t)
    },
  },

  idle: {
    ...loop(0.3),
    gaze: 'free',
    blink: true,
    breathe: 1,
    idle: true,
    pose(c, p) {
      const drift = noise1(c.t * 0.18, c.seed * 10)
      p.armL.lift = 0.06 * Math.sin(c.t * 1.7 - 0.6) * c.m
      p.armR.lift = 0.06 * Math.sin(c.t * 1.7 - 0.4) * c.m
      p.lean = drift * 0.06 * c.m
    },
  },

  sit: {
    ...loop(0.55),
    gaze: 'free',
    blink: true,
    breathe: 0.9,
    idle: true,
    pose(c, p) {
      p.tuck = 1
      p.spread = 0.5
      p.bodyY = -0.1
      p.armL.lift = -0.35 + 0.05 * Math.sin(c.t * 1.4)
      p.armR.lift = -0.35 + 0.05 * Math.sin(c.t * 1.4 + 0.3)
      p.eyeOpen = 0.94
      p.lean = noise1(c.t * 0.12, c.seed * 7) * 0.08 * c.m
    },
  },

  sleep: {
    ...loop(0.9),
    gaze: 'locked',
    blink: false,
    breathe: 1.9,
    idle: false,
    fx: ['zzz'],
    pose(c, p) {
      p.tuck = 1
      p.spread = 0.55
      p.bodyY = -0.2
      p.eyeOpen = 0
      p.eyeY = -0.25
      p.armL.lift = -0.55
      p.armR.lift = -0.55
      // Slow head droop that occasionally rights itself.
      p.lean = (0.28 + noise1(c.t * 0.07, c.seed * 3) * 0.12) * c.m * (c.seed < 0.5 ? 1 : -1)
    },
  },

  wake: {
    oneShot: true,
    duration: 1.35,
    blendIn: 0.08,
    gaze: 'locked',
    blink: false,
    breathe: 0.5,
    idle: false,
    pose(c, p) {
      const { t, m } = c
      p.tuck = curve([[0, 1], [0.55, 1], [0.95, 0, ease.outCubic]], t)
      p.spread = p.tuck * 0.5
      p.eyeOpen = curve([[0, 0], [0.08, 1, ease.outCubic], [0.32, 1], [0.36, 0.1], [0.42, 1], [0.5, 1], [0.54, 0.1], [0.6, 1]], t)
      p.eyeH = curve([[0, 1], [0.1, 1.28], [0.5, 1.1], [1.2, 1]], t)
      const s = curve([[0.6, 0], [0.85, 1, ease.outCubic], [1.15, 1], [1.35, 0]], t)
      p.armL.raise = p.armR.raise = 0.75 * s
      p.sy = 1 + 0.07 * s * m
      p.sx = 1 - 0.035 * s * m
      p.happy = 0.7 * s
      if (t < 0.1) p.y = Math.sin((t / 0.1) * Math.PI) * 0.6 * m
    },
  },

  walk: {
    ...loop(0.18),
    gaze: 'locked',
    blink: true,
    breathe: 0.3,
    idle: false,
    pose(c, p) {
      const dir = c.params.dir ?? 1
      const freq = c.params.cadence ?? 2.7
      const ph = c.t * freq * Math.PI * 2
      const start = smoothstep(0, 0.2, c.t)
      const a = Math.max(0, Math.sin(ph)) * 0.7 * start
      const b = Math.max(0, -Math.sin(ph)) * 0.7 * start
      p.legs = [a, b, a, b]
      p.bodyY = (Math.abs(Math.cos(ph)) * 0.2 - 0.06) * start * c.m
      p.lean = dir * 0.38 * c.m
      p.yaw = dir * 0.55
      p.eyeX = dir * 0.55
      p.eyeY = 0.05
      p.armL.lift = 0.3 * Math.sin(ph) * start * c.m
      p.armR.lift = -0.3 * Math.sin(ph) * start * c.m
    },
  },

  hop: {
    oneShot: true,
    duration: 0.85,
    blendIn: 0.08,
    gaze: 'free',
    blink: false,
    breathe: 0,
    idle: false,
    pose(c, p) {
      hop(p, c.t, 0.14, 0.52, c.params.h ?? 2.2, c.m)
      p.armL.lift = p.armR.lift = c.t > 0.14 && c.t < 0.52 ? Math.sin(((c.t - 0.14) / 0.38) * Math.PI) * 0.6 : 0
    },
  },

  listen: {
    ...loop(0.2),
    gaze: 'locked',
    blink: true,
    breathe: 0.6,
    idle: false,
    fx: ['listen'],
    pose(c, p) {
      const lvl = c.level
      p.sy = 1 + (0.03 + 0.02 * lvl) * c.m
      p.sx = 1 - 0.012 * c.m
      p.eyeH = 1.12 + 0.06 * lvl
      p.eyeW = 1.05
      p.eyeY = 0.08
      p.eyeX = noise1(c.t * 0.5, c.seed * 13) * 0.12
      p.lean = Math.sin(c.t * 1.3) * 0.08 * c.m
      p.bodyY = 0.06 * lvl * c.m
      p.armL.lift = 0.15 + 0.1 * lvl
      p.armR.lift = 0.15 + 0.1 * lvl
    },
  },

  think: {
    ...loop(0.3),
    gaze: 'locked',
    blink: true,
    breathe: 0.7,
    idle: false,
    fx: ['think'],
    pose(c, p) {
      // Eyes drift between two upward fixations; the right nub rests under the "chin".
      const period = 2.8 + c.seed * 1.4
      const side = Math.floor(c.t / period) % 2 === 0 ? -1 : 1
      const u = (c.t % period) / period
      const k = smoothstep(0, 0.12, u)
      p.eyeX = lerp(-side * 0.5, side * 0.5, k)
      p.eyeY = 0.5
      p.eyeH = 0.95
      p.armR.lift = 1.05 + Math.max(0, Math.sin(c.t * 5)) * 0.12 * c.m
      p.armR.reach = -0.75
      p.lean = Math.sin(c.t * 0.9 + c.seed * 6) * 0.16 * c.m
    },
  },

  work: {
    ...loop(0.25),
    gaze: 'locked',
    blink: true,
    breathe: 0.5,
    idle: false,
    fx: ['spinner'],
    pose(c, p) {
      const ph = c.t * 8.5
      p.eyeH = 0.78
      p.eyeY = -0.25 + (Math.floor(c.t / 3.3 + c.seed) % 3 === 2 ? 0.3 : 0)
      p.eyeX = noise1(c.t * 0.6, c.seed * 5) * 0.35
      p.armL.lift = Math.max(0, Math.sin(ph)) * 0.65 * c.m
      p.armR.lift = Math.max(0, Math.sin(ph + Math.PI)) * 0.65 * c.m
      p.armL.reach = p.armR.reach = -0.3
      p.bodyY = Math.abs(Math.sin(ph / 2)) * 0.18 * c.m
    },
  },

  speak: {
    ...loop(0.2),
    gaze: 'locked',
    blink: true,
    breathe: 0.4,
    idle: false,
    fx: ['talk'],
    pose(c, p) {
      const lvl = c.level
      p.bodyY = 0.5 * lvl * c.m
      p.sy = 1 + 0.06 * lvl * c.m
      p.sx = 1 - 0.025 * lvl * c.m
      p.eyeH = 1.04 + 0.08 * lvl
      p.eyeY = 0.06
      p.eyeX = noise1(c.t * 0.35, c.seed * 9) * 0.15
      // Occasional emphasis gesture with alternating nubs.
      const g = (c.t + c.seed * 3) / 2.4
      const n = Math.floor(g)
      const u = g - n
      const env = u < 0.35 ? Math.sin((u / 0.35) * Math.PI) : 0
      const arm = n % 2 === 0 ? p.armR : p.armL
      arm.lift = 0.8 * env * c.m
      arm.reach = 0.35 * env
      p.lean = (n % 2 === 0 ? 1 : -1) * 0.08 * env * c.m
    },
  },

  interrupt: {
    oneShot: true,
    duration: 0.6,
    blendIn: 0.04,
    gaze: 'locked',
    blink: false,
    breathe: 0,
    idle: false,
    pose(c, p) {
      const { t, m } = c
      p.eyeH = curve([[0, 1], [0.06, 1.35], [0.4, 1.15], [0.6, 1.05]], t)
      p.eyeW = curve([[0, 1], [0.06, 1.15], [0.6, 1]], t)
      p.y = t < 0.22 ? Math.sin((t / 0.22) * Math.PI) * 0.55 * m : 0
      p.lean = curve([[0, 0], [0.08, -0.3], [0.6, 0]], t) * m
      p.sy = 1 + curve([[0, 0], [0.06, 0.08], [0.25, -0.05], [0.45, 0]], t) * m
      p.armL.lift = p.armR.lift = curve([[0, 0], [0.08, 0.6], [0.6, 0.1]], t)
    },
  },

  celebrate: {
    oneShot: true,
    duration: 1.95,
    blendIn: 0.08,
    gaze: 'locked',
    blink: false,
    breathe: 0,
    idle: false,
    pose(c, p) {
      const { t, m } = c
      hop(p, t, 0.14, 0.56, 2.6, m)
      hop(p, t, 0.76, 1.12, 1.5, m, 0.1)
      const up = curve([[0, 0], [0.14, 1, ease.outBack], [1.45, 1], [1.8, 0]], t)
      p.armL.raise = p.armR.raise = up
      p.armL.sway = -Math.sin(t * 13) * 0.25 * up * m
      p.armR.sway = Math.sin(t * 13) * 0.25 * up * m
      p.happy = curve([[0, 0], [0.12, 1], [1.6, 1], [1.9, 0]], t)
    },
  },

  error: {
    oneShot: true,
    duration: 2.1,
    blendIn: 0.05,
    gaze: 'locked',
    blink: false,
    breathe: 0.4,
    idle: false,
    pose(c, p) {
      const { t, m } = c
      p.squeeze = curve([[0, 0], [0.07, 1], [0.5, 1], [0.62, 0]], t)
      p.sy = 1 - curve([[0, 0], [0.07, 0.1], [0.4, 0.02], [1.0, 0.045], [1.6, 0]], t) * m
      p.sx = 1 + (1 - p.sy) * 0.6
      p.bodyY = -curve([[0, 0], [0.07, 0.2], [0.6, 0.05], [2, 0]], t) * m
      p.eyeY = -curve([[0.5, 0], [0.7, 0.35], [1.7, 0.35], [2.1, 0]], t)
      p.eyeH = 1 - curve([[0.5, 0], [0.7, 0.18], [1.7, 0.18], [2.1, 0]], t)
      p.armL.lift = p.armR.lift = -curve([[0.4, 0], [0.8, 0.5], [1.7, 0.5], [2.1, 0]], t)
      p.lean = Math.sin(t * 25) * Math.exp(-t * 7) * 0.25 * m
    },
  },

  confused: {
    oneShot: true,
    duration: 2.4,
    blendIn: 0.15,
    gaze: 'locked',
    blink: true,
    breathe: 0.5,
    idle: false,
    fx: ['question'],
    pose(c, p) {
      const { t, m } = c
      p.lean = curve([[0, 0], [0.3, 0.42], [1.0, 0.42], [1.3, -0.34], [2.0, -0.34], [2.4, 0]], t) * m
      p.eyeSkew = curve([[0, 0], [0.25, 1], [2.1, 1], [2.4, 0]], t)
      p.eyeX = curve([[0, 0], [0.3, 0.3], [1.0, 0.3], [1.3, -0.3], [2.0, -0.3], [2.4, 0]], t)
      p.eyeY = 0.2
      const scratch = curve([[0.2, 0], [0.45, 1], [1.8, 1], [2.2, 0]], t)
      p.armR.raise = 0.5 * scratch
      p.armR.sway = Math.sin(t * 16) * 0.12 * scratch * m
    },
  },

  curious: {
    oneShot: true,
    duration: 2.2,
    blendIn: 0.25,
    gaze: 'locked',
    blink: true,
    breathe: 0.5,
    idle: false,
    pose(c, p) {
      const dir = c.params.dir ?? 1
      const up = c.params.up ?? 0
      const k = curve([[0, 0], [0.4, 1, ease.outCubic], [1.8, 1], [2.2, 0]], c.t)
      p.lean = dir * 0.5 * k * c.m
      p.yaw = dir * 0.65 * k
      p.eyeX = dir * 0.75 * k
      p.eyeY = up * 0.45 * k
      p.eyeH = 1 + 0.14 * k
      p.bodyY = 0.25 * k * c.m
      p.sy = 1 + 0.03 * k * c.m
      const lift = c.seed < 0.5 ? 1 : 2
      p.legs[dir > 0 ? lift : 3 - lift] = 0.35 * k
    },
  },

  permission: {
    ...loop(0.2),
    gaze: 'locked',
    blink: true,
    breathe: 0.6,
    idle: false,
    fx: ['question'],
    pose(c, p) {
      const { t, m } = c
      p.armR.raise = ease.outBack(clamp(t / 0.35, 0, 1))
      p.armR.reach = 0.3
      p.armR.sway = Math.sin(t * 2.4) * 0.12 * m
      p.eyeH = 1.08
      p.eyeY = 0.1
      const b = (t % 2.6) / 2.6
      p.bodyY = (b < 0.12 ? Math.sin((b / 0.12) * Math.PI) * 0.3 : 0) * m
    },
  },

  type: {
    ...loop(0.3),
    gaze: 'locked',
    blink: true,
    breathe: 0.4,
    idle: false,
    pose(c, p) {
      const burst = c.params.burst ?? 1
      // Typing comes in bursts with short pauses so it never looks mechanical.
      const active = noise1(c.t * 0.7, c.seed * 17) > -0.35 ? 1 : 0.15
      const ph = c.t * 15
      p.laptop = 1
      p.armL.type = p.armR.type = 1
      p.armL.lift = Math.max(0, Math.sin(ph)) * 0.32 * active * burst * c.m
      p.armR.lift = Math.max(0, Math.sin(ph * 1.13 + 2)) * 0.32 * active * burst * c.m
      p.eyeY = -0.42
      p.eyeX = Math.sin(c.t * 0.9) * 0.25
      p.eyeH = 0.92
      p.bodyY = Math.abs(Math.sin(ph / 2)) * 0.03 * active * c.m
    },
  },

  waitCC: {
    ...loop(0.4),
    gaze: 'locked',
    blink: true,
    breathe: 0.8,
    idle: false,
    fx: ['think'],
    pose(c, p) {
      p.laptop = 1
      p.armL.type = p.armR.type = 0.85
      const glance = (c.t + c.seed * 4) % 6.5
      const k = glance > 5.4 ? Math.sin(((glance - 5.4) / 1.1) * Math.PI) : 0
      p.eyeY = lerp(-0.38, 0.05, k)
      p.eyeX = noise1(c.t * 0.25, c.seed) * 0.3
      // Idle foot tap behind the laptop.
      const tap = (c.t % 4.2) / 4.2
      p.legs[3] = tap < 0.25 ? Math.max(0, Math.sin(tap * 4 * Math.PI * 3)) * 0.3 * c.m : 0
    },
  },

  attention: {
    ...loop(0.15),
    gaze: 'locked',
    blink: true,
    breathe: 0.5,
    idle: false,
    fx: ['alert'],
    pose(c, p) {
      const { t, m } = c
      p.laptop = c.params.laptop ?? 1
      const wave = curve([[0, 0], [0.2, 1], [1.4, 1], [1.8, 0.45]], t)
      p.armL.raise = wave
      p.armR.raise = wave
      p.armL.sway = -Math.sin(t * 11) * 0.3 * clamp(1.8 - t, 0, 1) * m
      p.armR.sway = Math.sin(t * 11 + 0.8) * 0.3 * clamp(1.8 - t, 0, 1) * m
      p.bodyY = 0.5 * m
      p.eyeH = 1.15
      p.eyeY = 0.12
      const b = ((t - 1.8) % 3) / 3
      if (t > 1.8 && b < 0.1) p.y = Math.sin((b / 0.1) * Math.PI) * 0.6 * m
    },
  },

  offerFive: {
    ...loop(0.12),
    gaze: 'locked',
    blink: true,
    breathe: 0.5,
    idle: false,
    pose(c, p) {
      const { t, m } = c
      const r = ease.outBack(clamp(t / 0.3, 0, 1), 2)
      p.armR.raise = r
      p.armR.reach = 0.8 * r
      p.crouch = 0.15 * m
      p.eyeH = 1.1
      p.happy = 0.0
      p.eyeX = 0.35
      p.eyeY = 0.4
      p.bodyY = Math.sin(t * 4) * 0.05 * m
    },
  },

  highFive: {
    oneShot: true,
    duration: 1.45,
    blendIn: 0.03,
    gaze: 'locked',
    blink: false,
    breathe: 0,
    idle: false,
    pose(c, p) {
      const { t, m } = c
      p.armR.raise = curve([[0, 1], [1.05, 1], [1.4, 0]], t)
      p.armR.reach = curve([[0, 0.8], [0.05, 0.4], [0.3, 0.8], [1.05, 0.6], [1.4, 0]], t)
      p.armR.sway = curve([[0, 0], [0.04, -0.6, ease.outQuad], [0.25, 0.15], [0.4, 0]], t) * m
      p.sy = 1 - curve([[0, 0], [0.04, 0.1], [0.14, 0]], t) * m
      p.sx = 1 + (1 - p.sy) * 0.7
      p.lean = curve([[0, 0], [0.04, -0.3], [0.25, 0.1], [0.4, 0]], t) * m
      hop(p, t, 0.32, 0.7, 1.5, m, 0.08)
      p.happy = curve([[0, 0], [0.06, 1], [1.2, 1], [1.45, 0]], t)
      p.armL.raise = curve([[0.3, 0], [0.45, 0.6], [0.95, 0.6], [1.3, 0]], t)
    },
  },

  dragged: {
    ...loop(0.08),
    gaze: 'locked',
    blink: true,
    breathe: 0,
    idle: false,
    pose(c, p) {
      const { t, m } = c
      p.bodyY = 0.55
      p.sy = 1.05
      p.sx = 0.96
      p.spread = 0.35
      p.lean = clamp(-c.dragVX * 0.012, -0.7, 0.7) * m
      p.yaw = clamp(c.dragVX * 0.01, -0.5, 0.5)
      const variant = c.seed < 0.5
      p.squeeze = variant ? 0.75 : 0
      p.eyeH = variant ? 1 : 1.25
      p.armL.raise = p.armR.raise = 0.3
      p.armL.sway = Math.sin(t * 12) * 0.12 * m
      p.armR.sway = Math.sin(t * 12 + 1.7) * 0.12 * m
      p.legs = [0, 0, 0, 0].map((_, i) => Math.max(0, Math.sin(t * 10 + i * 1.6)) * 0.25 * m) as Pose['legs']
      p.shadow = 0.25
    },
  },

  drop: {
    oneShot: true,
    duration: 0.7,
    blendIn: 0.02,
    gaze: 'locked',
    blink: false,
    breathe: 0,
    idle: false,
    pose(c, p) {
      const l = landing(c.t, 0.02, 0.2, c.m)
      p.sy = l.sy
      p.sx = l.sx
      p.crouch = l.crouch
      p.eyeOpen = curve([[0, 1], [0.04, 0.15], [0.16, 0.15], [0.26, 1]], c.t)
      p.armL.lift = p.armR.lift = curve([[0, 0.4], [0.08, -0.4], [0.4, 0]], c.t)
    },
  },

  poke: {
    oneShot: true,
    duration: 0.62,
    blendIn: 0.02,
    gaze: 'locked',
    blink: false,
    breathe: 0,
    idle: false,
    pose(c, p) {
      const { t, m } = c
      const giggle = c.seed > 0.5
      p.sy = 1 - curve([[0, 0], [0.05, 0.13], [0.18, -0.04], [0.32, 0]], t) * m
      p.sx = 1 + (1 - p.sy) * 0.7
      if (giggle) {
        p.happy = curve([[0, 0], [0.05, 1], [0.45, 1], [0.62, 0]], t)
        p.lean = Math.sin(t * 30) * 0.18 * Math.exp(-t * 4) * m
      } else {
        p.squeeze = curve([[0, 0], [0.04, 1], [0.3, 1], [0.45, 0]], t)
      }
      p.y = t > 0.06 && t < 0.3 ? Math.sin(((t - 0.06) / 0.24) * Math.PI) * 0.45 * m : 0
      p.armL.lift = p.armR.lift = curve([[0, 0], [0.06, 0.45], [0.45, 0]], t)
    },
  },

  dizzy: {
    oneShot: true,
    duration: 2.3,
    blendIn: 0.05,
    gaze: 'locked',
    blink: false,
    breathe: 0,
    idle: false,
    fx: ['stars'],
    pose(c, p) {
      const { t, m } = c
      const wob = Math.exp(-t * 0.8)
      p.lean = Math.sin(t * 6) * 0.75 * wob * m
      p.x = Math.sin(t * 3) * 0.6 * wob * m
      p.eyeSkew = (Math.sin(t * 9) * 0.5 + 0.5) * wob
      p.eyeX = Math.sin(t * 9) * 0.4 * wob
      p.eyeY = Math.cos(t * 9) * 0.3 * wob
      // Shakes it off at the end.
      const shake = t > 1.7 ? Math.sin((t - 1.7) * 40) * 0.35 * Math.exp(-(t - 1.7) * 6) : 0
      p.yaw = shake
      p.squeeze = t > 1.7 && t < 2.0 ? 1 : 0
    },
  },

  wave: {
    oneShot: true,
    duration: 1.7,
    blendIn: 0.1,
    gaze: 'locked',
    blink: true,
    breathe: 0.3,
    idle: false,
    pose(c, p) {
      const { t, m } = c
      const up = curve([[0, 0], [0.22, 1, ease.outBack], [1.25, 1], [1.65, 0]], t)
      p.armR.raise = up
      p.armR.sway = Math.sin(t * 12) * 0.45 * up * m
      p.happy = curve([[0, 0], [0.15, 0.9], [1.3, 0.9], [1.6, 0]], t)
      p.bodyY = Math.abs(Math.sin(t * 6)) * 0.08 * up * m
      p.lean = -0.08 * up * m
    },
  },

  point: {
    ...loop(0.2),
    gaze: 'locked',
    blink: true,
    breathe: 0.4,
    idle: false,
    pose(c, p) {
      const dir = (c.params.dir ?? 1) >= 0 ? 1 : -1
      const up = clamp(c.params.up ?? 0, -1, 1)
      const k = ease.outBack(clamp(c.t / 0.3, 0, 1))
      const arm = dir > 0 ? p.armR : p.armL
      arm.reach = 1.7 * k
      arm.lift = up * 1.4 * k
      arm.raise = Math.max(0, up - 0.5) * 0.8 * k
      p.eyeX = dir * 0.7
      p.eyeY = up * 0.5
      p.yaw = dir * 0.3
      p.lean = dir * 0.15 * c.m
    },
  },
}
