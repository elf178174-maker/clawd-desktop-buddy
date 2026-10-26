// Turns a Pose into flat, axis-aligned rectangles: the whole character is drawn from these.
// Keeping every part rectangular is what keeps Clawd reading as pixel art while he moves smoothly.

import { ARM, BODY, EYE, LEG, LEG_X, PALETTE } from './anatomy'
import { clamp, ease, lerp } from './math'
import type { ArmPose, Pose } from './pose'

export type Part = 'shadow' | 'leg' | 'body' | 'eye' | 'arm' | 'laptop' | 'sticker'

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
  color: string
  part: Part
  /** Optional opacity multiplier (shadow, laptop fade). */
  alpha?: number
}

export interface Geometry {
  rects: Rect[]
  /** Centre of the top of the head, after all transforms (art units, y up). */
  head: { x: number; y: number }
  /** Tip of each arm; used to aim the high-five contact and Clawd's pointer. */
  handL: { x: number; y: number }
  handR: { x: number; y: number }
  /** Union of the solid parts (no shadow), for hit testing and layout. */
  bounds: { x0: number; y0: number; x1: number; y1: number }
}

const BODY_ROWS = 6

/** Rectangles for one eye given its centre, size and the expression morphs. */
function eyeRects(cx: number, cy: number, w: number, h: number, p: Pose, mirror: number, out: Rect[]): void {
  const happy = clamp(p.happy, 0, 1)
  const squeeze = clamp(p.squeeze, 0, 1)
  // Morph targets share a "closing" phase so the switch happens while the eye is shut.
  const morph = Math.max(happy, squeeze)
  if (morph < 0.5) {
    const open = clamp(p.eyeOpen, 0, 1) * (1 - morph * 2)
    const eh = Math.max(0.16, h * open)
    const ecy = cy - (h - eh) * 0.32
    out.push({ x0: cx - w / 2, y0: ecy - eh / 2, x1: cx + w / 2, y1: ecy + eh / 2, color: PALETTE.eye, part: 'eye' })
    return
  }
  const s = (morph - 0.5) * 2 // 0..1 growth of the symbol
  const b = (happy >= squeeze ? 0.55 : 0.5) * w // block size
  const k = lerp(0.35, 1, ease.outBack(s))
  const blocks: [number, number][] =
    happy >= squeeze
      ? // ^ : two low side blocks and one raised centre block
        [
          [-0.55, -0.2],
          [0, 0.26],
          [0.55, -0.2],
        ]
      : // > for the left eye, < for the right eye
        [
          [-0.27 * mirror, 0.46],
          [0.25 * mirror, 0],
          [-0.27 * mirror, -0.46],
        ]
  for (const [bx, by] of blocks) {
    const x = cx + bx * w * k
    const y = cy + by * h * k
    const half = (b * k) / 2
    out.push({ x0: x - half, y0: y - half, x1: x + half, y1: y + half, color: PALETTE.eye, part: 'eye' })
  }
}

/** Arm rectangle in body space (before lean/squash), for side = -1 (left) or +1 (right). */
function armRect(a: ArmPose, side: number, bodyHalf: number, bodyBottom: number, yaw: number, lidTop: number): [number, number, number, number] {
  const turnAway = Math.max(0, yaw * side) // this arm is on the side Clawd is turning toward
  const turnFrom = Math.max(0, -yaw * side)
  const len = (ARM.length + a.reach) * (1 - 0.55 * turnAway - 0.15 * turnFrom)
  const edge = bodyHalf
  // Horizontal nub.
  const attach = bodyBottom + ARM.fromBodyBottom + a.lift
  let i0 = edge - 0.05
  let i1 = edge + Math.max(0.2, len)
  let v0 = attach
  let v1 = attach + ARM.height
  // Raised: stands up from the shoulder beside the head (on top of the head it would read as an ear).
  const r = clamp(a.raise, 0, 1)
  if (r > 0) {
    const up = bodyBottom + 4 + a.lift * 0.5
    const ri0 = edge + 0.1
    const ri1 = edge + 1.3
    const rv0 = up
    const rv1 = up + 3.4 + Math.max(0, a.reach) * 0.9
    i0 = lerp(i0, ri0, r) + a.sway * r
    i1 = lerp(i1, ri1, r) + a.sway * r
    v0 = lerp(v0, rv0, r)
    v1 = lerp(v1, rv1, r)
  }
  // Typing: reaching over the top edge of the laptop lid.
  const ty = clamp(a.type, 0, 1)
  if (ty > 0) {
    const t0 = lidTop - 0.75 + a.lift
    i0 = lerp(i0, edge - 1.2, ty)
    i1 = lerp(i1, edge + 0.3, ty)
    v0 = lerp(v0, t0, ty)
    v1 = lerp(v1, t0 + 1.3, ty)
  }
  // Mirror for the left arm.
  return side > 0 ? [i0, v0, i1, v1] : [-i1, v0, -i0, v1]
}

