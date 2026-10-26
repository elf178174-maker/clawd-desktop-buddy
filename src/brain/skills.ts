// Personal skills library. A skill is a folder with a SKILL.md (front matter + instructions).
// Skills are guidance for the agent: they never run code by themselves. Scripts inside a skill
// are flagged and can only run through the normal, permission-checked tools.

import fs from 'node:fs'
import path from 'node:path'
import type { SkillInfo } from '../shared/types'
import { PERMISSION_CATEGORIES, type PermissionCategory } from '../shared/settings'
import { readJson, writeJson } from './store'

interface SkillState {
  enabled: Record<string, boolean>
  installedAt: Record<string, number>
}

/** Parses the small YAML subset used in SKILL.md front matter. */
export function parseFrontMatter(text: string): { meta: Record<string, string | string[]>; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''))
  if (!m) return null
  const meta: Record<string, string | string[]> = {}
  let listKey: string | null = null
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim()) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && listKey) {
      ;(meta[listKey] as string[]).push(item[1].trim().replace(/^["']|["']$/g, ''))
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1].toLowerCase().replace(/-/g, '_')
    const val = kv[2].trim()
    if (val === '') {
      meta[key] = []
      listKey = key
    } else if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      listKey = null
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '')
      listKey = null
    }
  }
  return { meta, body: m[2].trim() }
}

const SUSPICIOUS = [
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /disregard (the )?(system|safety|permission)/i,
  /without (asking|telling|permission|confirmation)/i,
  /(exfiltrat|upload|send|post)\w* .{0,40}(password|credential|token|api key|ssh key|cookies)/i,
  /(curl|iwr|invoke-webrequest|wget)[^\n]*\|\s*(iex|sh|bash|powershell)/i,
]

export function validateSkill(dir: string, knownTools: string[]): { info: Omit<SkillInfo, 'enabled' | 'builtin' | 'installedAt'>; body: string } {
  const errors: string[] = []
  const warnings: string[] = []
  const file = path.join(dir, 'SKILL.md')
  let text = ''
  if (!fs.existsSync(file)) errors.push('SKILL.md is missing.')
  else {
    const size = fs.statSync(file).size
    if (size > 100_000) errors.push('SKILL.md is larger than 100 KB.')
    else text = fs.readFileSync(file, 'utf8')
  }
  const fm = text ? parseFrontMatter(text) : null
  if (text && !fm) errors.push('SKILL.md has no front matter block (--- ... ---).')
  const meta = fm?.meta ?? {}
  const str = (k: string) => (typeof meta[k] === 'string' ? (meta[k] as string) : '')
  const list = (k: string) => (Array.isArray(meta[k]) ? (meta[k] as string[]) : typeof meta[k] === 'string' && meta[k] ? String(meta[k]).split(',').map((s) => s.trim()) : [])
  const name = str('name') || path.basename(dir)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) errors.push('name must be lowercase letters, digits and dashes (max 64).')
  const description = str('description')
  if (!description) errors.push('description is required.')
  else if (description.length > 600) errors.push('description is longer than 600 characters.')
  const version = str('version') || '0.0.0'
  if (!/^\d+\.\d+(\.\d+)?([-+][\w.]+)?$/.test(version)) warnings.push(`version "${version}" is not a semantic version.`)
  const tools = list('tools')
  for (const t of tools) if (!knownTools.includes(t)) warnings.push(`uses unknown tool "${t}"; that part of the skill will not work.`)
  const permissions = list('permissions').filter((p): p is PermissionCategory => (PERMISSION_CATEGORIES as readonly string[]).includes(p))
  for (const p of list('permissions')) if (!(PERMISSION_CATEGORIES as readonly string[]).includes(p)) warnings.push(`unknown permission "${p}".`)
  const body = fm?.body ?? ''
  if (fm && !body) errors.push('The skill has no instructions.')
  for (const r of SUSPICIOUS) if (r.test(body)) warnings.push(`instructions contain a risky phrase (${r.source.slice(0, 40)}…); review before enabling.`)
  let hasScripts = false
  const walk = (d: string, depth: number) => {
    if (depth > 4) return
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1)
      else if (/\.(exe|dll|ps1|bat|cmd|vbs|js|mjs|py|sh|msi|scr)$/i.test(e.name)) hasScripts = true
    }
  }
  walk(dir, 0)
  if (hasScripts) warnings.push('contains scripts. Clawd never runs them automatically; any command goes through your approval.')
  return {
    info: {
      id: name,
      name,
      description,
      version,
      author: str('author') || undefined,
      taskTypes: list('task_types'),
      tools,
      permissions,
      path: dir,
      errors,
      warnings,
      hasScripts,
    },
    body,
  }
}

