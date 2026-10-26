// Pixel glyph effects that float around Clawd: thinking dots, z's, ? and !, sparkles, a sweat drop
// and the listening meter. Each glyph cell is half an art unit and gets a dark outline so it reads
// on light and dark wallpapers alike.

import { PALETTE } from './anatomy'
import { clamp, ease, Rng } from './math'
import type { Rect } from './geometry'

const CELL = 0.5
const OUTLINE = 0.16

const GLYPHS = {
  z: ['#####', '...#.', '..#..', '.#...', '#####'],
  q: ['.###.', '#...#', '....#', '..##.', '..#..', '.....', '..#..'],
  bang: ['#', '#', '#', '.', '#'],
  spark: ['..#..', '..#..', '##.##', '..#..', '..#..'],
  spark3: ['.#.', '#.#', '.#.'],
  drop: ['..#..', '.###.', '#####', '#####', '.###.'],
  heart: ['##.##', '#####', '.###.', '..#..'],
  // Claude Code's working spinner (· ✢ ✳ ✶ ✻ ✽), redrawn on a 5 x 5 grid.
  spin0: ['.....', '.....', '..#..', '.....', '.....'],
  spin1: ['.....', '..#..', '.###.', '..#..', '.....'],
  spin2: ['..#..', '#.#.#', '.###.', '#.#.#', '..#..'],
  spin3: ['..#..', '.###.', '#####', '.###.', '..#..'],
  spin4: ['#.#.#', '.###.', '##.##', '.###.', '#.#.#'],
  spin5: ['.#.#.', '#####', '.###.', '#####', '.#.#.'],
} as const
type GlyphName = keyof typeof GLYPHS

export type FxKind = 'think' | 'zzz' | 'question' | 'alert' | 'sparkles' | 'sweat' | 'listen' | 'heart' | 'slap' | 'spinner' | 'talk' | 'stars'

interface FxItem {
  id: number
  kind: FxKind
  born: number
  /** Time the effect started fading out, or Infinity while held. */
  released: number
  seed: number
  /** Anchor relative to the head (art units). */
  dx: number
  dy: number
}

export interface FxFrame {
  /** Head position in art units (y up), from the geometry. */
  head: { x: number; y: number }
  /** Microphone level 0..1 for the listening meter, speech level while speaking. */
  level: number
  /** 0..1 global motion scale (reduced motion lowers it). */
  motion: number
}

function glyphRects(name: GlyphName, cx: number, cy: number, scale: number, color: string, alpha: number, out: Rect[]): void {
  const rows = GLYPHS[name]
  const h = rows.length
  const w = rows[0].length
  const c = CELL * scale
  const x0 = cx - (w * c) / 2
  const y0 = cy + (h * c) / 2
  const cells: [number, number][] = []
  for (let r = 0; r < h; r++)
    for (let k = 0; k < w; k++) if (rows[r][k] === '#') cells.push([x0 + k * c, y0 - (r + 1) * c])
  const o = OUTLINE * scale
  for (const [x, y] of cells) out.push({ x0: x - o, y0: y - o, x1: x + c + o, y1: y + c + o, color: PALETTE.ink, part: 'body', alpha })
  for (const [x, y] of cells) out.push({ x0: x, y0: y, x1: x + c, y1: y + c, color, part: 'body', alpha })
}

function block(cx: number, cy: number, size: number, color: string, alpha: number, out: Rect[]): void {
  const o = OUTLINE
  const s = size / 2
  out.push({ x0: cx - s - o, y0: cy - s - o, x1: cx + s + o, y1: cy + s + o, color: PALETTE.ink, part: 'body', alpha })
  out.push({ x0: cx - s, y0: cy - s, x1: cx + s, y1: cy + s, color, part: 'body', alpha })
}

export class FxSystem {
  private items: FxItem[] = []
  private nextId = 1
  private rng = new Rng(7)
  private lastZ = -Infinity

  /** Starts a held effect if it is not already running. Held effects run until released. */
  hold(kind: FxKind, now: number): void {
    if (this.items.some((f) => f.kind === kind && f.released === Infinity)) return
    this.items.push({ id: this.nextId++, kind, born: now, released: Infinity, seed: this.rng.next(), dx: 0, dy: 0 })
  }

