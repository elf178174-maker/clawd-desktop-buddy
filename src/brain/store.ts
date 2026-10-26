// JSON persistence helpers for the agent service (plain Node: no Electron APIs here).

import fs from 'node:fs'
import path from 'node:path'

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    // Keep the damaged file for inspection and start fresh.
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* ignore */
    }
    return fallback
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1))
  try {
    fs.renameSync(tmp, file)
  } catch {
    fs.writeFileSync(file, JSON.stringify(value, null, 1))
    fs.rmSync(tmp, { force: true })
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** Shortens text for logs and UI without cutting surrogate pairs. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return Array.from(text.slice(0, max)).join('') + `… [${text.length - max} more characters]`
}

/** Patterns that look like credentials; such text is never stored in memory or logs. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-z0-9_-]{16,}/i,
  /sk-ant-[a-z0-9_-]{10,}/i,
  /AIza[0-9A-Za-z_-]{30,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /xox[abpr]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pwd|passcode|api[_ -]?key|secret|token)\s*[:=]\s*\S{4,}/i,
  /\b(?:\d[ -]?){13,19}\b/, // card-like digit runs
]

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((r) => r.test(text))
}

export function redactSecrets(text: string): string {
  let out = text
  for (const r of SECRET_PATTERNS) out = out.replace(new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g'), '[redacted]')
  return out
}
