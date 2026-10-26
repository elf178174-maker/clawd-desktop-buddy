// Planning, clarification, memory and skills tools.

import { MemoryError } from '../memory'
import type { MemoryKind, PlanItem } from '../../shared/types'
import { fail, ok, type AnyTool } from './types'

const KINDS = ['preference', 'fact', 'project', 'workflow', 'correction', 'note'] as const

export const metaTools: AnyTool[] = [
  {
    name: 'update_plan',
    description:
      'Shows the user your plan for a multi-step task and keeps it current: call it at the start of any task needing three or more steps, and again as steps finish. Statuses: pending, active, done, failed, skipped.',
    category: 'meta',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            properties: { text: { type: 'string', maxLength: 160 }, status: { type: 'string', enum: ['pending', 'active', 'done', 'failed', 'skipped'] } },
            required: ['text', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: () => ({ title: 'Update the plan', details: '' }),
    async run(a: { items: PlanItem[] }, ctx) {
      ctx.setPlan(a.items)
      return ok('Plan updated.', { summary: `${a.items.filter((i) => i.status === 'done').length}/${a.items.length} done` })
    },
  },
  {
    name: 'ask_user',
    description:
      'Asks the user a clarifying question and waits for the answer. Use only when you truly cannot proceed (missing information, ambiguous target, a choice only they can make). Offer short options when possible.',
    category: 'meta',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', maxLength: 500 }, options: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 80 } } },
      required: ['question'],
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: (a: { question: string }) => ({ title: 'Ask you a question', details: a.question }),
    timeoutSec: 3600,
    async run(a: { question: string; options?: string[] }, ctx) {
      const answer = await ctx.ask(a.question, a.options)
      return ok(`The user answered: ${answer}`)
    },
  },
  {
    name: 'memory_search',
    description: 'Searches what Clawd remembers about the user (preferences, projects, workflows, corrections).',
    category: 'meta',
    parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 300 } }, required: ['query'], additionalProperties: false },
    risk: () => 'low',
    describe: (a: { query: string }) => ({ title: 'Search memory', details: a.query }),
    available: (s) => (s.memory.enabled ? true : 'Memory is turned off in Settings > Memory.'),
    async run(a: { query: string }, ctx) {
      const hits = ctx.memory.search(a.query, 8)
      if (!hits.length) return ok('Nothing relevant is remembered.')
      for (const h of hits) if (!ctx.task.memoriesUsed.some((m) => m.id === h.item.id)) ctx.task.memoriesUsed.push({ id: h.item.id, text: h.item.text })
      return ok(hits.map((h) => `[${h.item.id}] (${h.item.kind}) ${h.item.text}`).join('\n'))
    },
  },
  {
    name: 'memory_save',
    description:
      'Remembers a durable fact for future conversations: a preference, a correction to your behaviour, a project or workflow, or something the user explicitly asked you to remember. Never store passwords, keys or other secrets, and do not store one-off details of the current task.',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 800 }, kind: { type: 'string', enum: KINDS } },
      required: ['text', 'kind'],
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: (a: { text: string }) => ({ title: 'Remember something', details: a.text }),
    // Saving without the user's review must not let injected text persist into later tasks.
    escalateWhenTainted: (_a, ctx) => ctx.settings.memory.autoRemember === 'auto',
    available: (s) => (s.memory.enabled && s.memory.autoRemember !== 'off' ? true : 'Saving memories is turned off in Settings > Memory.'),
    async run(a: { text: string; kind: MemoryKind }, ctx) {
      if (ctx.settings.memory.autoRemember === 'ask') {
        ctx.proposeMemory(a.text, a.kind)
        return ok('Proposed to the user; it is saved only if they accept.', { summary: 'Proposed a memory' })
      }
      try {
        const m = ctx.memory.add(a.text, a.kind, 'agent')
        return ok(`Saved as ${m.id}.`, { summary: 'Saved a memory' })
      } catch (err) {
        return fail(err instanceof MemoryError ? err.message : String(err))
      }
    },
  },
  {
    name: 'memory_update',
    description: 'Corrects an existing memory (use the id from memory_search) when it is outdated or wrong.',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', maxLength: 60 }, text: { type: 'string', maxLength: 800 } },
      required: ['id', 'text'],
      additionalProperties: false,
    },
    risk: () => 'medium',
    describe: (a: { id: string; text: string }) => ({ title: 'Change a memory', details: `${a.id}: ${a.text}` }),
    available: (s) => (s.memory.enabled ? true : 'Memory is turned off in Settings > Memory.'),
    async run(a: { id: string; text: string }, ctx) {
      try {
        ctx.memory.update(a.id, { text: a.text })
        return ok('Memory updated.')
      } catch (err) {
        return fail((err as Error).message)
      }
    },
  },
  {
    name: 'memory_delete',
    description: 'Forgets a memory by id (when the user asks you to forget something).',
    category: 'memory',
    parameters: { type: 'object', properties: { id: { type: 'string', maxLength: 60 } }, required: ['id'], additionalProperties: false },
    risk: () => 'medium',
    describe: (a: { id: string }) => {
      return { title: 'Forget a memory', details: a.id }
    },
    available: (s) => (s.memory.enabled ? true : 'Memory is turned off in Settings > Memory.'),
    async run(a: { id: string }, ctx) {
      return ctx.memory.remove(a.id) ? ok('Forgotten.') : fail('No memory with that id.')
    },
  },
  {
    name: 'use_skill',
    description:
      "Loads the full instructions of one of the user's installed skills (listed in your instructions). Use it when a skill matches the request, then follow its guidance using your normal tools.",
    category: 'meta',
    parameters: { type: 'object', properties: { name: { type: 'string', maxLength: 100 } }, required: ['name'], additionalProperties: false },
    risk: () => 'low',
    describe: (a: { name: string }) => ({ title: 'Use a skill', details: a.name }),
    async run(a: { name: string }, ctx) {
      const s = ctx.skills.instructions(a.name)
      if (!s) return fail(`No enabled skill named "${a.name}". Available: ${ctx.skills.enabled().map((x) => x.name).join(', ') || 'none'}.`)
      if (!ctx.task.skillsUsed.includes(s.info.name)) ctx.task.skillsUsed.push(s.info.name)
      const tools = s.info.tools.length ? `\nThis skill expects these tools: ${s.info.tools.join(', ')}.` : ''
      return ok(`<skill name="${s.info.name}" version="${s.info.version}">\n${s.body}\n</skill>${tools}\nThe skill gives guidance only; every action still goes through your normal tools and the user's permissions.`, {
        summary: `Loaded skill ${s.info.name}`,
      })
    },
  },
]
