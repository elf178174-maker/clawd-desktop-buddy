// Clawd's own pointer, drawn by the companion overlay (the system cursor is never replaced).
// The shape follows the user's concept: a teardrop (a circle drawn out to a rounded tip) with an
// orange outline and a light fill, tip pointing up-left. It is rasterised from a signed distance
// field so it can be produced as crisp pixel art at any cell size, or drawn as a smooth vector.
// The target highlight is a pixel focus ring with notched corners and a faint tint.

import type { Rect } from './geometry'

export interface CursorTheme {
  outline: string
  fill: string
  shade: string
}

/** ember: dark fill + orange rim (default); clawd: orange fill + dark rim; paper: the concept's light fill. */
export const CURSOR_THEMES = {
  ember: { outline: '#D77757', fill: '#1E1916', shade: '#2E2622' },
  clawd: { outline: '#241713', fill: '#D77757', shade: '#C2654A' },
  paper: { outline: '#D2693F', fill: '#FFF8F1', shade: '#F3DED0' },
} as const satisfies Record<string, CursorTheme>
export type CursorThemeName = keyof typeof CURSOR_THEMES

/** Colour of the target highlight ring. */
export const RING_COLOR = '#D77757'

export interface TeardropSpec {
  /** Direction from the tip to the round end, degrees clockwise from +x (screen, y down). */
  angle: number
  /** Tip radius, round-end radius and tip-to-centre distance, in cells. */
  r1: number
  r2: number
  h: number
  /** Outline thickness in cells. */
  outline: number
}

export const TEARDROP: TeardropSpec = { angle: 50, r1: 0.9, r2: 4.6, h: 7.6, outline: 1.35 }

/** Signed distance to an uneven capsule (Inigo Quilez): tip radius r1 at origin, r2 at (0, h). */
function sdUnevenCapsule(px: number, py: number, r1: number, r2: number, h: number): number {
  px = Math.abs(px)
  const b = (r1 - r2) / h
  const a = Math.sqrt(1 - b * b)
  const k = -b * px + a * py
  if (k < 0) return Math.hypot(px, py) - r1
  if (k > a * h) return Math.hypot(px, py - h) - r2
  return a * px + b * py - r1
}

/** Signed distance from a screen-space point (cells, y down, tip-centre at origin) to the teardrop. */
export function teardropSdf(x: number, y: number, s: TeardropSpec = TEARDROP): number {
  // Rotate so the capsule axis (local +y) points along `angle`.
  const th = (s.angle * Math.PI) / 180
  const ux = Math.cos(th)
  const uy = Math.sin(th)
  const ly = x * ux + y * uy
  const lx = -x * uy + y * ux
  return sdUnevenCapsule(lx, ly, s.r1, s.r2, s.h)
}

export interface CursorSprite {
  rows: string[]
  /** Hotspot in cells from the sprite's top-left (the very tip). */
  hotX: number
  hotY: number
}

/**
 * Rasterises the teardrop on a cell grid. O = outline, F = fill, S = soft inner shade, . = empty.
 * The hotspot is the outermost point of the rounded tip.
 */
export function buildCursorSprite(s: TeardropSpec = TEARDROP): CursorSprite {
  const th = (s.angle * Math.PI) / 180
  const ux = Math.cos(th)
  const uy = Math.sin(th)
  // Bounds of the shape in cells around the tip centre.
  const cx = ux * s.h
  const cy = uy * s.h
  const minX = Math.floor(Math.min(-s.r1, cx - s.r2)) - 1
  const maxX = Math.ceil(Math.max(s.r1, cx + s.r2)) + 1
  const minY = Math.floor(Math.min(-s.r1, cy - s.r2)) - 1
  const maxY = Math.ceil(Math.max(s.r1, cy + s.r2)) + 1
  const rows: string[] = []
  for (let gy = minY; gy < maxY; gy++) {
    let row = ''
    for (let gx = minX; gx < maxX; gx++) {
      const d = teardropSdf(gx + 0.5, gy + 0.5, s)
      if (d > 0.02) row += '.'
      else if (d > -s.outline) row += 'O'
      else {
        // A faint shade on the side away from the light (lower right) gives the fill some volume.
        const ld = teardropSdf(gx + 0.5 - 1.1, gy + 0.5 - 1.1, s)
        row += ld > -0.2 ? 'S' : 'F'
      }
    }
    rows.push(row)
  }
  // Trim empty rows/columns while tracking the offset of the tip.
  let top = 0
  while (top < rows.length && !/[^.]/.test(rows[top])) top++
  let bottom = rows.length
  while (bottom > top && !/[^.]/.test(rows[bottom - 1])) bottom--
  const kept = rows.slice(top, bottom)
  let left = Infinity
  let right = 0
  for (const r of kept) {
    const a = r.search(/[^.]/)
    if (a >= 0) left = Math.min(left, a)
    right = Math.max(right, r.length - (r.split('').reverse().join('').search(/[^.]/)))
  }
  const trimmed = kept.map((r) => r.slice(left, right))
  // Tip direction is -u; the hotspot is the tip centre pushed out by r1.
  const tipX = -minX - left - ux * s.r1
  const tipY = -minY - top - uy * s.r1
  return { rows: trimmed, hotX: tipX, hotY: tipY }
}

