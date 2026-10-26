// Screen-edge glow (in the spirit of Apple Intelligence) shown while Clawd uses his cursor, controls
// input, or listens. Two counter-rotating conic gradients sit inside a soft frame mask with rounded
// inner corners (drawn once per screen size); only transforms animate, so the compositor does all the
// work and the main thread stays idle. The rotation pauses while the glow is off.

export type GlowPalette = 'aurora' | 'clawd'

const PALETTES: Record<GlowPalette, [string[], string[]]> = {
  aurora: [
    ['#ff8a4c', '#ff4f8b', '#b56cff', '#4f9dff', '#41d6c3', '#ffc24a', '#ff8a4c'],
    ['#ff5e7e', '#7c6cff', '#36c5ff', '#ffb347', '#ff6a3d', '#ff5e7e'],
  ],
  clawd: [
    ['#d77757', '#ff9a6c', '#ffcf8a', '#e2563f', '#f59f7d', '#c2603d', '#d77757'],
    ['#ff8a5c', '#ffb36b', '#d9502e', '#ffd39a', '#ff8a5c'],
  ],
}

export class EdgeGlow {
  private root = document.createElement('div')
  private soft = document.createElement('div')
  private line = document.createElement('div')
  private spins: HTMLDivElement[] = []
  private on = false
  private palette: GlowPalette | null = null
  private level = 0

  constructor(parent: HTMLElement) {
    this.root.className = 'glow'
    this.soft.className = 'glow-ring soft'
    this.line.className = 'glow-ring line'
    for (const ring of [this.soft, this.line]) {
      const a = document.createElement('div')
      a.className = 'glow-spin a'
      const b = document.createElement('div')
      b.className = 'glow-spin b'
      ring.append(a, b)
      this.spins.push(a, b)
      this.root.appendChild(ring)
    }
    parent.prepend(this.root)
    this.applyMasks()
    window.addEventListener('resize', () => this.applyMasks())
  }

  /** One mask per ring: opaque at the screen edge, fading inward to a rounded rectangle. */
  private applyMasks(): void {
    const W = window.innerWidth
    const H = window.innerHeight
    if (!W || !H) return
    const rings: [HTMLDivElement, number, number, number][] = [
      // ring, band width (px), blur (px), resolution: the soft band is smooth enough at half size
      [this.soft, 40, 26, 0.5],
      [this.line, 3, 1.5, 1],
    ]
    for (const [ring, band, blur, k] of rings) {
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.ceil(W * k))
      c.height = Math.max(1, Math.ceil(H * k))
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.globalCompositeOperation = 'destination-out'
      ctx.filter = `blur(${blur * k}px)`
      ctx.beginPath()
      ctx.roundRect(band * k, band * k, c.width - 2 * band * k, c.height - 2 * band * k, 24 * k)
      ctx.fill()
      const url = `url(${c.toDataURL('image/png')})`
      ring.style.maskImage = url
      ring.style.webkitMaskImage = url
    }
  }

  setPalette(p: GlowPalette): void {
    if (p === this.palette) return
    this.palette = p
    const [a, b] = PALETTES[p]
    for (let i = 0; i < this.spins.length; i++) {
      const stops = i % 2 === 0 ? a : b
      this.spins[i].style.background = `conic-gradient(from 0deg, ${stops.join(', ')})`
    }
  }

  set(on: boolean): void {
    if (on === this.on) return
    this.on = on
    this.root.classList.toggle('on', on)
  }

  get visible(): boolean {
    return this.on
  }

  /** Voice level 0..1 makes the glow breathe while listening. */
  setLevel(v: number): void {
    const l = Math.max(0, Math.min(1, v))
    if (Math.abs(l - this.level) < 0.02) return
    this.level = l
    this.soft.style.opacity = String(0.62 + 0.38 * l)
    this.line.style.opacity = String(0.75 + 0.25 * l)
  }

  setReduced(reduced: boolean): void {
    this.root.classList.toggle('still', reduced)
  }
}
