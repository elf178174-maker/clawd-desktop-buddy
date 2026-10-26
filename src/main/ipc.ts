// Typed registration of the renderer -> main IPC handlers.

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Invokes } from '../shared/api'
import { logger } from './log'

const log = logger('ipc')

export type Handlers = { [K in keyof Invokes]: (...args: Parameters<Invokes[K]>) => ReturnType<Invokes[K]> | Promise<ReturnType<Invokes[K]>> }

export function registerIpc(handlers: Handlers, isTrusted: (e: IpcMainInvokeEvent) => boolean): void {
  for (const [channel, fn] of Object.entries(handlers) as [keyof Invokes, (...a: unknown[]) => unknown][]) {
    ipcMain.handle(channel, async (e, ...args) => {
      if (!isTrusted(e)) throw new Error('Untrusted sender')
      try {
        return await fn(...args)
      } catch (err) {
        log.warn(`${channel} failed`, String((err as Error)?.message ?? err))
        throw err
      }
    })
  }
}
