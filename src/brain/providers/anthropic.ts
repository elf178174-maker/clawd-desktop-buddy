// Anthropic Messages API through the official SDK. One provider among several: nothing about
// Clawd depends on it. Assistant turns are echoed back unchanged (thinking blocks included),
// depth is controlled with output_config.effort, and refusals fall back server-side.

import Anthropic from '@anthropic-ai/sdk'
import { ProviderError, type Capabilities, type ChatRequest, type ChatResult, type ContentPart, type Message, type ModelProvider, type ToolCall } from './types'

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5'
/** Models that accept `fallbacks: "default"` (server-side refusal fallback). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5-5'])

type Block = Anthropic.Beta.BetaContentBlockParam

function partsToBlocks(content: string | ContentPart[]): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content || '(empty)' }]
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text || '(empty)' }
      : { type: 'image', source: { type: 'base64', media_type: p.mime as 'image/png', data: p.data } },
  )
}

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic' as const
  readonly label = 'Anthropic'
  readonly local = false
  readonly model: string
  private client: Anthropic
  private caps: Capabilities | null = null

  constructor(baseUrl: string, model: string, apiKey: string | null) {
    if (!apiKey) throw new ProviderError('No Anthropic API key is set. Add one in Settings > AI.', 'auth')
    this.model = model || ANTHROPIC_DEFAULT_MODEL
    this.client = new Anthropic({ apiKey, baseURL: baseUrl || undefined, maxRetries: 2 })
  }

  async capabilities(): Promise<Capabilities> {
    if (this.caps) return this.caps
    let contextTokens: number | undefined
    try {
      const info = (await this.client.models.retrieve(this.model)) as unknown as { max_input_tokens?: number }
      contextTokens = info.max_input_tokens
    } catch (err) {
      throw this.mapError(err)
    }
    this.caps = { tools: true, vision: true, contextTokens }
    return this.caps
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = []
    try {
      for await (const m of this.client.models.list()) ids.push(m.id)
    } catch (err) {
      throw this.mapError(err)
    }
    return ids
  }

  private toWire(messages: Message[]): Anthropic.Beta.BetaMessageParam[] {
    const out: Anthropic.Beta.BetaMessageParam[] = []
    let pendingResults: Anthropic.Beta.BetaToolResultBlockParam[] = []
    const flush = () => {
      if (pendingResults.length) out.push({ role: 'user', content: pendingResults })
      pendingResults = []
    }
    for (const m of messages) {
      if (m.role === 'tool') {
        pendingResults.push({
          type: 'tool_result',
          tool_use_id: m.callId,
          content: partsToBlocks(m.content) as Anthropic.Beta.BetaToolResultBlockParam['content'],
          is_error: m.isError || undefined,
        })
        continue
      }
      flush()
      if (m.role === 'user') out.push({ role: 'user', content: partsToBlocks(m.content) })
      else if (m.raw && m.raw.provider === 'anthropic') {
        // Echo the provider's own content unchanged, thinking blocks included.
        out.push({ role: 'assistant', content: m.raw.value as Block[] })
      } else {
        const blocks: Block[] = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args })
        out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '(no text)' }] })
      }
    }
    flush()
    return out
  }

  private mapError(err: unknown): Error {
    if ((err as Error)?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError) return err as Error
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
      return new ProviderError('Anthropic rejected the API key. Check it in Settings > AI.', 'auth')
    if (err instanceof Anthropic.NotFoundError) return new ProviderError(`Anthropic does not know the model "${this.model}".`, 'not_found')
    if (err instanceof Anthropic.RateLimitError) return new ProviderError('Anthropic is rate limiting requests.', 'rate_limit', true)
    if (err instanceof Anthropic.BadRequestError) {
      const msg = (err as Error).message
      return new ProviderError(`Anthropic rejected the request: ${msg.slice(0, 240)}`, /context|too long|prompt is too long/i.test(msg) ? 'context' : 'bad_request')
    }
    if (err instanceof Anthropic.APIConnectionError) return new ProviderError('Could not reach Anthropic. Check the network connection.', 'network', true)
    if (err instanceof Anthropic.InternalServerError) return new ProviderError('Anthropic had a server error.', 'unavailable', true)
    if (err instanceof Anthropic.APIError) return new ProviderError(`Anthropic error ${err.status}: ${err.message.slice(0, 200)}`, 'unknown')
    return err instanceof Error ? err : new Error(String(err))
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const effort = req.reasoning === 'off' ? 'low' : req.reasoning
    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: req.maxTokens ?? 32000,
      stream: true,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: this.toWire(req.messages),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
        // Large inputs stream as generated; the registry validates every input before running.
        eager_input_streaming: true,
      })),
      output_config: { effort },
    }
    if (FALLBACK_MODELS.has(this.model)) {
      params.betas = ['server-side-fallback-2026-07-01']
      params.fallbacks = 'default'
    }
    let final: Anthropic.Beta.BetaMessage
    try {
      const { stream: _s, ...body } = params
      const stream = this.client.beta.messages.stream(body, { signal: req.signal })
      stream.on('text', (delta) => req.onText?.(delta))
      final = await stream.finalMessage()
    } catch (err) {
      throw this.mapError(err)
    }
    if (final.stop_reason === 'refusal') {
      throw new ProviderError('The model declined this request.', 'refusal')
    }
    let text = ''
    const calls: ToolCall[] = []
    for (const b of final.content) {
      if (b.type === 'text') text += b.text
      else if (b.type === 'tool_use') {
        const input = b.input
        const ok = input && typeof input === 'object' && !Array.isArray(input)
        calls.push({ id: b.id, name: b.name, args: ok ? (input as Record<string, unknown>) : {}, parseError: ok ? undefined : 'Tool input was not a JSON object' })
      }
    }
    const truncated = final.stop_reason === 'max_tokens'
    return {
      text,
      // A response cut off at max_tokens may carry truncated tool input: do not run it.
      toolCalls: truncated ? [] : calls,
      stop: truncated ? 'length' : calls.length ? 'tool_calls' : 'stop',
      raw: { provider: 'anthropic', model: this.model, value: final.content },
      usage: { input: final.usage.input_tokens, output: final.usage.output_tokens },
      servedBy: final.model,
    }
  }
}
