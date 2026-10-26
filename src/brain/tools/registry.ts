// The tool registry: the single list of capabilities the agent may use. Adding a tool means adding
// a ToolDef to a module here; the agent loop discovers it through its schema and description.

import type { Settings } from '../../shared/settings'
import type { ToolSpec } from '../providers/types'
import { claudeCodeTools } from './claude-code'
import { contextTools } from './context'
import { fileTools } from './files'
import { metaTools } from './meta'
import { systemTools } from './system'
import type { AnyTool } from './types'
import { webTools } from './web'

export class ToolRegistry {
  private tools = new Map<string, AnyTool>()

  constructor(extra: AnyTool[] = []) {
    for (const t of [...metaTools, ...contextTools, ...webTools, ...fileTools, ...systemTools, ...claudeCodeTools, ...extra]) this.register(t)
  }

  register(tool: AnyTool): void {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(tool.name)) throw new Error(`Bad tool name ${tool.name}`)
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name)
  }

  names(): string[] {
    return [...this.tools.keys()]
  }

  /** Tools usable under the current settings, plus the reasons the others are unavailable. */
  available(settings: Settings): { tools: AnyTool[]; unavailable: { name: string; reason: string }[] } {
    const tools: AnyTool[] = []
    const unavailable: { name: string; reason: string }[] = []
    for (const t of this.tools.values()) {
      const ok = t.available ? t.available(settings) : true
      const denied = t.category !== 'meta' && settings.permissions.rules[t.category] === 'deny'
      if (ok === true && !denied) tools.push(t)
      else unavailable.push({ name: t.name, reason: ok === true ? `The "${t.category}" permission is set to Deny.` : ok })
    }
    return { tools, unavailable }
  }

  specs(tools: AnyTool[]): ToolSpec[] {
    return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> }))
  }
}
