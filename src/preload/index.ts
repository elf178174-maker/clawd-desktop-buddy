// Preload bridge: exposes a narrow, allow-listed IPC surface to the sandboxed renderers.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS, OVERLAY_EVENT_CHANNELS, OVERLAY_SEND_CHANNELS } from '../shared/api'

const invokeOk = new Set<string>(INVOKE_CHANNELS)
const eventOk = new Set<string>([...EVENT_CHANNELS, ...OVERLAY_EVENT_CHANNELS])
const sendOk = new Set<string>(OVERLAY_SEND_CHANNELS)

// The audio window receives a MessagePort for streaming audio to and from the voice service.
ipcRenderer.on('voice-port', (e) => window.postMessage('voice-port', '*', e.ports))

contextBridge.exposeInMainWorld('clawd', {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!invokeOk.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  send(channel: string, payload: unknown): void {
    if (sendOk.has(channel)) ipcRenderer.send(channel, payload)
  },
  on(channel: string, cb: (payload: unknown) => void): () => void {
    if (!eventOk.has(channel)) return () => {}
    const fn = (_e: IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, fn)
    return () => ipcRenderer.off(channel, fn)
  },
  platform: process.platform,
})
