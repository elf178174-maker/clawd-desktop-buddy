// Style frame: reference comparison, expressions, poses, legibility on different backgrounds,
// and the two cursor options. Rendered offscreen by tools/sheet.mjs.

import { ClawdEngine, type EngineFrame } from '../../src/character/engine'
import { computeGeometry, type Rect } from '../../src/character/geometry'
import { neutralPose, type Pose } from '../../src/character/pose'
import { drawRects } from '../../src/character/render'
import type { StateName } from '../../src/character/states'

declare const __REF__: string

const W = 1800
const H = 1640
const canvas = document.createElement('canvas')
canvas.width = W
canvas.height = H
document.body.appendChild(canvas)
const ctx = canvas.getContext('2d')!

function label(text: string, x: number, y: number, size = 15, color = '#A39E93', align: CanvasTextAlign = 'center') {
  ctx.font = `${size}px "Segoe UI", sans-serif`
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.fillText(text, x, y)
}

function drawAt(rects: Rect[], x: number, y: number, scale: number) {
  drawRects(ctx, rects, { scale, dpr: 1, originX: x, originY: y, snap: 'device' })
}

function frameOf(setup: (e: ClawdEngine) => void, seconds: number, level = 0, look: { x: number; y: number } | null = null): EngineFrame {
  const e = new ClawdEngine({ seed: 3, idleFrequency: 0, sitAfter: 0, napAfter: 0 })
  e.setBase('idle')
  let f!: EngineFrame
  for (let i = 0; i < 60; i++) f = e.update({ dt: 1 / 60 })
  setup(e)
  const steps = Math.round(seconds * 120)
  for (let i = 0; i < steps; i++) f = e.update({ dt: 1 / 120, level, look, lookActive: !!look })
  return f
}

function poseRects(p: Pose): Rect[] {
  return computeGeometry(p).rects
}

const all = (f: EngineFrame) => [...f.geometry.rects, ...f.fx]

function main() {
  ctx.fillStyle = '#141413'
  ctx.fillRect(0, 0, W, H)
  label('Clawd: style frame v1', 40, 46, 26, '#ECE9E2', 'left')
  label('Flat pixel blocks at the reference proportions (12 x 8 units). Edges snap to whole device pixels so motion stays smooth.', 40, 74, 15, '#A39E93', 'left')

  // 1. Reference comparison at the same unit size.
  const ref = new Image()
  ref.onload = () => {
    try {
      const unit = 35.5 / 8 // reference pixels per art unit
      const k = 4
      ctx.fillStyle = '#191919'
      ctx.fillRect(40, 100, 560, 300)
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(ref, 60, 120, ref.width * k, ref.height * k)
      label('your reference (x4)', 186, 388)
      drawAt(poseRects({ ...neutralPose(), shadow: 0 }), 60 + 36 * k, 120 + 48 * k, unit * k)
      drawAt(poseRects({ ...neutralPose(), shadow: 0 }), 455, 120 + 48 * k, unit * k)
      label('Clawd rig, neutral', 455, 388)
      rest()
      ;(window as unknown as { __png: string }).__png = canvas.toDataURL('image/png')
      document.title = 'done'
    } catch (err) {
      document.title = 'error ' + String(err)
    }
  }
  ref.onerror = () => (document.title = 'error loading reference')
  ref.src = __REF__
}

