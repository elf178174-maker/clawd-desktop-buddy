// Web research and the user's browser: search, read public pages, and read whole pages from the
// browser through Clawd's extension (beyond the visible viewport).

import { clip } from '../store'
import { fail, ok, type AnyTool } from './types'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Parses DuckDuckGo's HTML results page. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const out: SearchResult[] = []
  const blocks = html.split(/class="result(?:\s|__body|")/)
  for (const b of blocks) {
    const a = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b)
    if (!a) continue
    let url = a[1]
    const m = /uddg=([^&]+)/.exec(url)
    if (m) url = decodeURIComponent(m[1])
    if (url.startsWith('//')) url = 'https:' + url
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/.exec(b)
    out.push({ title: decode(a[2]), url, snippet: sn ? decode(sn[1]) : '' })
  }
  const seen = new Set<string>()
  return out.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)))
}

export async function webSearch(query: string, max: number, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Clawd/0.1' },
    body: new URLSearchParams({ q: query, kl: 'wt-wt' }).toString(),
    signal,
  })
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status}).`)
  const html = await res.text()
  if (/anomaly|captcha|challenge/i.test(html) && !/result__a/.test(html))
    throw new Error('The search engine asked for a human check, which Clawd will not bypass. Try again later or give a URL directly.')
  return parseDuckDuckGo(html).slice(0, max)
}

export const webTools: AnyTool[] = [
  {
    name: 'web_search',
    description:
      'Searches the public web and returns result titles, URLs and snippets. Follow up with fetch_page to read sources. Cite URLs in your answer and separate what sources say from your own conclusions.',
    category: 'web',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 400 }, max_results: { type: 'integer', minimum: 1, maximum: 15 } },
      required: ['query'],
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: (a: { query: string }) => ({ title: 'Search the web', details: a.query }),
    timeoutSec: 25,
    async run(a: { query: string; max_results?: number }, ctx) {
      try {
        const results = await webSearch(a.query, a.max_results ?? 8, ctx.signal)
        if (!results.length) return fail('The search returned no results. Try different words.')
        const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n')
        return ok(text, { untrusted: 'web search results', summary: `${results.length} results for "${clip(a.query, 40)}"` })
      } catch (err) {
        return fail(`Web search failed: ${(err as Error).message}`)
      }
    },
  },
  {
    name: 'fetch_page',
    description:
      'Opens a public web page in a hidden, sandboxed browser and returns its readable text (the whole article, not just the visible part). Do not use it for pages that need the user to be signed in; use browser_get_page for their open tabs.',
    category: 'web',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', maxLength: 2000 }, max_chars: { type: 'integer', minimum: 1000, maximum: 120000 } },
      required: ['url'],
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: (a: { url: string }) => ({ title: 'Read a web page', details: a.url }),
    egress: (a: { url: string }) => [a.url],
    timeoutSec: 45,
    async run(a: { url: string; max_chars?: number }, ctx) {
      if (!/^https?:\/\//i.test(a.url)) return fail('Only http(s) URLs can be fetched.')
      try {
        const page = await ctx.host.call('web.fetchPage', a.url, a.max_chars ?? 40000)
        return ok(`Title: ${page.title}\nURL: ${page.url}${page.byline ? `\nBy: ${page.byline}` : ''}${page.truncated ? '\n(truncated)' : ''}\n\n${page.text}`, {
          untrusted: `web page ${page.url}`,
          summary: `${clip(page.title || page.url, 60)} (${page.text.length} chars)`,
        })
      } catch (err) {
        return fail(`Could not read ${a.url}: ${(err as Error).message}`)
      }
    },
  },
  {
    name: 'browser_get_page',
    description:
      "Reads the full content of a page open in the user's browser (default: the active tab) through Clawd's browser extension, including parts outside the viewport. Use for 'summarize this page'. Set scroll=true for pages that load content lazily.",
    category: 'browser',
    sendsContext: true,
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'integer', description: 'From browser_list_tabs; omit for the active tab.' },
        max_chars: { type: 'integer', minimum: 1000, maximum: 200000 },
        scroll: { type: 'boolean', description: 'Scroll through the page first to load lazy content.' },
      },
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: () => ({ title: 'Read the page in your browser', details: 'Full text of the open tab' }),
    available: (s) => (s.privacy.browserAccess && s.integrations.browser ? true : 'Browser access is turned off in Settings.'),
    timeoutSec: 60,
    async run(a: { tab_id?: number; max_chars?: number; scroll?: boolean }, ctx) {
      try {
        const page = await ctx.host.call('browser.getPage', a.tab_id ?? null, a.max_chars ?? 60000, !!a.scroll).catch(async (err: Error) => {
          // Without the extension, a public page can still be read from its URL in Clawd's own browser.
          const url = a.tab_id ? undefined : ctx.summon?.url
          if (!url) throw err
          ctx.progress('Reading the page from its address')
          const p = await ctx.host.call('web.fetchPage', url, a.max_chars ?? 60000)
          return { ...p, note: 'Read from the page address (signed-in-only content is not included).' }
        })
        const note = page.note ? `\nNote: ${page.note}` : ''
        return ok(`Title: ${page.title}\nURL: ${page.url}\nRead via: ${page.method}${page.truncated ? ' (truncated)' : ''}${note}\n\n${page.text}`, {
          untrusted: `browser page ${page.url}`,
          summary: `${clip(page.title || page.url, 60)} (${page.text.length} chars via ${page.method})`,
        })
      } catch (err) {
        return fail(`Could not read the browser page: ${(err as Error).message}`)
      }
    },
  },
  {
    name: 'browser_get_draft',
    description:
      "Reads what the user is currently writing in the browser: the text in the focused text box on the active page (for example their Reddit comment or reply). Use it for requests like 'refine my comment'.",
    category: 'browser',
    sendsContext: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    risk: () => 'low',
    describe: () => ({ title: 'Read your comment draft', details: 'The text box you are typing in' }),
    available: (s) => (s.privacy.browserAccess && s.integrations.browser ? true : 'Browser access is turned off in Settings.'),
    async run(_a, ctx) {
      const fromSummon = ctx.summon?.draft
      try {
        const d = await ctx.host.call('browser.getDraft').catch((err: Error) => {
          if (fromSummon) return { found: true, text: fromSummon, url: ctx.summon?.url ?? '', title: ctx.summon?.title ?? '' }
          throw err
        })
        if (!d.found || !d.text) {
          if (fromSummon) return ok(fromSummon, { untrusted: "the user's draft", summary: `${fromSummon.length} characters` })
          return fail('No text box with text is focused on the page. Ask the user to click into their comment, or to select the text.')
        }
        return ok(d.text, { untrusted: `the user's draft on ${d.url}`, summary: `${d.text.length} characters on ${clip(d.title, 40)}` })
      } catch (err) {
        return fail(`Could not read the draft: ${(err as Error).message}`)
      }
    },
  },
  {
    name: 'browser_list_tabs',
    description: "Lists the tabs open in the user's browser (needs Clawd's browser extension).",
    category: 'browser',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    risk: () => 'low',
    describe: () => ({ title: 'List your browser tabs', details: 'Titles and URLs of open tabs' }),
    available: (s) => (s.privacy.browserAccess && s.integrations.browser ? true : 'Browser access is turned off in Settings.'),
    async run(_a, ctx) {
      try {
        const tabs = await ctx.host.call('browser.listTabs')
        if (!tabs.length) return fail('No tabs were reported.')
        return ok(tabs.map((t) => `${t.active ? '* ' : '  '}[${t.id}] ${clip(t.title, 80)} - ${t.url}`).join('\n'), { untrusted: 'browser tab titles', summary: `${tabs.length} tabs` })
      } catch (err) {
        return fail(`Browser not connected: ${(err as Error).message}`)
      }
    },
  },
]
