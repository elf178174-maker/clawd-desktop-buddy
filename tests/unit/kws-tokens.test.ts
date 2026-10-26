import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodePhrase, keywordsFile, loadPieceScores, loadVocab, phraseVariants } from '../../src/voice/kws-tokens'

const dir = path.resolve('models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01')
const have = fs.existsSync(path.join(dir, 'tokens.txt'))

describe.skipIf(!have)('wake-phrase BPE encoding', () => {
  const vocab = have ? loadVocab(fs.readFileSync(path.join(dir, 'tokens.txt'), 'utf8')) : new Map()
  const scores = have ? loadPieceScores(fs.readFileSync(path.join(dir, 'bpe.model'))) : new Map()

  it('reads the SentencePiece model', () => {
    expect(scores.size).toBe(vocab.size)
  })

  it('matches the tokenisation shipped with the model for every example phrase', () => {
    const raw = fs.readFileSync(path.join(dir, 'keywords_raw.txt'), 'utf8').split(/\r?\n/).filter(Boolean)
    const ref = fs.readFileSync(path.join(dir, 'keywords.txt'), 'utf8').split(/\r?\n/).filter(Boolean)
    expect(raw.length).toBe(ref.length)
    raw.forEach((phrase, i) => expect(encodePhrase(phrase, vocab, scores)?.join(' ')).toBe(ref[i].trim()))
  })

  it('encodes "Hey Clawd" and its sound-alike spellings', () => {
    const kw = keywordsFile('Hey Clawd', vocab, 0.5, scores)
    expect(kw.label).toBe('HEY_CLAWD')
    expect(kw.lines).toBe(phraseVariants('Hey Clawd').length)
    expect(kw.text).toMatch(/^▁HE Y ▁C/m)
    expect(kw.text).toContain('@HEY_CLAWD')
  })

  it('maps sensitivity to threshold and boost', () => {
    const low = keywordsFile('Hey Clawd', vocab, 0).text
    const high = keywordsFile('Hey Clawd', vocab, 1).text
    expect(low).toContain('#0.420')
    expect(high).toContain('#0.120')
    expect(high).toContain(':3.50')
  })
})

describe('phrase variants', () => {
  it('adds spoken-alike spellings for Clawd', () => {
    expect(phraseVariants('hey clawd')).toEqual(['HEY CLAWD', 'HEY CLAUDE', 'HEY CLAWED', 'HEY CLOD'])
  })
})
