// Small rotating logger. Never logs secrets or user content: callers pass short descriptions.

import fs from 'node:fs'
import path from 'node:path'
import { subdir } from './paths'

type Level = 'debug' | 'info' | 'warn' | 'error'
const MAX_BYTES = 2_000_000
const tail: string[] = []
let file: string | null = null

function target(): string {
  if (!file) file = path.join(subdir('logs'), 'clawd.log')
  return file
}

function rotate(f: string): void {
  try {
    if (fs.existsSync(f) && fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, f.replace(/\.log$/, '.1.log'))
  } catch {
    /* rotation is best effort */
  }
}

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${extra !== undefined ? ' ' + safe(extra) : ''}`
  tail.push(line)
  if (tail.length > 400) tail.shift()
  if (level === 'error' || level === 'warn' || process.env.CLAWD_DEBUG) console[level === 'debug' ? 'log' : level](line)
  try {
    const f = target()
    rotate(f)
    fs.appendFileSync(f, line + '\n')
  } catch {
    /* logging must never throw */
  }
}

function safe(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`
  try {
    const s = JSON.stringify(v)
    return s.length > 600 ? s.slice(0, 600) + '…' : s
  } catch {
    return String(v)
  }
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => write('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => write('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => write('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => write('error', scope, msg, extra),
  }
}

export function logTail(n = 120): string[] {
  return tail.slice(-n)
}
