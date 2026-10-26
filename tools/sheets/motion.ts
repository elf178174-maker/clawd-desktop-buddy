// Motion review sheet: a filmstrip per animation state (evenly spaced frames through one-shots,
// two seconds of loops) plus a long-exposure ghost of each strip, so timing, spacing and
// silhouettes can be judged at a glance. Rendered offscreen by tools/sheet.mjs.
// node tools/sheet.mjs tools/sheets/motion.ts docs/motion-review.png 1880 2300

import { ClawdEngine, type EngineFrame } from '../../src/character/engine'
import { drawRects, type Rect } from '../../src/character/render'
import { STATES, type StateName } from '../../src/character/states'

const ROWS: { name: StateName; loop?: number; level?: number; look?: { x: number; y: number } }[] = [
  { name: 'enter' },
  { name: 'wave' },
  { name: 'poke' },
  { name: 'hop' },
  { name: 'highFive' },
  { name: 'celebrate' },
  { name: 'drop' },
  { name: 'dizzy' },
  { name: 'error' },
  { name: 'confused' },
  { name: 'curious' },
  { name: 'interrupt' },
  { name: 'wake' },
  { name: 'leave' },
  { name: 'listen', loop: 2, level: 0.6 },
  { name: 'think', loop: 2 },
  { name: 'work', loop: 2 },
  { name: 'speak', loop: 2, level: 0.7 },
  { name: 'permission', loop: 2 },
  { name: 'type', loop: 2 },
  { name: 'waitCC', loop: 2 },
  { name: 'attention', loop: 2 },
  { name: 'sleep', loop: 3 },
  { name: 'idle', loop: 3, look: { x: 6, y: 3 } },
]
const COLS = 12
const SCALE = 5
const CELL_W = 118
const ROW_H = 92
const LEFT = 150
const TOP = 80
const W = LEFT + COLS * CELL_W + 150
const H = TOP + ROWS.length * ROW_H + 20

const canvas = document.createElement('canvas')
canvas.width = W
canvas.height = H
document.body.appendChild(canvas)
const ctx = canvas.getContext('2d')!

function label(text: string, x: number, y: number, size = 14, color = '#A39E93', align: CanvasTextAlign = 'left') {
  ctx.font = `${size}px "Segoe UI", sans-serif`
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.fillText(text, x, y)
}

function strip(row: (typeof ROWS)[number]): { frames: EngineFrame[]; times: number[]; seconds: number } {
  const e = new ClawdEngine({ seed: 5, idleFrequency: 0, sitAfter: 0, napAfter: 0 })
  const oneShot = STATES[row.name].duration !== undefined
  e.setBase(oneShot ? 'idle' : row.name)
  for (let i = 0; i < 90; i++) e.update({ dt: 1 / 60 })
  if (oneShot) e.play(row.name)
  const seconds = oneShot ? STATES[row.name].duration! : row.loop ?? 2
  const frames: EngineFrame[] = []
  const times: number[] = []
  const fps = 120
  const total = Math.round(seconds * fps)
  const every = total / (COLS - 1)
  for (let i = 0; i <= total; i++) {
    const f = e.update({ dt: 1 / fps, level: row.level ? row.level * (0.6 + 0.4 * Math.sin(i / 7)) : 0, look: row.look ?? null, lookActive: !!row.look })
    if (Math.round(frames.length * every) === i && frames.length < COLS) {
      frames.push(f)
      times.push(i / fps)
    }
  }
  return { frames, times, seconds }
}

function draw(rects: Rect[], x: number, y: number, alpha = 1) {
  ctx.save()
  ctx.globalAlpha = alpha
  drawRects(ctx, rects, { scale: SCALE, dpr: 1, originX: x, originY: y, snap: 'device' })
  ctx.restore()
}

ctx.fillStyle = '#141413'
ctx.fillRect(0, 0, W, H)
label('Clawd motion review', 24, 36, 24, '#ECE9E2')
label(`One-shots: ${COLS} evenly spaced frames over the whole move. Loops: 2-3 s. Right: long exposure of the strip.`, 24, 60, 14)

ROWS.forEach((row, r) => {
  const y = TOP + r * ROW_H
  ctx.fillStyle = r % 2 ? '#181817' : '#1C1C1B'
  ctx.fillRect(0, y, W, ROW_H)
  const { frames, times, seconds } = strip(row)
  label(row.name, 20, y + 40, 16, '#ECE9E2')
  label(`${seconds.toFixed(2)} s${STATES[row.name].duration === undefined ? ' loop' : ''}`, 20, y + 60, 12)
  const ground = y + ROW_H - 18
  frames.forEach((f, i) => {
    const cx = LEFT + i * CELL_W + CELL_W / 2
    ctx.fillStyle = '#2A2A28'
    ctx.fillRect(cx - 40, ground, 80, 1)
    draw([...f.geometry.rects, ...f.fx], cx, ground)
    label(`${times[i].toFixed(2)}`, cx, y + 12, 10, '#6B675F', 'center')
  })
  // Long exposure: every frame faintly on top of each other.
  const lx = LEFT + COLS * CELL_W + 70
  frames.forEach((f) => draw(f.geometry.rects, lx, ground, 0.16))
})

;(window as unknown as { __png: string }).__png = canvas.toDataURL('image/png')
document.title = 'done'
