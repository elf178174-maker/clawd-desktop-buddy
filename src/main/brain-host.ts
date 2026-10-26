// Starts and supervises the agent service (an Electron utility process) and implements the host
// capabilities it calls back for. If the service crashes it is restarted; the UI keeps working.

import { utilityProcess, type UtilityProcess } from 'electron'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { HostApi } from '../shared/host'
import { RpcPeer, type RpcMessage } from '../shared/rpc'
import type { Settings } from '../shared/settings'
import type { AgentEvent } from '../shared/types'
import { logger } from './log'

const log = logger('brain')

export type HostImpl = { [K in keyof HostApi]: (...args: Parameters<HostApi[K]>) => ReturnType<HostApi[K]> | Promise<ReturnType<HostApi[K]>> }

export class BrainHost extends EventEmitter {
  private child: UtilityProcess | null = null
  private rpc: RpcPeer
  private ready: Promise<void>
  private markReady!: () => void
  private restarts = 0
  private stopping = false
  alive = false

  constructor(
    private dataDir: string,
    private builtinSkills: string | null,
    private getSettings: () => Settings,
    hostImpl: HostImpl,
  ) {
    super()
    this.rpc = new RpcPeer((m) => this.child?.postMessage(m))
    const handlers: Record<string, (...args: never[]) => unknown> = {}
    for (const [name, fn] of Object.entries(hostImpl)) handlers[`host:${name}`] = fn as (...args: never[]) => unknown
    this.rpc.setHandlers(handlers)
    this.rpc.onEvent((event, data) => {
      if (event === 'agent') this.emit('agent', data as AgentEvent)
    })
    this.ready = new Promise((r) => (this.markReady = r))
  }

  start(): void {
    const entry = path.join(__dirname, 'brain.js')
    this.child = utilityProcess.fork(entry, [], { serviceName: 'Clawd Agent', stdio: 'pipe' })
    this.child.stdout?.on('data', (b: Buffer) => log.debug(b.toString().trim()))
    this.child.stderr?.on('data', (b: Buffer) => log.warn(b.toString().trim()))
    this.child.on('message', (m: RpcMessage) => {
      if (m && (m as { t?: string }).t === 'evt' && (m as { e?: string }).e === 'ready') {
        void this.init()
        return
      }
      void this.rpc.receive(m)
    })
    this.child.on('exit', (code) => {
      this.alive = false
      this.rpc.failAll('The agent service stopped.')
      this.emit('status', false)
      if (this.stopping) return
      log.error('agent service exited; restarting', { code })
      this.ready = new Promise((r) => (this.markReady = r))
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.restarts++, 5))
      setTimeout(() => this.start(), delay)
    })
  }

  private async init(): Promise<void> {
    try {
      const res = (await this.rpc.call('init', [{ dataDir: this.dataDir, builtinSkills: this.builtinSkills, settings: this.getSettings() }], 30000)) as { interrupted: { id: string; request: string }[] }
      this.alive = true
      this.restarts = 0
      this.markReady()
      this.emit('status', true)
      if (res.interrupted.length) this.emit('interrupted', res.interrupted)
      log.info('agent service ready')
    } catch (err) {
      log.error('agent init failed', err)
    }
  }

  async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    await Promise.race([this.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('The agent service is not available.')), 20000))])
    return this.rpc.call<T>(method, args)
  }

  pushSettings(s: Settings): void {
    if (this.alive) void this.rpc.call('settings', [s]).catch(() => {})
  }

  stop(): void {
    this.stopping = true
    this.child?.kill()
  }
}
