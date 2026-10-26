// The provider-independent model interface. Clawd's identity, tools, memory and skills sit above
// this layer, so switching the model never changes who Clawd is.

import type { ProviderId } from '../../shared/settings'

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mime: string; data: string }

export interface ToolCall {
  id: string
  name: string
  /** Parsed arguments; `parseError` is set when the model produced invalid JSON. */
  args: Record<string, unknown>
  parseError?: string
}

export type Message =
  | { role: 'user'; content: string | ContentPart[] }
  | {
      role: 'assistant'
      content: string
      toolCalls?: ToolCall[]
      /** Provider-native assistant content to echo back unchanged (e.g. thinking blocks). */
      raw?: { provider: ProviderId; model: string; value: unknown }
    }
  | { role: 'tool'; callId: string; name: string; content: string | ContentPart[]; isError?: boolean }

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema (object). */
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  system: string
  messages: Message[]
  tools: ToolSpec[]
  temperature: number
  reasoning: 'off' | 'low' | 'medium' | 'high'
  signal: AbortSignal
  /** Streams visible answer text as it is produced. */
  onText?: (delta: string) => void
  maxTokens?: number
}

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  stop: 'stop' | 'tool_calls' | 'length' | 'refusal' | 'other'
  raw?: { provider: ProviderId; model: string; value: unknown }
  usage?: { input: number; output: number }
  /** Model that actually served the request (fallbacks may change it). */
  servedBy?: string
}

export interface Capabilities {
  tools: boolean
  vision: boolean
  contextTokens?: number
}

export interface ModelProvider {
  readonly id: ProviderId
  readonly label: string
  readonly local: boolean
  readonly model: string
  capabilities(): Promise<Capabilities>
  chat(req: ChatRequest): Promise<ChatResult>
  listModels(): Promise<string[]>
}

/** Errors the agent can explain to the user and maybe recover from. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public kind: 'auth' | 'rate_limit' | 'unavailable' | 'not_found' | 'bad_request' | 'context' | 'network' | 'refusal' | 'unknown',
    public retryable = false,
    public retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** Classifies an HTTP status into a ProviderError. */
export function httpError(provider: string, status: number, body: string, retryAfter?: string | null): ProviderError {
  const snippet = body.replace(/\s+/g, ' ').slice(0, 240)
  const after = retryAfter ? Number(retryAfter) * 1000 : undefined
  if (status === 401 || status === 403) return new ProviderError(`${provider} rejected the credentials (${status}). Check the API key in Settings > AI.`, 'auth')
  if (status === 404) return new ProviderError(`${provider} could not find that model or endpoint (404): ${snippet}`, 'not_found')
  if (status === 429) return new ProviderError(`${provider} is rate limiting requests. Clawd will retry shortly.`, 'rate_limit', true, after)
  if (status === 400 && /context|too long|maximum.*tokens|token limit/i.test(body))
    return new ProviderError(`The conversation is too long for this model's context window.`, 'context')
  if (status === 400 || status === 422) return new ProviderError(`${provider} rejected the request (${status}): ${snippet}`, 'bad_request')
  if (status >= 500) return new ProviderError(`${provider} had a server error (${status}).`, 'unavailable', true, after)
  return new ProviderError(`${provider} returned ${status}: ${snippet}`, 'unknown')
}

/** Wraps fetch so network failures become ProviderErrors with a clear message. */
export async function fetchOrThrow(provider: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    if (provider === 'Ollama') throw new ProviderError(`Ollama isn't running (nothing answered at ${new URL(url).origin}). Start Ollama, then try again.`, 'network', true)
    throw new ProviderError(`Could not reach ${provider} at ${new URL(url).origin} (${(err as Error).message}).`, 'network', true)
  }
  if (!res.ok) throw httpError(provider, res.status, await res.text().catch(() => ''), res.headers.get('retry-after'))
  return res
}

/** Reads a fetch body as lines (NDJSON or SSE). */
export async function* readLines(res: Response, signal: AbortSignal): AsyncGenerator<string> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        yield line
      }
    }
    if (buf.trim()) yield buf
  } finally {
    reader.releaseLock()
  }
}

export function parseArgs(text: string | undefined | null): { args: Record<string, unknown>; parseError?: string } {
  if (!text || !text.trim()) return { args: {} }
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? { args: v } : { args: {}, parseError: 'Arguments were not a JSON object' }
  } catch (err) {
    return { args: {}, parseError: `Invalid JSON arguments: ${(err as Error).message}` }
  }
}

export function textOf(content: string | ContentPart[]): string {
  return typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n')
}
