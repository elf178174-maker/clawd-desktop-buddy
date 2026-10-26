// Cursor sheet: the teardrop pointer from the user's concept in three fills, pixel and smooth,
// at zoom and at actual size, plus the target focus ring and a pointing scene.

import { ClawdEngine, type EngineFrame } from '../../src/character/engine'
import { drawRects } from '../../src/character/render'
import type { Rect } from '../../src/character/geometry'
import {
  buildCursorSprite,
  cursorRects,
  CURSOR_SPRITE,
  CURSOR_THEMES,
  drawSmoothCursor,
  focusRingRects,
  type CursorThemeName,
} from '../../src/character/cursor'

const W = 1800
const H = 1180
const canvas = document.createElement('canvas')
canvas.width = W
canvas.height = H
document.body.appendChild(canvas)
const ctx = canvas.getContext('2d')!

function label(text: string, x: number, y: number, size = 14, color = '#A39E93', align: CanvasTextAlign = 'center') {
  ctx.font = `${size}px "Segoe UI", sans-serif`
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.fillText(text, x, y)
}
const draw = (rects: Rect[], x: number, y: number, scale: number) =>
  drawRects(ctx, rects, { scale, dpr: 1, originX: x, originY: y, snap: 'device' })

function wallpaper(x: number, y: number, w: number, h: number) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h)
  g.addColorStop(0, '#2E5E7E')
  g.addColorStop(0.5, '#C98B5B')
  g.addColorStop(1, '#5B7A3E')
  ctx.fillStyle = g
  ctx.fillRect(x, y, w, h)
}

function hotspot(x: number, y: number) {
  ctx.fillStyle = '#4FC3F7'
  ctx.fillRect(x - 1, y - 6, 2, 12)
  ctx.fillRect(x - 6, y - 1, 12, 2)
}

function clawdFrame(setup: (e: ClawdEngine) => void, seconds: number): EngineFrame {
  const e = new ClawdEngine({ seed: 3, idleFrequency: 0, sitAfter: 0, napAfter: 0 })
  e.setBase('idle')
  let f!: EngineFrame
  for (let i = 0; i < 60; i++) f = e.update({ dt: 1 / 60 })
  setup(e)
  for (let i = 0; i < seconds * 120; i++) f = e.update({ dt: 1 / 120 })
  return f
}

