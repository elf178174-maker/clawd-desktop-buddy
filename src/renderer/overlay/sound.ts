// Soft synthesized interaction sounds in a small chiptune voice. Nothing is loaded from disk.

type Voice = { f0: number; f1: number; dur: number; type: OscillatorType; gain: number; delay?: number }

const SOUNDS: Record<string, Voice[]> = {
  poke: [{ f0: 660, f1: 880, dur: 0.06, type: 'square', gain: 0.25 }],
  hop: [{ f0: 320, f1: 640, dur: 0.09, type: 'triangle', gain: 0.4 }],
  land: [{ f0: 150, f1: 70, dur: 0.1, type: 'sine', gain: 0.6 }],
  slap: [
    { f0: 1200, f1: 900, dur: 0.035, type: 'square', gain: 0.25 },
    { f0: 784, f1: 1046, dur: 0.12, type: 'triangle', gain: 0.35, delay: 0.04 },
  ],
  hello: [
    { f0: 523, f1: 523, dur: 0.08, type: 'triangle', gain: 0.35 },
    { f0: 784, f1: 784, dur: 0.12, type: 'triangle', gain: 0.35, delay: 0.09 },
  ],
  alert: [
    { f0: 880, f1: 880, dur: 0.07, type: 'square', gain: 0.18 },
    { f0: 880, f1: 880, dur: 0.07, type: 'square', gain: 0.18, delay: 0.12 },
  ],
  ask: [
    { f0: 523, f1: 523, dur: 0.06, type: 'triangle', gain: 0.3 },
    { f0: 659, f1: 659, dur: 0.06, type: 'triangle', gain: 0.3, delay: 0.07 },
    { f0: 784, f1: 830, dur: 0.1, type: 'triangle', gain: 0.3, delay: 0.14 },
  ],
  error: [
    { f0: 440, f1: 430, dur: 0.1, type: 'triangle', gain: 0.35 },
    { f0: 330, f1: 300, dur: 0.16, type: 'triangle', gain: 0.35, delay: 0.11 },
  ],
  wake: [
    { f0: 392, f1: 523, dur: 0.07, type: 'triangle', gain: 0.3 },
    { f0: 523, f1: 784, dur: 0.1, type: 'triangle', gain: 0.3, delay: 0.08 },
  ],
  interrupt: [{ f0: 700, f1: 500, dur: 0.07, type: 'triangle', gain: 0.3 }],
  done: [
    { f0: 523, f1: 523, dur: 0.07, type: 'triangle', gain: 0.3 },
    { f0: 659, f1: 659, dur: 0.07, type: 'triangle', gain: 0.3, delay: 0.08 },
    { f0: 1046, f1: 1046, dur: 0.16, type: 'triangle', gain: 0.3, delay: 0.16 },
  ],
}

export class Sounds {
  private ctx: AudioContext | null = null
  enabled = true
  volume = 0.45
  private last = new Map<string, number>()

  play(name: string): void {
    const voices = SOUNDS[name]
    if (!this.enabled || !voices || this.volume <= 0) return
    // Avoid machine-gunning the same sound.
    const now = performance.now()
    if (now - (this.last.get(name) ?? 0) < 90) return
    this.last.set(name, now)
    try {
      this.ctx ??= new AudioContext({ latencyHint: 'interactive' })
      const ctx = this.ctx
      if (ctx.state === 'suspended') void ctx.resume()
      const master = ctx.createGain()
      master.gain.value = 0.22 * this.volume
      master.connect(ctx.destination)
      for (const v of voices) {
        const t0 = ctx.currentTime + (v.delay ?? 0)
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = v.type
        osc.frequency.setValueAtTime(v.f0, t0)
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, v.f1), t0 + v.dur)
        g.gain.setValueAtTime(0.0001, t0)
        g.gain.exponentialRampToValueAtTime(v.gain, t0 + 0.008)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + v.dur)
        osc.connect(g).connect(master)
        osc.start(t0)
        osc.stop(t0 + v.dur + 0.02)
      }
    } catch {
      /* audio is optional */
    }
  }
}
