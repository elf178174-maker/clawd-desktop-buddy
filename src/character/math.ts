// Small numeric helpers shared by the animation engine. Everything here is frame-rate independent.

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : clamp((v - a) / (b - a), 0, 1))
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = invLerp(a, b, v)
  return t * t * (3 - 2 * t)
}

export const ease = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuint: (t: number) => 1 - Math.pow(1 - t, 5),
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t: number, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  outElastic: (t: number) =>
    t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
}

/** Value of a keyframed 1D curve at time t. Keys are [time, value, easing-into-this-key]. */
export type Key = [number, number, ((t: number) => number)?]
export function curve(keys: Key[], t: number): number {
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, e] = keys[i]
    if (t <= t1) {
      const [t0, v0] = keys[i - 1]
      const u = (t - t0) / (t1 - t0 || 1)
      return lerp(v0, v1, (e ?? ease.inOutSine)(u))
    }
  }
  return keys[keys.length - 1][1]
}

/**
 * Damped spring integrated with fixed sub-steps so the result does not depend on the frame rate.
 * omega is the natural frequency in rad/s, zeta the damping ratio (1 = critical).
 */
export class Spring {
  value: number
  velocity = 0
  constructor(
    value: number,
    public omega = 18,
    public zeta = 1,
  ) {
    this.value = value
  }
  step(target: number, dt: number): number {
    const h = 1 / 480
    let remaining = Math.min(dt, 0.25)
    while (remaining > 1e-6) {
      const s = Math.min(h, remaining)
      const accel = this.omega * this.omega * (target - this.value) - 2 * this.zeta * this.omega * this.velocity
      this.velocity += accel * s
      this.value += this.velocity * s
      remaining -= s
    }
    return this.value
  }
  snap(v: number): void {
    this.value = v
    this.velocity = 0
  }
  impulse(dv: number): void {
    this.velocity += dv
  }
  get settled(): boolean {
    return Math.abs(this.velocity) < 1e-3
  }
}

/** Deterministic PRNG (mulberry32) so idle variation is reproducible in tests. */
export class Rng {
  private s: number
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next()
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1))
  }
  chance(p: number): boolean {
    return this.next() < p
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]
  }
  sign(): number {
    return this.next() < 0.5 ? -1 : 1
  }
}

/** Smooth 1D value noise in [-1, 1]; used for restrained, organic drift. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x)
  const f = x - i
  const h = (n: number) => {
    const s = Math.sin((n + seed * 101.3) * 127.1) * 43758.5453
    return (s - Math.floor(s)) * 2 - 1
  }
  const u = f * f * (3 - 2 * f)
  return lerp(h(i), h(i + 1), u)
}