function rest() {
  // Overlay check: rig drawn translucently over the reference.
  label('rig drawn over the reference (overlay)', 186 + 4, 410, 13, '#6E6A62')

  // 2. Expressions (manual poses).
  const ex: [string, Partial<Pose>][] = [
    ['neutral', {}],
    ['blink', { eyeOpen: 0 }],
    ['look left', { eyeX: -0.8, eyeY: 0.1 }],
    ['look up-right', { eyeX: 0.7, eyeY: 0.6, yaw: 0.35 }],
    ['happy', { happy: 1 }],
    ['squeeze', { squeeze: 1 }],
    ['surprised', { eyeH: 1.35, eyeW: 1.15 }],
    ['sad', { eyeY: -0.35, eyeH: 0.82 }],
    ['confused', { eyeSkew: 1, lean: 0.42, eyeX: 0.3, eyeY: 0.2 }],
    ['turned right', { yaw: 0.9, eyeX: 0.4 }],
  ]
  const ey = 440
  ctx.fillStyle = '#1C1B19'
  ctx.fillRect(620, 100, 1140, 300)
  label('expressions', 640, 126, 16, '#ECE9E2', 'left')
  ex.forEach(([name, patch], i) => {
    const col = i % 5
    const row = Math.floor(i / 5)
    const x = 720 + col * 220
    const y = 250 + row * 140
    drawAt(poseRects({ ...neutralPose(), ...patch, shadow: 0 }), x, y, 10)
    label(name, x, y + 22)
  })

  // 3. Poses from the real animation engine.
  const poses: [string, () => EngineFrame][] = [
    ['wave', () => frameOf((e) => e.play('wave'), 0.45)],
    ['celebrate (air)', () => frameOf((e) => e.play('celebrate'), 0.34)],
    ['think', () => frameOf((e) => e.setBase('think'), 1.3)],
    ['listening', () => frameOf((e) => e.setBase('listen'), 0.9, 0.7)],
    ['speaking', () => frameOf((e) => e.setBase('speak'), 0.4, 0.8)],
    ['sit', () => frameOf((e) => e.setBase('sit'), 1.2)],
    ['nap', () => frameOf((e) => e.setBase('sleep'), 3.4)],
    ['error', () => frameOf((e) => e.play('error'), 1.1)],
    ['confused', () => frameOf((e) => e.play('confused'), 0.8)],
    ['curious', () => frameOf((e) => e.play('curious', { dir: 1, up: 0.3 }), 1.0)],
    ['asking permission', () => frameOf((e) => e.setBase('permission'), 0.8)],
    ['offer high five', () => frameOf((e) => e.setBase('offerFive'), 0.6)],
    ['high five!', () => frameOf((e) => { e.setBase('offerFive'); }, 0.6)],
    ['dragged', () => frameOf((e) => e.setBase('dragged'), 0.5)],
    ['walking', () => frameOf((e) => e.setBase('walk', { dir: 1 }), 0.62)],
    ['enter: peeking', () => frameOf((e) => e.play('enter'), 0.5)],
    ['typing (laptop)', () => frameOf((e) => e.setBase('type'), 1.4)],
    ['waiting on Claude Code', () => frameOf((e) => e.setBase('waitCC'), 1.4)],
    ['Claude Code needs you', () => frameOf((e) => e.setBase('attention'), 0.7)],
    ['pointing', () => frameOf((e) => e.setBase('point', { dir: 1, up: 0.2 }), 0.6)],
    ['poke', () => frameOf((e) => e.play('poke'), 0.06)],
  ]
  const py0 = 430
  ctx.fillStyle = '#1C1B19'
  ctx.fillRect(40, py0, 1720, 640)
  label('poses (rendered by the animation engine)', 60, py0 + 28, 16, '#ECE9E2', 'left')
  poses.forEach(([name, fn], i) => {
    const col = i % 7
    const row = Math.floor(i / 7)
    const x = 150 + col * 240
    const y = py0 + 190 + row * 200
    let f = fn()
    if (name === 'high five!') {
      const e = new ClawdEngine({ seed: 3, idleFrequency: 0, sitAfter: 0, napAfter: 0 })
      e.setBase('idle')
      for (let k = 0; k < 60; k++) e.update({ dt: 1 / 60 })
      e.setBase('offerFive')
      for (let k = 0; k < 60; k++) e.update({ dt: 1 / 60 })
      e.play('highFive')
      for (let k = 0; k < 12; k++) f = e.update({ dt: 1 / 120 })
    }
    if (name === 'enter: peeking') {
      // Show the screen edge he rises from.
      ctx.save()
      ctx.beginPath()
      ctx.rect(x - 110, y - 170, 220, 170)
      ctx.clip()
      drawAt(all(f), x, y, 9)
      ctx.restore()
      ctx.fillStyle = '#2B2A27'
      ctx.fillRect(x - 110, y, 220, 14)
    } else drawAt(all(f), x, y, 9)
    label(name, x, y + 34)
  })

  // 4. Legibility at actual size on different backgrounds.
  const by = 1090
  label('actual size (7 px per unit) on different backgrounds', 60, by + 26, 16, '#ECE9E2', 'left')
  const bgs: [string, (x: number, y: number, w: number, h: number) => void][] = [
    ['dark desktop', (x, y, w, h) => { ctx.fillStyle = '#0E0E10'; ctx.fillRect(x, y, w, h) }],
    ['light window', (x, y, w, h) => { ctx.fillStyle = '#F3F1EC'; ctx.fillRect(x, y, w, h); ctx.fillStyle = '#D9D4CA'; ctx.fillRect(x, y + 40, w, 1) }],
    ['photo wallpaper', (x, y, w, h) => {
      const g = ctx.createLinearGradient(x, y, x + w, y + h)
      g.addColorStop(0, '#2E5E7E'); g.addColorStop(0.5, '#C98B5B'); g.addColorStop(1, '#5B7A3E')
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h)
    }],
    ['on the taskbar', (x, y, w, h) => {
      ctx.fillStyle = '#3A4A5C'; ctx.fillRect(x, y, w, h)
      ctx.fillStyle = '#202020'; ctx.fillRect(x, y + h - 36, w, 36)
    }],
  ]
  bgs.forEach(([name, paint], i) => {
    const x = 60 + i * 300
    paint(x, by + 44, 280, 170)
    const f = frameOf((e) => e.setBase('idle'), 0.5)
    const ground = name === 'on the taskbar' ? by + 44 + 170 - 36 : by + 44 + 140
    drawAt(all(f), x + 140, ground, 7)
    label(name, x + 140, by + 236)
  })

  // The cursor has its own sheet (tools/sheets/cursor.ts).
}

try {
  main()
} catch (err) {
  document.title = 'error ' + String(err)
}

export type { StateName }
