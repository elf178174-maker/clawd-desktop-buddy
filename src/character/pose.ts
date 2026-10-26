// A Pose is the full set of animatable channels of the rig. All lengths are art units.

export interface ArmPose {
  /** Vertical offset of the nub along the body side (+ up). */
  lift: number
  /** Extra length beyond the two-unit nub (negative tucks it in). */
  reach: number
  /** 0 = sideways nub, 1 = raised straight up beside the head. */
  raise: number
  /** Horizontal offset applied while raised, used for waving. */
  sway: number
  /** 0..1 lowers the nub to laptop height and brings it inward for typing. */
  type: number
}

export interface Pose {
  /** Root offset from the anchor point (+y up). */
  x: number
  y: number
  /** Squash and stretch about the feet. */
  sx: number
  sy: number
  /** Pixel-art lean: rows shift sideways in proportion to their height (+ leans right). */
  lean: number
  /** Turn toward screen-left (-1) or screen-right (+1). */
  yaw: number
  /** Body offset relative to the legs (+ up). */
  bodyY: number
  /** 0..1 compresses the legs (anticipation, landing). */
  crouch: number
  /** 0..1 folds the legs under the body (sitting). */
  tuck: number
  /** Per-leg lift (+ shortens the leg from the ground up). */
  legs: [number, number, number, number]
  /** Legs splay outward (0..1). */
  spread: number

  eyeX: number
  eyeY: number
  /** 0 closed .. 1 open. */
  eyeOpen: number
  eyeW: number
  eyeH: number
  /** 0..1 asymmetry: shrinks the left eye (confusion). */
  eyeSkew: number
  /** 0..1 morphs the eyes into ^ ^ arcs. */
  happy: number
  /** 0..1 morphs the eyes into > < (squeezed shut). */
  squeeze: number

  armL: ArmPose
  armR: ArmPose

  /** 0..1 shows the tiny laptop prop (coding companion). */
  laptop: number
  /** 0..1 visibility. */
  alpha: number
  /** Ground shadow strength 0..1. */
  shadow: number
}

export const neutralArm = (): ArmPose => ({ lift: 0, reach: 0, raise: 0, sway: 0, type: 0 })

export function neutralPose(): Pose {
  return {
    x: 0,
    y: 0,
    sx: 1,
    sy: 1,
    lean: 0,
    yaw: 0,
    bodyY: 0,
    crouch: 0,
    tuck: 0,
    legs: [0, 0, 0, 0],
    spread: 0,
    eyeX: 0,
    eyeY: 0,
    eyeOpen: 1,
    eyeW: 1,
    eyeH: 1,
    eyeSkew: 0,
    happy: 0,
    squeeze: 0,
    armL: neutralArm(),
    armR: neutralArm(),
    laptop: 0,
    alpha: 1,
    shadow: 1,
  }
}

export function clonePose(p: Pose): Pose {
  return { ...p, legs: [...p.legs] as Pose['legs'], armL: { ...p.armL }, armR: { ...p.armR } }
}

const SCALAR_KEYS = [
  'x', 'y', 'sx', 'sy', 'lean', 'yaw', 'bodyY', 'crouch', 'tuck', 'spread',
  'eyeX', 'eyeY', 'eyeOpen', 'eyeW', 'eyeH', 'eyeSkew', 'happy', 'squeeze', 'laptop', 'alpha', 'shadow',
] as const satisfies readonly (keyof Pose)[]
const ARM_KEYS = ['lift', 'reach', 'raise', 'sway', 'type'] as const satisfies readonly (keyof ArmPose)[]

export type ScalarChannel = (typeof SCALAR_KEYS)[number]
export const SCALAR_CHANNELS: readonly ScalarChannel[] = SCALAR_KEYS
export const ARM_CHANNELS: readonly (keyof ArmPose)[] = ARM_KEYS

/** out = a + (b - a) * t, channel by channel. `out` may alias `a`. */
export function blendPose(a: Pose, b: Pose, t: number, out: Pose = neutralPose()): Pose {
  for (const k of SCALAR_KEYS) out[k] = a[k] + (b[k] - a[k]) * t
  for (let i = 0; i < 4; i++) out.legs[i] = a.legs[i] + (b.legs[i] - a.legs[i]) * t
  for (const k of ARM_KEYS) {
    out.armL[k] = a.armL[k] + (b.armL[k] - a.armL[k]) * t
    out.armR[k] = a.armR[k] + (b.armR[k] - a.armR[k]) * t
  }
  return out
}

/** True when every channel is finite; guards the renderer against NaN poisoning. */
export function poseIsFinite(p: Pose): boolean {
  for (const k of SCALAR_KEYS) if (!Number.isFinite(p[k])) return false
  for (const v of p.legs) if (!Number.isFinite(v)) return false
  for (const k of ARM_KEYS) if (!Number.isFinite(p.armL[k]) || !Number.isFinite(p.armR[k])) return false
  return true
}