  release(kind: FxKind, now: number): void {
    for (const f of this.items) if (f.kind === kind && f.released === Infinity) f.released = now
  }

  releaseAll(now: number): void {
    for (const f of this.items) if (f.released === Infinity) f.released = now
  }

  /** One-shot burst (sparkles, sweat drop, heart, high-five slap). */
  burst(kind: FxKind, now: number, dx = 0, dy = 0): void {
    this.items.push({ id: this.nextId++, kind, born: now, released: now + this.lifeOf(kind), seed: this.rng.next(), dx, dy })
  }

  get active(): boolean {
    return this.items.length > 0
  }

  kinds(): FxKind[] {
    return this.items.filter((f) => f.released === Infinity).map((f) => f.kind)
  }

  private lifeOf(kind: FxKind): number {
    switch (kind) {
      case 'sparkles':
        return 1.1
      case 'sweat':
        return 1.4
      case 'heart':
        return 1.3
      case 'slap':
        return 0.45
      default:
        return 0.4
    }
  }

  update(now: number): void {
    // Sleeping emits a new z every ~1.5 s while held.
    if (this.items.some((f) => f.kind === 'zzz' && f.released === Infinity) && now - this.lastZ > 1.5) {
      this.lastZ = now
      this.burstZ(now)
    }
    this.items = this.items.filter((f) => now - f.released < this.fadeTime(f))
  }

  private burstZ(now: number): void {
    this.items.push({ id: this.nextId++, kind: 'zzz', born: now, released: now + 2.6, seed: this.rng.next(), dx: 0, dy: 0 })
  }

  private fadeTime(f: FxItem): number {
    return f.kind === 'zzz' && f.released !== Infinity && f.released - f.born > 2 ? 0.01 : 0.25
  }