function main() {
  ctx.fillStyle = '#141413'
  ctx.fillRect(0, 0, W, H)
  label("Clawd's cursor v2: teardrop from your concept", 40, 46, 26, '#ECE9E2', 'left')
  label('Tip = hotspot (blue cross). Pixel versions are rasterised from the same shape so they match Clawd; smooth versions are the vector shape.', 40, 74, 15, '#A39E93', 'left')

  const themes: [CursorThemeName, string][] = [
    ['ember', 'dark fill, orange rim (recommended)'],
    ['clawd', 'orange fill, dark rim'],
    ['paper', 'light fill (your concept)'],
  ]
  // Zoomed: pixel and smooth for each theme.
  themes.forEach(([name, desc], i) => {
    const x0 = 40 + i * 580
    ctx.fillStyle = '#1C1B19'
    ctx.fillRect(x0, 100, 560, 330)
    label(`${name}: ${desc}`, x0 + 20, 128, 16, '#ECE9E2', 'left')
    const zoom = 9
    draw(cursorRects(CURSOR_SPRITE, CURSOR_THEMES[name]), x0 + 60, 160, zoom)
    hotspot(x0 + 60, 160)
    label('pixel (x9)', x0 + 140, 410)
    drawSmoothCursor(ctx, x0 + 330, 160, zoom, CURSOR_THEMES[name])
    hotspot(x0 + 330, 160)
    label('smooth (x9)', x0 + 410, 410)
  })

  // Actual size on backgrounds.
  const by = 460
  label('actual size: pixel at 2 px per cell (left) and smooth (right) on light, dark and photo backgrounds', 40, by + 20, 16, '#ECE9E2', 'left')
  themes.forEach(([name], i) => {
    const x0 = 40 + i * 580
    const bgs: ((x: number, y: number, w: number, h: number) => void)[] = [
      (x, y, w, h) => { ctx.fillStyle = '#F3F1EC'; ctx.fillRect(x, y, w, h) },
      (x, y, w, h) => { ctx.fillStyle = '#0E0E10'; ctx.fillRect(x, y, w, h) },
      wallpaper,
    ]
    bgs.forEach((bg, k) => {
      const bx = x0 + k * 190
      bg(bx, by + 40, 180, 110)
      draw(cursorRects(CURSOR_SPRITE, CURSOR_THEMES[name]), bx + 50, by + 70, 2)
      drawSmoothCursor(ctx, bx + 120, by + 70, 2, CURSOR_THEMES[name])
    })
    label(name, x0 + 280, by + 172)
  })
  // A finer pixel variant for high-DPI screens.
  const fine = buildCursorSprite({ angle: 50, r1: 1.2, r2: 6.2, h: 10.2, outline: 1.8 })
  ctx.fillStyle = '#F3F1EC'
  ctx.fillRect(40, by + 190, 180, 110)
  draw(cursorRects(fine, CURSOR_THEMES.ember), 110, by + 215, 1.5)
  ctx.fillStyle = '#0E0E10'
  ctx.fillRect(230, by + 190, 180, 110)
  draw(cursorRects(fine, CURSOR_THEMES.ember), 300, by + 215, 1.5)
  label('ember, finer grid (for 150 % scaling)', 225, by + 322)

  // Target focus ring.
  const ry = by + 350
  ctx.fillStyle = '#1C1B19'
  ctx.fillRect(40, ry, 1720, 360)
  label('target highlight: notched pixel ring that closes in on the control (frames 0, 1/3, 2/3, settled)', 60, ry + 28, 16, '#ECE9E2', 'left')
  for (let k = 0; k < 4; k++) {
    const x = 60 + k * 300
    ctx.fillStyle = '#F3F1EC'
    ctx.fillRect(x, ry + 50, 280, 150)
    const box = { x: x + 80, y: ry + 105, w: 120, h: 36 }
    ctx.fillStyle = '#2F6FEB'
    ctx.fillRect(box.x, box.y, box.w, box.h)
    ctx.font = '15px "Segoe UI", sans-serif'
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.fillText('Save changes', box.x + 60, box.y + 23)
    draw(focusRingRects(box, k / 3, 2), 0, 0, 1)
    if (k === 3) drawSmoothCursor(ctx, box.x + box.w - 6, box.y + box.h - 8, 2, CURSOR_THEMES.ember)
  }
  // On dark UI and around a line of text.
  ctx.fillStyle = '#202124'
  ctx.fillRect(1260, ry + 50, 480, 150)
  ctx.font = '14px Consolas, monospace'
  ctx.textAlign = 'left'
  ctx.fillStyle = '#9AA0A6'
  ctx.fillText('12  const total = items.reduce(sum, 0)', 1280, ry + 95)
  ctx.fillStyle = '#F28B82'
  ctx.fillText("13  return totl.toFixed(2)", 1280, ry + 125)
  ctx.fillStyle = '#9AA0A6'
  ctx.fillText('14  }', 1280, ry + 155)
  draw(focusRingRects({ x: 1300, y: ry + 111, w: 210, h: 20 }, 1, 2), 0, 0, 1)
  draw(cursorRects(CURSOR_SPRITE, CURSOR_THEMES.ember), 1500, ry + 132, 2)
  label('pointing at a line on a dark editor', 1500, ry + 222)

  // Pointing scene with Clawd.
  ctx.fillStyle = '#F3F1EC'
  ctx.fillRect(60, ry + 230, 1180, 120)
  ctx.fillStyle = '#E7E3DB'
  ctx.fillRect(60, ry + 230, 1180, 26)
  label('Settings > Privacy', 80, ry + 248, 13, '#57534D', 'left')
  const tg = { x: 760, y: ry + 290, w: 44, h: 22 }
  ctx.fillStyle = '#C9C4BA'
  ctx.fillRect(tg.x, tg.y, tg.w, tg.h)
  ctx.fillStyle = '#fff'
  ctx.fillRect(tg.x + 3, tg.y + 3, 16, 16)
  label('Allow clipboard monitoring', 600, ry + 306, 14, '#2B2A27')
  draw(focusRingRects(tg, 1, 2), 0, 0, 1)
  drawSmoothCursor(ctx, tg.x + tg.w - 4, tg.y + tg.h - 4, 2, CURSOR_THEMES.ember)
  const f = clawdFrame((e) => e.setBase('point', { dir: 1, up: 0.15 }), 0.6)
  draw([...f.geometry.rects, ...f.fx], 200, ry + 345, 6)
  label('"It\'s this toggle here."', 330, ry + 280, 14, '#57534D', 'left')
}

try {
  main()
  ;(window as unknown as { __png: string }).__png = canvas.toDataURL('image/png')
  document.title = 'done'
} catch (err) {
  document.title = 'error ' + String(err)
}