export const CURSOR_SPRITE: CursorSprite = buildCursorSprite()

/** Finer-grid pixel teardrop used by the "pixel" cursor style; drawn at ~1.5 px per cell. */
export const TEARDROP_FINE: TeardropSpec = { angle: 50, r1: 1.2, r2: 6.2, h: 10.2, outline: 1.8 }
export const CURSOR_SPRITE_FINE: CursorSprite = buildCursorSprite(TEARDROP_FINE)

/**
 * Rects for the pixel cursor in cell units, y-up, with the hotspot at the origin.
 * Render with RenderView.scale = CSS pixels per cell.
 */
export function cursorRects(sprite: CursorSprite = CURSOR_SPRITE, theme: CursorTheme = CURSOR_THEMES.ember, alpha = 1): Rect[] {
  const colors: Record<string, string> = { O: theme.outline, F: theme.fill, S: theme.shade }
  const out: Rect[] = []
  sprite.rows.forEach((row, r) => {
    let k = 0
    while (k < row.length) {
      const ch = row[k]
      if (ch === '.') {
        k++
        continue
      }
      let end = k + 1
      while (end < row.length && row[end] === ch) end++
      out.push({ x0: k - sprite.hotX, y0: -(r + 1 - sprite.hotY), x1: end - sprite.hotX, y1: -(r - sprite.hotY), color: colors[ch], part: 'body', alpha })
      k = end
    }
  })
  return out
}

/** Smooth vector teardrop for canvas, tip at (x, y) in CSS pixels; `size` is pixels per cell. */
export function drawSmoothCursor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  theme: CursorTheme = CURSOR_THEMES.ember,
  alpha = 1,
  s: TeardropSpec = TEARDROP,
): void {
  const th = (s.angle * Math.PI) / 180
  const ux = Math.cos(th)
  const uy = Math.sin(th)
  // Tip centre sits r1 behind the hotspot.
  const tx = x + ux * s.r1 * size
  const ty = y + uy * s.r1 * size
  const cx = tx + ux * s.h * size
  const cy = ty + uy * s.h * size
  const r1 = s.r1 * size
  const r2 = s.r2 * size
  // Tangent angle of the capsule sides.
  const phi = Math.asin((r2 - r1) / (s.h * size))
  const base = Math.atan2(uy, ux)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.beginPath()
  ctx.arc(cx, cy, r2, base - Math.PI / 2 - phi, base + Math.PI / 2 + phi)
  ctx.arc(tx, ty, r1, base + Math.PI / 2 + phi, base + (3 * Math.PI) / 2 - phi)
  ctx.closePath()
  ctx.shadowColor = 'rgba(0,0,0,0.28)'
  ctx.shadowBlur = size * 1.6
  ctx.shadowOffsetY = size * 0.5
  ctx.fillStyle = theme.fill
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.lineJoin = 'round'
  ctx.lineWidth = s.outline * size
  ctx.strokeStyle = theme.outline
  // Stroke inside the edge: clip to the shape and double the width.
  ctx.clip()
  ctx.lineWidth = s.outline * size * 2
  ctx.stroke()
  ctx.restore()
}

/**
 * Pixel focus ring around a target box (CSS px, y down), returned as rects whose y is negated so
 * they share the y-up rect renderer with origin (0,0) and scale 1. `t` 0..1 animates the ring in:
 * it starts wider and transparent and settles snugly around the target.
 */
export function focusRingRects(box: { x: number; y: number; w: number; h: number }, t: number, cell = 2, alpha = 1): Rect[] {
  const e = 1 - Math.pow(1 - Math.min(Math.max(t, 0), 1), 3)
  const pad = cell * (2 + (1 - e) * 6)
  const a = alpha * e
  const x0 = Math.round(box.x - pad)
  const y0 = Math.round(box.y - pad)
  const x1 = Math.round(box.x + box.w + pad)
  const y1 = Math.round(box.y + box.h + pad)
  const th = cell * 2 // ring thickness
  const n = cell // notch size at the corners
  const out: Rect[] = []
  const r = (ax0: number, ay0: number, ax1: number, ay1: number, color: string, al: number) =>
    out.push({ x0: ax0, y0: -ay1, x1: ax1, y1: -ay0, color, part: 'body', alpha: al })
  // Faint tint inside the ring.
  r(x0 + th, y0 + th, x1 - th, y1 - th, RING_COLOR, 0.1 * a)
  // Top, bottom, left, right bars with the corners notched (pixel-rounded).
  r(x0 + n, y0, x1 - n, y0 + th, RING_COLOR, a)
  r(x0 + n, y1 - th, x1 - n, y1, RING_COLOR, a)
  r(x0, y0 + n, x0 + th, y1 - n, RING_COLOR, a)
  r(x1 - th, y0 + n, x1, y1 - n, RING_COLOR, a)
  // Inner corner fillers so the notch reads as a one-step rounded corner.
  for (const [cx, cy] of [[x0 + n, y0 + n], [x1 - n - n, y0 + n], [x0 + n, y1 - n - n], [x1 - n - n, y1 - n - n]] as const) {
    r(cx, cy, cx + n, cy + n, RING_COLOR, a)
  }
  return out
}
