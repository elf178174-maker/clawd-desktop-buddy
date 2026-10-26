// Minimal bidirectional RPC over any message channel (utility process parentPort, MessagePort).

type Handler = (...args: never[]) => unknown

export type RpcMessage =
  | { t: 'req'; id: number; m: string; a: unknown[] }
  | { t: 'res'; id: number; ok: true; v: unknown }
  | { t: 'res'; id: number; ok: false; e: { message: string; name?: string; kind?: string } }
  | { t: 'evt'; e: string; d: unknown }

export class RpcPeer {
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>()
  private eventHandlers = new Set<(event: string, data: unknown) => void>()

  constructor(
    private post: (msg: RpcMessage) => void,
    private handlers: Record<string, Handler> = {},
  ) {}

  setHandlers(h: Record<string, Handler>): void {
    this.handlers = { ...this.handlers, ...h }
  }

  async receive(msg: RpcMessage): Promise<void> {
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'evt') {
      for (const h of this.eventHandlers) h(msg.e, msg.d)
      return
    }
    if (msg.t === 'res') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (p.timer) clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.v)
      else {
        const err = new Error(msg.e.message)
        err.name = msg.e.name ?? 'Error'
        ;(err as Error & { kind?: string }).kind = msg.e.kind
        p.reject(err)
      }
      return
    }
    const fn = this.handlers[msg.m] as ((...a: unknown[]) => unknown) | undefined
    try {
      if (!fn) throw new Error(`No handler for ${msg.m}`)
      const v = await fn(...msg.a)
      this.post({ t: 'res', id: msg.id, ok: true, v })
    } catch (err) {
      const e = err as Error & { kind?: string }
      this.post({ t: 'res', id: msg.id, ok: false, e: { message: e?.message ?? String(err), name: e?.name, kind: e?.kind } })
    }
  }

  call<T = unknown>(method: string, args: unknown[] = [], timeoutMs = 0): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const entry: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> } = {
        resolve: resolve as (v: unknown) => void,
        reject,
      }
      if (timeoutMs > 0)
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)} s`))
        }, timeoutMs)
      this.pending.set(id, entry)
      this.post({ t: 'req', id, m: method, a: args })
    })
  }

  emit(event: string, data: unknown): void {
    this.post({ t: 'evt', e: event, d: data })
  }

  onEvent(fn: (event: string, data: unknown) => void): () => void {
    this.eventHandlers.add(fn)
    return () => this.eventHandlers.delete(fn)
  }

  /** Rejects every in-flight call (the other side went away). */
  failAll(reason: string): void {
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error(reason))
      this.pending.delete(id)
    }
  }
}
