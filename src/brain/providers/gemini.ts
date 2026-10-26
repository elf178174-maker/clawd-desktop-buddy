// Google Gemini through the Generative Language REST API (streamGenerateContent over SSE).
// Model turns are echoed back verbatim so thought signatures survive tool-call round trips.

import { fetchOrThrow, readLines, textOf, type Capabilities, type ChatRequest, type ChatResult, type Message, type ModelProvider, type ToolCall } from './types'

type Part = Record<string, unknown>
interface Content {
  role: 'user' | 'model'
  parts: Part[]
}

/** Gemini accepts an OpenAPI subset: strip keywords it rejects. */
function sanitizeSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(sanitizeSchema)
  if (!s || typeof s !== 'object') return s
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === 'additionalProperties' || k === '$schema' || k === 'default' || k === 'examples') continue
    out[k] = sanitizeSchema(v)
  }
  return out
}

export class GeminiProvider implements ModelProvider {
  readonly id = 'gemini' as const
  readonly label = 'Google Gemini'
  readonly local = false

  constructor(
    private baseUrl: string,
    readonly model: string,
    private apiKey: string | null,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey ?? '' }
  }

  async capabilities(): Promise<Capabilities> {
    return { tools: true, vision: true }
  }

  async listModels(): Promise<string[]> {
    const res = await fetchOrThrow('Gemini', `${this.baseUrl}/models?pageSize=200`, { headers: this.headers(), signal: AbortSignal.timeout(8000) })
    const data = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] }
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .sort()
  }

  private toWire(messages: Message[]): Content[] {
    const out: Content[] = []
    const push = (role: Content['role'], parts: Part[]) => {
      const last = out[out.length - 1]
      if (last && last.role === role) last.parts.push(...parts)
      else out.push({ role, parts })
    }
    for (const m of messages) {
      if (m.role === 'user') {
        push('user', typeof m.content === 'string' ? [{ text: m.content }] : m.content.map((p) => (p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mime, data: p.data } })))
      } else if (m.role === 'assistant') {
        if (m.raw?.provider === 'gemini') push('model', m.raw.value as Part[])
        else {
          const parts: Part[] = []
          if (m.content) parts.push({ text: m.content })
          for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args } })
          push('model', parts.length ? parts : [{ text: '' }])
        }
      } else {
        const parts: Part[] = [{ functionResponse: { name: m.name, response: { content: textOf(m.content), error: m.isError || undefined } } }]
        if (typeof m.content !== 'string') for (const p of m.content) if (p.type === 'image') parts.push({ inlineData: { mimeType: p.mime, data: p.data } })
        push('user', parts)
      }
    }
    return out
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: this.toWire(req.messages),
      generationConfig: {
        temperature: req.temperature,
        ...(req.reasoning !== 'off' ? { thinkingConfig: { thinkingLevel: req.reasoning === 'medium' ? 'high' : req.reasoning } } : {}),
      },
    }
    if (req.tools.length) body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: sanitizeSchema(t.parameters) })) }]
    const res = await fetchOrThrow('Gemini', `${this.baseUrl}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    })
    let text = ''
    const calls: ToolCall[] = []
    const rawParts: Part[] = []
    let finish = ''
    let usage: ChatResult['usage']
    for await (const line of readLines(res, req.signal)) {
      if (!line.startsWith('data:')) continue
      let chunk: { candidates?: { content?: { parts?: Part[] }; finishReason?: string }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }
      try {
        chunk = JSON.parse(line.slice(5))
      } catch {
        continue
      }
      const cand = chunk.candidates?.[0]
      for (const p of cand?.content?.parts ?? []) {
        rawParts.push(p)
        if (typeof p.text === 'string' && !p.thought) {
          text += p.text
          req.onText?.(p.text)
        }
        const fc = p.functionCall as { name: string; args?: Record<string, unknown> } | undefined
        if (fc) calls.push({ id: `gem_${calls.length}_${Date.now().toString(36)}`, name: fc.name, args: fc.args ?? {} })
      }
      if (cand?.finishReason) finish = cand.finishReason
      if (chunk.usageMetadata) usage = { input: chunk.usageMetadata.promptTokenCount ?? 0, output: chunk.usageMetadata.candidatesTokenCount ?? 0 }
    }
    return {
      text,
      toolCalls: calls,
      stop: calls.length ? 'tool_calls' : finish === 'MAX_TOKENS' ? 'length' : finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' ? 'refusal' : 'stop',
      raw: { provider: 'gemini', model: this.model, value: rawParts },
      usage,
      servedBy: this.model,
    }
  }
}