  render(now: number, frame: FxFrame, out: Rect[]): void {
    const { head } = frame
    for (const f of this.items) {
      const age = now - f.born
      const fadeIn = clamp(age / 0.18, 0, 1)
      const fadeOut = f.released === Infinity ? 1 : clamp(1 - (now - f.released) / 0.25, 0, 1)
      const a = Math.min(fadeIn, fadeOut)
      if (a <= 0) continue
      const pop = ease.outBack(clamp(age / 0.28, 0, 1), 2.2)
      switch (f.kind) {
        case 'think': {
          // Three dots above the head that light up in sequence.
          for (let i = 0; i < 3; i++) {
            const phase = (age * 1.6 - i * 0.28) % 1
            const lit = phase > 0 && phase < 0.45 ? 1 : 0.45
            const bob = phase > 0 && phase < 0.45 ? Math.sin((phase / 0.45) * Math.PI) * 0.35 * frame.motion : 0
            block(head.x - 1.6 + i * 1.6, head.y + 2.2 + bob, 0.8, PALETTE.cream, a * lit, out)
          }
          break
        }
        case 'zzz': {
          // Only the emitted z's draw; the held item just drives the emitter.
          if (f.released === Infinity) break
          const life = f.released - f.born
          const u = clamp(age / life, 0, 1)
          const za = Math.min(clamp(age / 0.4, 0, 1), clamp((1 - u) / 0.35, 0, 1))
          const x = head.x + 3 + u * 2.2 + Math.sin(u * 5 + f.seed * 6) * 0.5
          const y = head.y + 0.6 + u * 4.2
          glyphRects('z', x, y, 0.75 + u * 0.5, PALETTE.cream, za, out)
          break
        }
        case 'question': {
          const bob = Math.sin(age * 3.2) * 0.25 * frame.motion
          glyphRects('q', head.x + 2.4, head.y + 2.6 + bob, pop, PALETTE.body, a, out)
          break
        }
        case 'alert': {
          const bob = Math.abs(Math.sin(age * 4.5)) * 0.4 * frame.motion
          glyphRects('bang', head.x, head.y + 2.6 + bob, pop * 1.1, PALETTE.body, a, out)
          break
        }
        case 'sparkles': {
          const rng = new Rng(Math.floor(f.seed * 1e9))
          const life = f.released - f.born
          const u = clamp(age / life, 0, 1)
          for (let i = 0; i < 5; i++) {
            const ang = (i / 5) * Math.PI * 2 + rng.range(-0.3, 0.3)
            const dist = 4 + u * 3.5 + rng.range(0, 1.2)
            const x = head.x + Math.cos(ang) * dist * 1.15
            const y = head.y - 2.5 + Math.sin(ang) * dist
            const s = (1 - u) * (i % 2 ? 0.8 : 1) * ease.outBack(clamp(age / 0.2, 0, 1))
            const name: GlyphName = i % 2 ? 'spark3' : 'spark'
            if (s > 0.05) glyphRects(name, x, y, s, PALETTE.cream, a * (1 - u * 0.5), out)
          }
          break
        }
        case 'sweat': {
          const life = f.released - f.born
          const u = clamp(age / life, 0, 1)
          glyphRects('drop', head.x + 5.3, head.y + 0.4 - u * 1.8, 0.9, '#8EC5F0', a * (1 - u * u), out)
          break
        }
        case 'heart': {
          const life = f.released - f.born
          const u = clamp(age / life, 0, 1)
          glyphRects('heart', head.x + f.dx, head.y + 1.5 + u * 3, pop * 0.9, PALETTE.body, a * (1 - u * u), out)
          break
        }
        case 'slap': {
          const life = f.released - f.born
          const u = clamp(age / life, 0, 1)
          // Four short rays bursting out of the contact point.
          const cx = head.x + f.dx
          const cy = head.y + f.dy
          const d = 0.8 + u * 1.6
          for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7]] as const) {
            block(cx + ux * d, cy + uy * d, 0.5 * (1 - u), PALETTE.cream, a * (1 - u), out)
          }
          break
        }
        case 'spinner': {
          // Ping-pongs through the six frames at ~8 fps, like Claude Code's own spinner.
          const seq = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1] as const
          const k = seq[Math.floor(age * 8 + f.seed * 10) % seq.length]
          glyphRects(`spin${k}` as GlyphName, head.x, head.y + 2.6, pop, PALETTE.body, a, out)
          break
        }
        case 'talk': {
          // Three sound bars beside the head that follow the speech level.
          const lvl = clamp(frame.level, 0, 1)
          for (let i = 0; i < 3; i++) {
            const wobble = 0.6 + 0.4 * Math.sin(age * 11 + i * 2.1)
            const h = 0.5 + lvl * (2.2 - i * 0.5) * wobble
            const x = head.x + 5.2 + i * 0.95
            const cy = head.y - 2.2
            out.push({ x0: x - 0.42, y0: cy - h / 2 - 0.16, x1: x + 0.42, y1: cy + h / 2 + 0.16, color: PALETTE.ink, part: 'body', alpha: a * (1 - i * 0.18) })
            out.push({ x0: x - 0.26, y0: cy - h / 2, x1: x + 0.26, y1: cy + h / 2, color: PALETTE.cream, part: 'body', alpha: a * (1 - i * 0.18) })
          }
          break
        }
        case 'stars': {
          // Three little stars circling above the head; the ones "behind" him are dimmer.
          for (let i = 0; i < 3; i++) {
            const ang = age * 5.2 + (i * Math.PI * 2) / 3
            const front = Math.sin(ang)
            const x = head.x + Math.cos(ang) * 3.4
            const y = head.y + 1.5 + front * 0.7
            glyphRects('spark3', x, y, pop * (0.8 + 0.2 * front), PALETTE.cream, a * (0.55 + 0.45 * (front * 0.5 + 0.5)), out)
          }
          break
        }
        case 'listen': {
          // Five-bar meter driven by the real microphone level.
          const lvl = clamp(frame.level, 0, 1)
          for (let i = 0; i < 5; i++) {
            const wobble = 0.55 + 0.45 * Math.sin(age * 9 + i * 1.7)
            const centre = 1 - Math.abs(i - 2) / 3
            const h = 0.5 + lvl * 2.6 * centre * wobble
            const x = head.x - 2 + i
            out.push({ x0: x - 0.42, y0: head.y + 1.4 - 0.16, x1: x + 0.42, y1: head.y + 1.4 + h + 0.16, color: PALETTE.ink, part: 'body', alpha: a })
            out.push({ x0: x - 0.26, y0: head.y + 1.4, x1: x + 0.26, y1: head.y + 1.4 + h, color: PALETTE.cream, part: 'body', alpha: a })
          }
          break
        }
      }
    }
  }
}