export function computeGeometry(p: Pose): Geometry {
  const local: Rect[] = []

  const legLen = LEG.height * (1 - 0.72 * clamp(p.tuck, 0, 1)) * (1 - 0.45 * clamp(p.crouch, 0, 1))
  const bodyBottom = legLen + p.bodyY
  const bodyHalf = (BODY.right - BODY.left) / 2 - 0.3 * Math.abs(p.yaw)
  const bodyTop = bodyBottom + BODY.height
  const leanAt = (y: number) => (p.lean * (y - bodyBottom)) / BODY.height

  // Legs
  const spread = 1 + 0.14 * clamp(p.spread, 0, 1)
  for (let i = 0; i < 4; i++) {
    const cx = LEG_X[i] * spread + p.yaw * 0.15
    const lift = clamp(p.legs[i], 0, Math.max(0, bodyBottom - 0.3))
    local.push({ x0: cx - LEG.width / 2, y0: lift, x1: cx + LEG.width / 2, y1: bodyBottom + 0.05, color: PALETTE.body, part: 'leg' })
  }

  // Body, split into rows when leaning so the silhouette steps like pixel art.
  if (Math.abs(p.lean) < 0.02) {
    local.push({ x0: -bodyHalf, y0: bodyBottom, x1: bodyHalf, y1: bodyTop, color: PALETTE.body, part: 'body' })
  } else {
    const rowH = BODY.height / BODY_ROWS
    for (let r = 0; r < BODY_ROWS; r++) {
      const y0 = bodyBottom + r * rowH
      const dx = leanAt(y0 + rowH / 2)
      // Rows overlap slightly so no hairline gaps open between them.
      local.push({ x0: -bodyHalf + dx, y0: y0 - 0.01, x1: bodyHalf + dx, y1: y0 + rowH + 0.01, color: PALETTE.body, part: 'body' })
    }
  }

  // Laptop prop (coding companion), in front of the body but low enough to keep his face in view.
  // The lid faces the viewer and hides the keyboard; his arms reach over its top edge.
  const lap = clamp(p.laptop, 0, 1)
  const rise = ease.outBack(lap)
  const lidTop = 0.3 + 2.6 * rise
  if (lap > 0.001) {
    const half = 4.2
    local.push({ x0: -half - 0.8, y0: -0.05, x1: half + 0.8, y1: 0.45, color: PALETTE.laptopBase, part: 'laptop', alpha: lap })
    local.push({ x0: -half, y0: 0.3, x1: half, y1: lidTop, color: PALETTE.laptopLid, part: 'laptop', alpha: lap })
    local.push({ x0: -half, y0: lidTop - 0.35 * rise, x1: half, y1: lidTop, color: PALETTE.laptopEdge, part: 'laptop', alpha: lap })
  }

  // Arms (after the body and laptop so raised and typing arms overlap them cleanly).
  const arms: [number, number, number, number][] = [
    armRect(p.armL, -1, bodyHalf, bodyBottom, p.yaw, lidTop),
    armRect(p.armR, 1, bodyHalf, bodyBottom, p.yaw, lidTop),
  ]
  for (const [x0, y0, x1, y1] of arms) {
    const dx = leanAt((y0 + y1) / 2)
    local.push({ x0: x0 + dx, y0, x1: x1 + dx, y1, color: PALETTE.body, part: 'arm' })
  }

  // Eyes
  const spacing = EYE.dx - 0.3 * Math.abs(p.yaw)
  const eyeLimit = bodyHalf - 1
  const ecy = bodyBottom + EYE.fromBodyBottom + clamp(p.eyeY, -1.2, 0.62)
  for (const side of [-1, 1]) {
    const shrink = side < 0 ? 1 - 0.3 * clamp(p.eyeSkew, 0, 1) : 1
    const w = EYE.size * p.eyeW * shrink
    const h = EYE.size * p.eyeH * shrink
    const cx = clamp(side * spacing + p.yaw * 0.9 + clamp(p.eyeX, -1, 1) * 0.75, -eyeLimit, eyeLimit) + leanAt(ecy)
    eyeRects(cx, ecy, w, h, p, side, local)
  }

  // Squash/stretch about the feet, then the root offset.
  const tx = (x: number) => x * p.sx + p.x
  const ty = (y: number) => y * p.sy + p.y
  const rects: Rect[] = []
  const lift = Math.max(0, p.y)
  const shadowK = clamp(1 - lift / 14, 0, 1)
  if (p.shadow > 0.01 && shadowK > 0.01) {
    const hw = 5.2 * (0.55 + 0.45 * shadowK) * p.sx
    rects.push({ x0: p.x - hw, y0: -0.38, x1: p.x + hw, y1: 0.14, color: PALETTE.shadow, part: 'shadow', alpha: p.shadow * shadowK })
  }
  let bx0 = Infinity
  let by0 = Infinity
  let bx1 = -Infinity
  let by1 = -Infinity
  for (const r of local) {
    const out: Rect = { ...r, x0: tx(r.x0), y0: ty(r.y0), x1: tx(r.x1), y1: ty(r.y1) }
    rects.push(out)
    if (r.part !== 'laptop' && r.part !== 'sticker') {
      bx0 = Math.min(bx0, out.x0)
      by0 = Math.min(by0, out.y0)
      bx1 = Math.max(bx1, out.x1)
      by1 = Math.max(by1, out.y1)
    }
  }
  const armTip = (side: number) => {
    const [x0, y0, x1, y1] = arms[side < 0 ? 0 : 1]
    const raised = p[side < 0 ? 'armL' : 'armR'].raise > 0.5
    const dx = leanAt((y0 + y1) / 2)
    const x = raised ? (x0 + x1) / 2 : side < 0 ? x0 : x1
    const y = raised ? y1 : (y0 + y1) / 2
    return { x: tx(x + dx), y: ty(y) }
  }
  return {
    rects,
    head: { x: tx(leanAt(bodyTop)), y: ty(bodyTop) },
    handL: armTip(-1),
    handR: armTip(1),
    bounds: { x0: bx0, y0: by0, x1: bx1, y1: by1 },
  }
}
