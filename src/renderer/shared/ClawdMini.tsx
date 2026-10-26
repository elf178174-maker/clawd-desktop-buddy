// A small live Clawd for headers and previews, driven by the same animation engine as the overlay.

import { useEffect, useRef } from 'react'
import { ClawdEngine } from '../../character/engine'
import { drawRects } from '../../character/render'
import type { StateName } from '../../character/states'

export function ClawdMini({ scale = 2.4, state = 'idle', width = 40, height = 30, intensity = 1, snap = 'device', play }: { scale?: number; state?: StateName; width?: number; height?: number; intensity?: number; snap?: 'device' | 'art'; play?: { name: StateName; key: number } }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const engine = useRef<ClawdEngine | null>(null)
  useEffect(() => {
    const e = new ClawdEngine({ seed: 11, intensity, idleFrequency: 0.8, sitAfter: 0, napAfter: 0 })
    e.setBase('idle')
    engine.current = e
    const canvas = ref.current!
    const ctx = canvas.getContext('2d')!
    let raf = 0
    let last = performance.now()
    const tick = (t: number) => {
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(width * dpr)) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
      }
      const f = e.update({ dt: Math.min(0.1, (t - last) / 1000) })
      last = t
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      drawRects(ctx, [...f.geometry.rects.filter((r) => r.part !== 'shadow'), ...f.fx], { scale, dpr, originX: width / 2, originY: height - 2, snap })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [scale, width, height, snap])
  useEffect(() => {
    engine.current?.configure({ intensity })
  }, [intensity])
  useEffect(() => {
    engine.current?.setBase(state)
  }, [state])
  useEffect(() => {
    if (play) engine.current?.play(play.name)
  }, [play?.key])
  return <canvas ref={ref} style={{ width, height, display: 'block' }} aria-hidden />
}
