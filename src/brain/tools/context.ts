// Desktop context: the active window, selected text, accessible window text, UI elements,
// screenshots, and pointing at things with Clawd's own cursor.

import { clip } from '../store'
import { fail, ok, type AnyTool } from './types'

export const contextTools: AnyTool[] = [
  {
    name: 'get_active_context',
    description:
      'Returns which application and window the user is working in (app name, window title, browser URL when known). Cheap; use it to understand references like "this page" or "this error".',
    category: 'context',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    risk: () => 'low',
    describe: () => ({ title: 'Look at the active window', details: 'App name and window title' }),
    available: (s) => (s.privacy.screenAwareness ? true : 'Screen awareness is turned off in Settings > Privacy.'),
    async run(_a, ctx) {
      const c = await ctx.host.call('context.active')
      if (!c.available) return fail(c.note ?? 'The active window could not be determined.')
      return ok(JSON.stringify({ app: c.app, title: c.title, url: c.url, bounds: c.bounds }, null, 1), { summary: `${c.app}: ${clip(c.title, 60)}` })
    },
  },
  {
    name: 'get_selected_text',
    description:
      'Returns the text the user had selected when they summoned Clawd (or the current selection if fresh=true). Use this for requests like "rewrite this", "explain this", "translate this". If nothing is available, ask the user to paste the text.',
    category: 'context',
    sendsContext: true,
    parameters: {
      type: 'object',
      properties: { fresh: { type: 'boolean', description: 'Read the selection now instead of the one captured at summon time.' } },
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: () => ({ title: 'Read your selected text', details: 'The text selected in the active app' }),
    available: (s) => (s.privacy.screenAwareness ? true : 'Screen awareness is turned off in Settings > Privacy.'),
    async run(a: { fresh?: boolean }, ctx) {
      const sel = await ctx.host.call('context.selection', !!a.fresh)
      if (!sel.text) return fail(sel.note ?? 'No selected text could be read from the active application. Ask the user to paste the text.')
      return ok(sel.text, { untrusted: `selected text in ${sel.app ?? 'the active app'}`, summary: `${sel.text.length} characters (${sel.method})` })
    },
  },
  {
    name: 'read_window_text',
    description:
      'Reads the visible, accessible text of the active window through Windows UI Automation (documents, dialogs, error messages, editors). Not every app exposes its text; if this fails consider take_screenshot.',
    category: 'context',
    sendsContext: true,
    parameters: {
      type: 'object',
      properties: { max_chars: { type: 'integer', minimum: 500, maximum: 60000, description: 'Default 20000.' } },
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: () => ({ title: 'Read the active window', details: 'Accessible text of the window in front' }),
    available: (s) => (s.privacy.screenAwareness ? true : 'Screen awareness is turned off in Settings > Privacy.'),
    timeoutSec: 20,
    async run(a: { max_chars?: number }, ctx) {
      const r = await ctx.host.call('context.windowText', a.max_chars ?? 20000)
      if (!r.text.trim()) return fail(r.note ?? `"${r.app}" does not expose readable text. A screenshot may work instead.`)
      return ok(`Window: ${r.app} - ${r.title}${r.truncated ? ' (truncated)' : ''}\n\n${r.text}`, { untrusted: `window "${r.title}"`, summary: `${r.text.length} characters from ${r.app}` })
    },
  },
  {
    name: 'list_ui_elements',
    description:
      'Lists controls in the active window (buttons, fields, menu items, links) with their screen rectangles. Filter with a query. Use it to find a setting the user is looking for, then point_at it.',
    category: 'context',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200, description: 'Words to match against control names (optional).' },
        max: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: (a: { query?: string }) => ({ title: 'Inspect controls in the active window', details: a.query ? `Looking for "${a.query}"` : 'All visible controls' }),
    available: (s) => (s.privacy.screenAwareness ? true : 'Screen awareness is turned off in Settings > Privacy.'),
    timeoutSec: 20,
    async run(a: { query?: string; max?: number }, ctx) {
      const r = await ctx.host.call('context.elements', a.query ?? '', a.max ?? 60)
      if (!r.elements.length) return fail(r.note ?? `No matching controls found in ${r.app}.`)
      const lines = r.elements.map((e) => `- ${e.type} "${clip(e.name, 80)}"${e.value ? ` = "${clip(e.value, 60)}"` : ''} at [${Math.round(e.rect.x)},${Math.round(e.rect.y)},${Math.round(e.rect.w)}x${Math.round(e.rect.h)}]${e.enabled === false ? ' (disabled)' : ''}`)
      return ok(`Controls in ${r.app}:\n${lines.join('\n')}`, { untrusted: `UI of ${r.app}`, summary: `${r.elements.length} controls` })
    },
  },
  {
    name: 'take_screenshot',
    description:
      'Captures the screen or the active window as an image so you can see it. Only works when the model supports images. Prefer read_window_text or list_ui_elements when text is enough.',
    category: 'screen',
    sendsContext: true,
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', enum: ['window', 'screen'], description: 'Default: window.' } },
      additionalProperties: false,
    },
    risk: () => 'medium',
    describe: (a: { target?: string }) => ({ title: 'Take a screenshot', details: a.target === 'screen' ? 'The whole screen' : 'The active window' }),
    available: (s) => (s.privacy.screenAwareness ? true : 'Screen awareness is turned off in Settings > Privacy.'),
    timeoutSec: 20,
    async run(a: { target?: 'window' | 'screen' }, ctx) {
      if (!ctx.vision) return fail('The current model cannot read images, so a screenshot would not help. Use read_window_text or list_ui_elements instead.')
      const shot = await ctx.host.call('context.screenshot', a.target ?? 'window', 1568)
      return ok(`Screenshot of the ${a.target ?? 'active window'} (${shot.width}x${shot.height}).${shot.note ? ' ' + shot.note : ''}`, {
        images: [{ mime: shot.mime, data: shot.data }],
        untrusted: 'screenshot',
        summary: `${shot.width}x${shot.height} image`,
      })
    },
  },
  {
    name: 'point_at',
    description:
      "Shows the user where something is: Clawd's own pointer flies to a control and highlights it (the real mouse is not moved). Give a query matching a control name in the active window, or explicit screen coordinates.",
    category: 'context',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200, description: 'Name of the control to point at.' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        label: { type: 'string', maxLength: 80, description: 'Short caption shown under the highlight.' },
      },
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: (a: { query?: string }) => ({ title: 'Point at something on screen', details: a.query ?? 'A screen location' }),
    async run(a: { query?: string; x?: number; y?: number; w?: number; h?: number; label?: string }, ctx) {
      let rect: { x: number; y: number; w: number; h: number } | null = null
      let name = ''
      if (a.query) {
        const r = await ctx.host.call('context.elements', a.query, 8)
        const best = r.elements.find((e) => e.rect.w > 2 && e.rect.h > 2)
        if (!best) return fail(`Could not find a control matching "${a.query}" in ${r.app}.`)
        rect = best.rect
        name = `${best.type} "${best.name}"`
      } else if (a.x !== undefined && a.y !== undefined) {
        rect = { x: a.x, y: a.y, w: a.w ?? 24, h: a.h ?? 24 }
        name = `(${a.x}, ${a.y})`
      } else return fail('Give either a query or x and y.')
      const shown = await ctx.host.call('pointer.point', rect, a.label, 5)
      if (!shown) return fail(`${name} is on a different display from Clawd, so he cannot point at it.`)
      return ok(`Pointing at ${name}.`, { summary: `Pointed at ${name}` })
    },
  },
]
