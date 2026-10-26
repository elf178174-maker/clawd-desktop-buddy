// Persistent memory: durable preferences and facts, kept apart from conversation history.
// Searchable with a small BM25-style scorer; secrets are refused outright.

import path from 'node:path'
import type { MemoryItem, MemoryKind } from '../shared/types'
import { looksSecret, newId, readJson, writeJson } from './store'

const STOP = new Set('a an and are as at be by for from has have i in is it its me my of on or our so that the their this to was we were what when where which who will with you your about into than then them they how can do does not no yes'.split(' '))

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w))
}

export class MemoryError extends Error {}

export class MemoryStore {
  private items: MemoryItem[]
  private file: string

  constructor(dir: string) {
    this.file = path.join(dir, 'memory.json')
    this.items = readJson<MemoryItem[]>(this.file, [])
  }

  private save(): void {
    writeJson(this.file, this.items)
  }

  list(query?: string): MemoryItem[] {
    if (!query?.trim()) return [...this.items].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
    return this.search(query, 50).map((r) => r.item)
  }

  get(id: string): MemoryItem | undefined {
    return this.items.find((m) => m.id === id)
  }

  add(text: string, kind: MemoryKind = 'note', source: 'user' | 'agent' = 'user', tags: string[] = []): MemoryItem {
    const clean = text.trim().replace(/\s+/g, ' ')
    if (!clean) throw new MemoryError('Memory text is empty.')
    if (clean.length > 1000) throw new MemoryError('Memories must be short (under 1000 characters).')
    if (looksSecret(clean)) throw new MemoryError('That looks like a password, key or card number. Clawd does not store credentials in memory.')
    // Update a near-duplicate instead of piling up copies.
    const dup = this.search(clean, 1)[0]
    if (dup && dup.score > 0.92) return this.update(dup.item.id, { text: clean, kind })
    const now = Date.now()
    const item: MemoryItem = { id: newId('mem'), text: clean, kind, tags, createdAt: now, updatedAt: now, useCount: 0, source }
    this.items.push(item)
    this.save()
    return item
  }

  update(id: string, patch: Partial<Pick<MemoryItem, 'text' | 'kind' | 'tags' | 'pinned'>>): MemoryItem {
    const m = this.items.find((x) => x.id === id)
    if (!m) throw new MemoryError('That memory no longer exists.')
    if (patch.text !== undefined) {
      const clean = patch.text.trim()
      if (!clean) throw new MemoryError('Memory text is empty.')
      if (looksSecret(clean)) throw new MemoryError('That looks like a credential; it was not stored.')
      m.text = clean
    }
    if (patch.kind) m.kind = patch.kind
    if (patch.tags) m.tags = patch.tags
    if (patch.pinned !== undefined) m.pinned = patch.pinned
    m.updatedAt = Date.now()
    this.save()
    return m
  }

  remove(id: string): boolean {
    const n = this.items.length
    this.items = this.items.filter((m) => m.id !== id)
    if (this.items.length !== n) this.save()
    return this.items.length !== n
  }

  clear(): void {
    this.items = []
    this.save()
  }

  /** Drops memories untouched for longer than the retention period (pinned ones are kept). */
  prune(retentionDays: number): number {
    if (!retentionDays) return 0
    const cutoff = Date.now() - retentionDays * 86_400_000
    const before = this.items.length
    this.items = this.items.filter((m) => m.pinned || (m.lastUsedAt ?? m.updatedAt) >= cutoff)
    if (this.items.length !== before) this.save()
    return before - this.items.length
  }

  /** Ranked search; score is in [0, 1]. */
  search(query: string, k = 6): { item: MemoryItem; score: number }[] {
    const q = tokenize(query)
    if (!q.length) return []
    const docs = this.items.map((m) => ({ m, toks: tokenize(m.text + ' ' + m.tags.join(' ') + ' ' + m.kind) }))
    const N = docs.length || 1
    const df = new Map<string, number>()
    for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) ?? 0) + 1)
    const avg = docs.reduce((s, d) => s + d.toks.length, 0) / N || 1
    const scored = docs.map(({ m, toks }) => {
      let s = 0
      for (const t of new Set(q)) {
        const tf = toks.filter((x) => x === t).length
        if (!tf) continue
        const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))
        s += (idf * (tf * 2.2)) / (tf + 1.2 * (0.25 + 0.75 * (toks.length / avg)))
      }
      // Preferences and corrections apply broadly: give them a small boost.
      if (s > 0 && (m.kind === 'preference' || m.kind === 'correction')) s *= 1.15
      if (m.pinned && s > 0) s *= 1.1
      return { item: m, raw: s }
    })
    const max = Math.max(...scored.map((x) => x.raw), 1e-9)
    // Exact phrase match counts as a near-certain hit.
    const ql = query.toLowerCase().trim()
    return scored
      .filter((x) => x.raw > 0)
      .map((x) => ({ item: x.item, score: x.item.text.toLowerCase() === ql ? 1 : Math.min(0.99, (x.raw / max) * (q.length > 1 ? 0.9 : 0.8)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
  }

  /** Memories relevant to a request, plus pinned ones; marks them as used. */
  relevant(request: string, k = 6): MemoryItem[] {
    const hits = this.search(request, k).filter((h) => h.score > 0.25).map((h) => h.item)
    const pinned = this.items.filter((m) => m.pinned && !hits.includes(m)).slice(0, 4)
    const out = [...pinned, ...hits].slice(0, k + 2)
    const now = Date.now()
    for (const m of out) {
      m.lastUsedAt = now
      m.useCount++
    }
    if (out.length) this.save()
    return out
  }
}