export class SkillLibrary {
  private userDir: string
  private stateFile: string
  private state: SkillState
  private cache = new Map<string, { info: SkillInfo; body: string }>()

  constructor(
    dataDir: string,
    private builtinDir: string | null,
    private knownTools: () => string[],
  ) {
    this.userDir = path.join(dataDir, 'skills')
    fs.mkdirSync(this.userDir, { recursive: true })
    this.stateFile = path.join(this.userDir, 'state.json')
    this.state = readJson<SkillState>(this.stateFile, { enabled: {}, installedAt: {} })
    this.refresh()
  }

  refresh(): void {
    this.cache.clear()
    const add = (dir: string, builtin: boolean) => {
      if (!fs.existsSync(dir)) return
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const { info, body } = validateSkill(path.join(dir, e.name), this.knownTools())
        if (this.cache.has(info.id) && builtin) continue // user copy wins
        const enabled = info.errors.length === 0 && (this.state.enabled[info.id] ?? true)
        this.cache.set(info.id, { info: { ...info, enabled, builtin, installedAt: this.state.installedAt[info.id] ?? 0 }, body })
      }
    }
    add(this.userDir, false)
    if (this.builtinDir) add(this.builtinDir, true)
  }

  list(): SkillInfo[] {
    return [...this.cache.values()].map((s) => s.info).sort((a, b) => a.name.localeCompare(b.name))
  }

  enabled(): SkillInfo[] {
    return this.list().filter((s) => s.enabled)
  }

  instructions(name: string): { info: SkillInfo; body: string } | null {
    const s = this.cache.get(name) ?? [...this.cache.values()].find((x) => x.info.name.toLowerCase() === name.toLowerCase())
    return s && s.info.enabled ? s : null
  }

  /** Short index for the system prompt so the agent knows when a skill could help. */
  index(): string {
    const list = this.enabled()
    if (!list.length) return ''
    return list.map((s) => `- ${s.name}: ${s.description}${s.taskTypes.length ? ` (for: ${s.taskTypes.join(', ')})` : ''}`).join('\n')
  }

  install(srcDir: string): SkillInfo {
    const src = path.resolve(srcDir)
    const { info } = validateSkill(src, this.knownTools())
    if (info.errors.length) throw new Error(`This skill cannot be installed: ${info.errors.join(' ')}`)
    const dest = path.join(this.userDir, info.id)
    if (path.resolve(dest) !== src) {
      fs.rmSync(dest, { recursive: true, force: true })
      fs.cpSync(src, dest, { recursive: true })
    }
    this.state.installedAt[info.id] = Date.now()
    // New skills with warnings start disabled so the user reviews them first.
    this.state.enabled[info.id] = info.warnings.length === 0
    writeJson(this.stateFile, this.state)
    this.refresh()
    return this.cache.get(info.id)!.info
  }

  remove(id: string): void {
    const s = this.cache.get(id)
    if (!s) return
    if (s.info.builtin) throw new Error('Built-in skills can be disabled but not removed.')
    fs.rmSync(path.join(this.userDir, id), { recursive: true, force: true })
    delete this.state.enabled[id]
    delete this.state.installedAt[id]
    writeJson(this.stateFile, this.state)
    this.refresh()
  }

  setEnabled(id: string, on: boolean): SkillInfo {
    const s = this.cache.get(id)
    if (!s) throw new Error('Unknown skill.')
    if (on && s.info.errors.length) throw new Error(`This skill has problems: ${s.info.errors.join(' ')}`)
    this.state.enabled[id] = on
    writeJson(this.stateFile, this.state)
    this.refresh()
    return this.cache.get(id)!.info
  }

  get folder(): string {
    return this.userDir
  }
}
