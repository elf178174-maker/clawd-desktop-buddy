// Tool calling for models without native function calling: tools are described in the prompt and
// the model replies with a fenced ```tool block, which is parsed here.

import type { Message, ToolCall, ToolSpec } from '../providers/types'
import { textOf } from '../providers/types'

export function promptedToolsText(tools: ToolSpec[]): string {
  const list = tools.map((t) => `### ${t.name}\n${t.description}\nArguments (JSON Schema): ${JSON.stringify(t.parameters)}`).join('\n\n')
  return `Tools: you cannot call functions natively, so use this protocol. To use a tool, reply with ONLY one block like:
\`\`\`tool
{"name": "tool_name", "arguments": { ... }}
\`\`\`
You will receive the result in the next message. Call one tool per reply. When you have the final answer, reply normally without any tool block.

${list}`
}

/** Extracts a tool call from model text (```tool blocks, or <tool_call> tags some models emit). */
export function parsePromptedCall(text: string): { call: ToolCall | null; rest: string } {
  const patterns = [/```tool\s*\n([\s\S]*?)```/i, /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i, /```json\s*\n(\{\s*"name"[\s\S]*?)```/i]
  for (const re of patterns) {
    const m = re.exec(text)
    if (!m) continue
    try {
      const obj = JSON.parse(m[1]) as { name?: string; arguments?: unknown; args?: unknown; parameters?: unknown }
      if (!obj.name) continue
      const args = (obj.arguments ?? obj.args ?? obj.parameters ?? {}) as Record<string, unknown>
      return { call: { id: `pt_${Date.now().toString(36)}`, name: String(obj.name), args: typeof args === 'object' && args ? args : {} }, rest: text.replace(m[0], '').trim() }
    } catch (err) {
      return { call: { id: `pt_${Date.now().toString(36)}`, name: '__invalid__', args: {}, parseError: `Could not parse the tool block: ${(err as Error).message}` }, rest: text }
    }
  }
  return { call: null, rest: text }
}

/** Rewrites native tool turns into plain text turns for prompted mode. */
export function toPromptedMessages(messages: Message[]): Message[] {
  return messages.map((m): Message => {
    if (m.role === 'assistant' && m.toolCalls?.length)
      return { role: 'assistant', content: `${m.content}\n\`\`\`tool\n${JSON.stringify({ name: m.toolCalls[0].name, arguments: m.toolCalls[0].args })}\n\`\`\`` }
    if (m.role === 'tool') return { role: 'user', content: `Result of ${m.name}${m.isError ? ' (error)' : ''}:\n${textOf(m.content)}` }
    return m
  })
}
