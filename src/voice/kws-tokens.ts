// Turns a wake phrase into the token sequence the keyword spotter expects. The gigaspeech model
// uses a SentencePiece unigram vocabulary: the best segmentation maximises the sum of piece scores
// (read from bpe.model). A plain BPE merge pass over tokens.txt is the fallback.

/** Reads piece -> score from a SentencePiece ModelProto (minimal protobuf decoding). */
export function loadPieceScores(buf: Uint8Array): Map<string, number> {
  const scores = new Map<string, number>()
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const dec = new TextDecoder()
  let p = 0
  const varint = (): number => {
    let r = 0
    let shift = 0
    for (;;) {
      const b = buf[p++]
      r += (b & 0x7f) * 2 ** shift
      if (!(b & 0x80)) return r
      shift += 7
    }
  }
  const skip = (wire: number) => {
    if (wire === 0) varint()
    else if (wire === 1) p += 8
    else if (wire === 2) {
      const len = varint() // read first: `p += varint()` would use the old p
      p += len
    }
    else if (wire === 5) p += 4
    else throw new Error('Unsupported protobuf wire type')
  }
  while (p < buf.length) {
    const tag = varint()
    const field = Math.floor(tag / 8)
    const wire = tag & 7
    if (field === 1 && wire === 2) {
      const len = varint()
      const end = p + len
      let piece = ''
      let score = 0
      while (p < end) {
        const t = varint()
        const f = Math.floor(t / 8)
        const w = t & 7
        if (f === 1 && w === 2) {
          const l = varint()
          piece = dec.decode(buf.subarray(p, p + l))
          p += l
        } else if (f === 2 && w === 5) {
          score = view.getFloat32(p, true)
          p += 4
        } else skip(w)
      }
      if (piece) scores.set(piece, score)
    } else skip(wire)
  }
  return scores
}

/** Best-scoring unigram segmentation of one word (with the word-start marker). */
export function segmentUnigram(word: string, scores: Map<string, number>): string[] | null {
  const s = '▁' + word
  const n = s.length
  const best = new Array<number>(n + 1).fill(-Infinity)
  const back = new Array<number>(n + 1).fill(-1)
  best[0] = 0
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - 16); j < i; j++) {
      if (best[j] === -Infinity) continue
      const sc = scores.get(s.slice(j, i))
      if (sc === undefined) continue
      if (best[j] + sc > best[i]) {
        best[i] = best[j] + sc
        back[i] = j
      }
    }
  }
  if (best[n] === -Infinity) return null
  const out: string[] = []
  for (let i = n; i > 0; i = back[i]) out.unshift(s.slice(back[i], i))
  return out
}

export function loadVocab(tokensTxt: string): Map<string, number> {
  const vocab = new Map<string, number>()
  for (const line of tokensTxt.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\d+)$/.exec(line.trim())
    if (m) vocab.set(m[1], Number(m[2]))
  }
  return vocab
}

/** BPE-encodes one word (already upper-cased) with the SentencePiece word-start marker. */
export function encodeWord(word: string, vocab: Map<string, number>): string[] | null {
  let syms = ['▁' + word[0], ...word.slice(1).split('')]
  // A bare "▁X" may not exist; fall back to "▁" + "X".
  if (!vocab.has(syms[0])) syms = ['▁', ...word.split('')]
  for (const s of syms) if (!vocab.has(s)) return null
  while (syms.length > 1) {
    let best = -1
    let bestRank = Infinity
    for (let i = 0; i < syms.length - 1; i++) {
      const rank = vocab.get(syms[i] + syms[i + 1])
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank
        best = i
      }
    }
    if (best < 0) break
    syms = [...syms.slice(0, best), syms[best] + syms[best + 1], ...syms.slice(best + 2)]
  }
  return syms
}

export function encodePhrase(phrase: string, vocab: Map<string, number>, scores?: Map<string, number>): string[] | null {
  const words = phrase
    .toUpperCase()
    .replace(/[^A-Z' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return null
  const out: string[] = []
  for (const w of words) {
    const t = scores?.size ? segmentUnigram(w, scores) : encodeWord(w, vocab)
    if (!t) return null
    out.push(...t)
  }
  return out
}

/**
 * Spellings of the same spoken wake phrase. The spotter matches sounds, and "Clawd" is pronounced
 * like "Claude" and "clawed", so those spellings of the same sound are listened for too.
 */
export function phraseVariants(phrase: string): string[] {
  const base = phrase.toUpperCase().replace(/[^A-Z' ]+/g, ' ').replace(/\s+/g, ' ').trim()
  const variants = new Set([base])
  if (/\bCLAWD\b/.test(base)) for (const alt of ['CLAUDE', 'CLAWED', 'CLOD']) variants.add(base.replace(/\bCLAWD\b/, alt))
  return [...variants]
}

/**
 * Builds a sherpa-onnx keywords file. Each line: tokens :boost #threshold @LABEL.
 * Higher sensitivity lowers the trigger threshold and raises the boost.
 */
export function keywordsFile(phrase: string, vocab: Map<string, number>, sensitivity: number, scores?: Map<string, number>): { text: string; label: string; lines: number } {
  const s = Math.min(1, Math.max(0, sensitivity))
  const threshold = (0.42 - 0.3 * s).toFixed(3)
  const boost = (1.0 + 2.5 * s).toFixed(2)
  const label = phrase.toUpperCase().replace(/[^A-Z]+/g, '_').replace(/^_|_$/g, '') || 'WAKE'
  const lines: string[] = []
  for (const v of phraseVariants(phrase)) {
    const toks = encodePhrase(v, vocab, scores)
    if (toks) lines.push(`${toks.join(' ')} :${boost} #${threshold} @${label}`)
  }
  return { text: lines.join('\n') + '\n', label, lines: lines.length }
}
