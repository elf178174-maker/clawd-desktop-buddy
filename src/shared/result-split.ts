// Splits a model answer into the deliverable text and an optional side note, so "Copy" and
// "Put in comment box" only ever use the finished text.

export interface SplitResult {
  text: string
  note?: string
}

const PREAMBLE = /^(?:\s*(?:sure|okay|ok|alright|of course|certainly|absolutely|got it)[,.!]?\s*)?(?:[^\n]{0,200}?)?(?:here(?:'s| is| are)\b[^\n]*|(?:refined|rewritten|revised|improved|polished|shorter|updated|translated|edited) (?:version|comment|reply|text|draft)[^\n]*):\s*\n+/i

/** A side note is a sentence or two; anything longer is part of the answer. */
const NOTE_MAX = 300

export function splitResult(answer: string, writing = true): SplitResult {
  const raw = answer.trim()
  // Only writing tasks have a deliverable to separate; elsewhere the tags are just noise.
  if (!writing) return { text: raw.replace(/<\/?(result|note)>/gi, '').replace(/\n{3,}/g, '\n\n').trim() }
  const m = /<result>\s*([\s\S]*?)\s*<\/result>/i.exec(raw)
  if (m) {
    const rest = (raw.slice(0, m.index) + '\n\n' + raw.slice(m.index + m[0].length)).replace(/<\/?note>/gi, '').trim()
    const note = rest.replace(/\s+/g, ' ')
    const text = unquote(m[1])
    // Small models sometimes write the text twice (once outside the tags): that is not a note.
    if (!note || nearDuplicate(note, text)) return { text }
    return note.length > NOTE_MAX ? { text: `${text}\n\n${rest}` } : { text, note }
  }
  // Fallback: a lead-in line ending in a colon ("Here's a refined version:") is a note, not the text.
  const p = PREAMBLE.exec(raw)
  if (p && raw.length - p[0].length > 20) {
    const rest = raw.slice(p[0].length)
    const lead = p[0].trim().replace(/:$/, '.')
    const tail = /\n\s*\n\s*(note:[\s\S]*)$/i.exec(rest)
    const body = tail ? rest.slice(0, tail.index) : rest
    return { text: unquote(body), note: [lead, tail?.[1]].filter(Boolean).join(' ') }
  }
  const tail = /\n\s*\n\s*(note:[\s\S]*)$/i.exec(raw)
  if (tail && tail.index > 20) return { text: unquote(raw.slice(0, tail.index)), note: tail[1].trim() }
  return { text: raw }
}

function nearDuplicate(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])
  const wa = words(a)
  const wb = words(b)
  if (!wa.size) return true
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  return shared / wa.size > 0.7
}

/** Removes quotes or a code fence the model may have wrapped around the whole text. */
function unquote(s: string): string {
  let t = s.trim()
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t)
  if (fence) t = fence[1].trim()
  if (/^["“].*["”]$/s.test(t) && !/["“”]/.test(t.slice(1, -1))) t = t.slice(1, -1).trim()
  return t
}
