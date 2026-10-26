// Path handling and safety rules for file tools.

import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../../shared/settings'

export function expandPath(p: string): string {
  let s = p.trim().replace(/^["']|["']$/g, '').trim()
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1))
  s = s.replace(/%([A-Z_][A-Z0-9_]*)%/gi, (m, name: string) => process.env[name] ?? m)
  // Network paths would reach out (and offer the Windows login hash) before anyone is asked.
  if (/^[\\/]{2}/.test(s)) throw new Error(`Network paths are not supported (${clipPath(s)}). Copy the file to this PC first.`)
  return path.resolve(s)
}

const clipPath = (s: string) => (s.length > 80 ? s.slice(0, 80) + '…' : s)

export function defaultRoots(): string[] {
  const home = os.homedir()
  return ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Music', 'Videos', 'source', 'Projects', 'dev', 'code'].map((d) => path.join(home, d)).concat(['C:\\claude'])
}

export function allowedRoots(settings: Settings, extra: string[] = []): string[] {
  const roots = settings.permissions.fileRoots.length ? settings.permissions.fileRoots.map(expandPath) : defaultRoots()
  return [...roots, ...extra.map(expandPath)]
}

const norm = (p: string) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '')

export function isInside(child: string, root: string): boolean {
  const c = norm(child)
  const r = norm(root)
  return c === r || c.startsWith(r + path.sep)
}

const SYSTEM_DIRS = [process.env.SystemRoot ?? 'C:\\Windows', process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', process.env.ProgramData ?? 'C:\\ProgramData']

/** Locations Clawd never writes to. */
export function isProtected(p: string): boolean {
  const n = norm(p)
  if (SYSTEM_DIRS.some((d) => isInside(n, d))) return true
  if (/^[a-z]:$/i.test(n) || /^[a-z]:\\$/i.test(path.resolve(p))) return true // drive roots
  return false
}

/** Files likely to hold credentials; reading them needs explicit approval. */
export function isSensitive(p: string): boolean {
  const n = norm(p)
  return /[\\/](\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker)([\\/]|$)/.test(n) || /(\.env|\.pem|\.key|\.pfx|\.p12|credentials|id_rsa|id_ed25519|\.netrc|\.npmrc|\.pypirc|secrets?\.(json|ya?ml|txt))$/.test(n) || /appdata[\\/]roaming[\\/]microsoft[\\/](credentials|protect)/.test(n)
}

export function approvalReasons(p: string, settings: Settings, mode: 'read' | 'write', extraRoots: string[] = []): string[] {
  const reasons: string[] = []
  if (!allowedRoots(settings, extraRoots).some((r) => isInside(p, r))) reasons.push('outside your allowed folders')
  if (isSensitive(p)) reasons.push('may contain credentials')
  if (mode === 'write' && isProtected(p)) reasons.push('is a protected system location')
  return reasons
}
