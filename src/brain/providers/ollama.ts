// Ollama (local models) through its native /api/chat endpoint, which supports tools, images,
// thinking control and a configurable context window.

import { fetchOrThrow, ProviderError, readLines, textOf, type Capabilities, type ChatRequest, type ChatResult, type Message, type ModelProvider, type ToolCall } from './types'

interface OllamaMsg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[]
  tool_name?: string
  thinking?: string
}

export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama' as const
  readonly label = 'Ollama (local)'
  readonly local: boolean
  private caps: Capabilities | null = null

  constructor(
    private baseUrl: string,
    readonly model: string,
    private numCtx: number,
    private keepAlive: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.local = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(this.baseUrl)
  }

  async capabilities(): Promise<Capabilities> {
    if (this.caps) return this.caps
    const res = await fetchOrThrow('Ollama', `${this.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model }),
      signal: AbortSignal.timeout(8000),
    }).catch((err) => {
      if (err instanceof ProviderError && err.kind === 'not_found')
        throw new ProviderError(`The model "${this.model}" is not installed in Ollama. Run: ollama pull ${this.model}`, 'not_found')
      throw err
    })
    const info = (await res.json()) as { capabilities?: string[]; model_info?: Record<string, unknown> }
    const capsList = info.capabilities ?? []
    const ctxKey = Object.keys(info.model_info ?? {}).find((k) => k.endsWith('.context_length'))
    this.caps = {
      tools: capsList.includes('tools'),
      vision: capsList.includes('vision'),
      contextTokens: Math.min(this.numCtx, Number(ctxKey ? info.model_info![ctxKey] : this.numCtx) || this.numCtx),
    }
    return this.caps
  }

  async listModels(): Promise<string[]> {
    const res = await fetchOrThrow('Ollama', `${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(6000) })
    const data = (await res.json()) as { models?: { name: string }[] }
    return (data.models ?? []).map((m) => m.name).sort()
  }

  private toWire(system: string, messages: Message[]): OllamaMsg[] {
    const out: OllamaMsg[] = [{ role: 'system', content: system }]
    for (const m of messages) {
      if (m.role === 'user') {
        if (typeof m.content === 'string') out.push({ role: 'user', content: m.content })
        else
          out.push({
            role: 'user',
            content: m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n'),
            images: m.content.filter((p) => p.type === 'image').map((p) => (p as { data: string }).data),
          })
      } else if (m.role === 'assistant') {
        out.push({
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls?.map((c) => ({ function: { name: c.name, arguments: c.args } })),
        })
      } else {
        const images = typeof m.content === 'string' ? [] : m.content.filter((p) => p.type === 'image').map((p) => (p as { data: string }).data)
        out.push({ role: 'tool', tool_name: m.name, content: textOf(m.content), ...(images.length ? { images } : {}) })
      }
    }
    return out
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const caps = await this.capabilities()
    const body = {
      model: this.model,
      messages: this.toWire(req.system, req.messages),
      tools: caps.tools && req.tools.length ? req.tools.map((t) => ({ type: 'function', function: t })) : undefined,
      stream: true,
      think: req.reasoning === 'off' ? false : true,
      keep_alive: this.keepAlive,
      options: { temperature: req.temperature, num_ctx: this.numCtx },
    }
    const res = await fetchOrThrow('Ollama', `${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    }).catch((err) => {
      if (err instanceof ProviderError && err.kind === 'not_found')
        throw new ProviderError(`The model "${this.model}" is not installed in Ollama. Run: ollama pull ${this.model}`, 'not_found')
      throw err
    })
    let text = ''
    const calls: ToolCall[] = []
    let doneReason = ''
    let usage: ChatResult['usage']
    for await (const line of readLines(res, req.signal)) {
      if (!line.trim()) continue
      let chunk: { message?: OllamaMsg; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number; error?: string }
      try {
        chunk = JSON.parse(line)
      } catch {
        continue
      }
      if (chunk.error) throw new ProviderError(`Ollama: ${chunk.error}`, /context/i.test(chunk.error) ? 'context' : 'unknown')
      const msg = chunk.message
      if (msg?.content) {
        text += msg.content
        req.onText?.(msg.content)
      }
      for (const tc of msg?.tool_calls ?? []) {
        const args = tc.function.arguments
        calls.push({
          id: `call_${calls.length + 1}_${Date.now().toString(36)}`,
          name: tc.function.name,
          args: args && typeof args === 'object' ? args : {},
          parseError: args && typeof args === 'object' ? undefined : 'Arguments were not an object',
        })
      }
      if (chunk.done) {
        doneReason = chunk.done_reason ?? ''
        usage = { input: chunk.prompt_eval_count ?? 0, output: chunk.eval_count ?? 0 }
      }
    }
    return {
      text,
      toolCalls: calls,
      stop: calls.length ? 'tool_calls' : doneReason === 'length' ? 'length' : 'stop',
      usage,
      servedBy: this.model,
    }
  }
}
