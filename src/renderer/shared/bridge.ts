// Typed access to the preload bridge for every renderer.

import type { EventChannel, Events, InvokeChannel, Invokes, OverlayEvents, OverlaySends } from '../../shared/api'

interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, payload: unknown): void
  on(channel: string, cb: (payload: unknown) => void): () => void
  platform: string
}

declare global {
  interface Window {
    clawd: Bridge
  }
}

export function invoke<K extends InvokeChannel>(channel: K, ...args: Parameters<Invokes[K]>): Promise<Awaited<ReturnType<Invokes[K]>>> {
  return window.clawd.invoke(channel, ...args) as Promise<Awaited<ReturnType<Invokes[K]>>>
}

export function on<K extends EventChannel>(channel: K, cb: (payload: Events[K]) => void): () => void {
  return window.clawd.on(channel, cb as (p: unknown) => void)
}

export function onOverlay<K extends keyof OverlayEvents>(channel: K, cb: (payload: OverlayEvents[K]) => void): () => void {
  return window.clawd.on(channel, cb as (p: unknown) => void)
}

export function sendOverlay<K extends keyof OverlaySends>(channel: K, payload: OverlaySends[K]): void {
  window.clawd.send(channel, payload)
}

export function sendBubbleAction(bubbleId: string, actionId: string): void {
  window.clawd.send('bubble:action', { bubbleId, actionId })
}
