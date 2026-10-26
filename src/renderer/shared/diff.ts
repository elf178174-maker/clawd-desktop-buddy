// Word-level diff (LCS) for comparing an original text with Clawd's revision.

export type DiffPart = { kind: 'same' | 'add' | 'del'; text: string }

function tokens(s: string): string[] {
  return s.match(/\s+|[\p{L}\p{N}'’-]+|[^\s\p{L}\p{N}]/gu) ?? []
}

export function wordDiff(a: string, b: string): DiffPart[] {
  const x = tokens(a)
  const y = tokens(b)
  // Fall back to a coarse diff for very long texts to keep this cheap.
  if (x.length * y.length > 4_000_000) return [{ kind: 'del', text: a }, { kind: 'add', text: b }]
  const n = x.length
  const m = y.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffPart[] = []
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push('same', x[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', x[i++])
    else push('add', y[j++])
  }
  while (i < n) push('del', x[i++])
  while (j < m) push('add', y[j++])
  return out
}
