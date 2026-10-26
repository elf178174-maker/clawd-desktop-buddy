// OpenAI Chat Completions, which also covers OpenAI-compatible services (OpenRouter, Groq,
// LM Studio, vLLM, llama.cpp server...). Streams over SSE and assembles tool-call deltas.

import type { ProviderId } from '../../shared/settings'
import { fetchOrThrow, parseArgs, readLines, textOf, type Capabilities, type ChatRequest, type ChatResult, type Message, type ModelProvider, type ToolCall } from './types'

type WireContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]

interface WireMsg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: WireContent | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export class OpenAIProvider implements ModelProvider {
  readonly local: boolean

  constructor(
    readonly id: ProviderId,
    readonly label: string,
    private baseUrl: string,
    readonly model: string,
    private apiKey: string | null,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.local = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(this.baseUrl)
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`
    return h
  }

  async capabilities(): Promise<Capabilities> {
    // Chat Completions has no capability endpoint; assume tools and let vision degrade gracefully.
    const m = this.model.toLowerCase()
    const vision = /gpt-4o|gpt-4\.1|gpt-5|o3|o4|vision|vl|llava|gemma-3|qwen.*vl|pixtral|claude|gemini/.test(m)
    return { tools: true, vision }
  }

  async listModels(): Promise<string[]> {
    const res = await fetchOrThrow(this.label, `${this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(8000) })
    const data = (await res.json()) as { data?: { id: string }[] }
    return (data.data ?? []).map((m) => m.id).sort()
  }

  private toWire(system: string, messages: Message[]): WireMsg[] {
    const out: WireMsg[] = [{ role: 'system', content: system }]
    for (const m of messages) {
      if (m.role === 'user') {
        out.push({
          role: 'user',
          content:
            typeof m.content === 'string'
              ? m.content
              : m.content.map((p) => (p.type === 'text' ? { type: 'text' as const, text: p.text } : { type: 'image_url' as const, image_url: { url: `data:${p.mime};base64,${p.data}` } })),
        })
      } else if (m.role === 'assistant') {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls?.length ? m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) : undefined,
        })
      } else {
        // Tool messages are text-only on this API; images follow as a user message.
        out.push({ role: 'tool', tool_call_id: m.callId, content: textOf(m.content) })
        if (typeof m.content !== 'string') {
          const imgs = m.content.filter((p) => p.type === 'image')
          if (imgs.length)
            out.push({ role: 'user', content: [{ type: 'text', text: `(Image returned by ${m.name})` }, ...imgs.map((p) => ({ type: 'image_url' as const, image_url: { url: `data:${(p as { mime: string }).mime};base64,${(p as { data: string }).data}` } }))] })
        }
      }
    }
    return out
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.toWire(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (req.tools.length) body.tools = req.tools.map((t) => ({ type: 'function', function: t }))
    const reasoningModel = /^(o\d|gpt-5)/i.test(this.model)
    if (reasoningModel && this.id === 'openai') {
      if (req.reasoning !== 'off') body.reasoning_effort = req.reasoning
    } else body.temperature = req.temperature
    if (req.maxTokens) body.max_completion_tokens = req.maxTokens
    const res = await fetchOrThrow(this.label, `${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    })
    let text = ''
    const parts = new Map<number, { id: string; name: string; args: string }>()
    let finish = ''
    let usage: ChatResult['usage']
    for await (const line of readLines(res, req.signal)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') break
      let chunk: {
        choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[]
        usage?: { prompt_tokens: number; completion_tokens: number }
      }
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }
      if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens }
      const choice = chunk.choices?.[0]
      if (!choice) continue
      if (choice.delta?.content) {
        text += choice.delta.content
        req.onText?.(choice.delta.content)
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const cur = parts.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        parts.set(tc.index, cur)
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }
    const calls: ToolCall[] = [...parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, p]) => {
        const { args, parseError } = parseArgs(p.args)
        return { id: p.id || `call_${i}`, name: p.name, args, parseError }
      })
    return {
      text,
      toolCalls: calls,
      stop: calls.length ? 'tool_calls' : finish === 'length' ? 'length' : finish === 'content_filter' ? 'refusal' : 'stop',
      usage,
      servedBy: this.model,
    }
  }
}
