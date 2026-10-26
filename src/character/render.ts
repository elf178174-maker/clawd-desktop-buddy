// Canvas 2D rasteriser for Clawd's rectangles. Edges are snapped to whole device pixels, so every
// block stays crisp (no anti-aliased fringes) while positions still move smoothly, one device pixel
// at a time. 'art' snapping additionally locks parts to the half-unit grid for a retro feel.

import type { Rect } from './geometry'

export type SnapMode = 'device' | 'art'

export interface RenderView {
  /** CSS pixels per art unit. */
  scale: number
  /** Device pixels per CSS pixel. */
  dpr: number
  /** Position of the art-space origin, in CSS pixels from the canvas top-left. */
  originX: number
  originY: number
  snap: SnapMode
}

export function toDevice(view: RenderView, xu: number, yu: number): [number, number] {
  return [(view.originX + xu * view.scale) * view.dpr, (view.originY - yu * view.scale) * view.dpr]
}

export function drawRects(ctx: CanvasRenderingContext2D, rects: readonly Rect[], view: RenderView): void {
  const { scale, dpr, originX, originY } = view
  const grid = view.snap === 'art' ? 0.5 : 0
  const q = (v: number) => (grid ? Math.round(v / grid) * grid : v)
  let lastAlpha = -1
  let lastColor = ''
  for (const r of rects) {
    const a = r.alpha ?? 1
    if (a <= 0.003) continue
    let x0 = q(r.x0)
    let x1 = q(r.x1)
    let y0 = q(r.y0)
    let y1 = q(r.y1)
    if (grid) {
      // Keep thin features (a blink) from vanishing when snapped.
      if (x1 - x0 < grid) x1 = x0 + grid
      if (y1 - y0 < grid / 2) y1 = y0 + grid / 2
    }
    // Position snaps to the device grid; size comes from the rect's own size, so a part keeps the
    // same width while it moves (rounding both edges would make it flicker between widths).
    const dx0 = Math.round((originX + x0 * scale) * dpr)
    const dy0 = Math.round((originY - y1 * scale) * dpr)
    const w = Math.max(1, Math.round((x1 - x0) * scale * dpr))
    const h = Math.max(1, Math.round((y1 - y0) * scale * dpr))
    if (a !== lastAlpha) {
      ctx.globalAlpha = a
      lastAlpha = a
    }
    if (r.color !== lastColor) {
      ctx.fillStyle = r.color
      lastColor = r.color
    }
    ctx.fillRect(dx0, dy0, w, h)
  }
  ctx.globalAlpha = 1
}

/** Device-pixel bounding box of a set of rects, padded, for dirty-rectangle clearing. */
export function deviceBounds(rects: readonly Rect[], view: RenderView, pad = 2): { x: number; y: number; w: number; h: number } | null {
  if (!rects.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x0)
    x1 = Math.max(x1, r.x1)
    y0 = Math.min(y0, r.y0)
    y1 = Math.max(y1, r.y1)
  }
  const [dx0, dy1] = toDevice(view, x0, y0)
  const [dx1, dy0] = toDevice(view, x1, y1)
  return { x: Math.floor(dx0) - pad, y: Math.floor(dy0) - pad, w: Math.ceil(dx1 - dx0) + pad * 2, h: Math.ceil(dy1 - dy0) + pad * 2 }
}

/** Cheap signature of a rect list at device resolution; equal signatures mean identical pixels. */
export function rectSignature(rects: readonly Rect[], view: RenderView): string {
  let s = ''
  for (const r of rects) {
    const [a, b] = toDevice(view, r.x0, r.y1)
    const [c, d] = toDevice(view, r.x1, r.y0)
    s += `${Math.round(a)},${Math.round(b)},${Math.round(c)},${Math.round(d)},${r.color},${Math.round((r.alpha ?? 1) * 64)};`
  }
  return s
}
