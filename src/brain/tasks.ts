// Task history: one JSON file per task plus a small index, with retention, and practical undo
// backed by file copies made before Clawd changed anything.

import fs from 'node:fs'
import path from 'node:path'
import type { TaskSummary, UndoResult } from '../shared/api'
import type { FileChange, TaskRecord } from '../shared/types'
import { newId, readJson, writeJson } from './store'

export class TaskStore {
  private dir: string
  private indexFile: string
  private index: TaskSummary[]

  constructor(root: string) {
    this.dir = path.join(root, 'tasks')
    fs.mkdirSync(this.dir, { recursive: true })
    this.indexFile = path.join(this.dir, 'index.json')
    this.index = readJson<TaskSummary[]>(this.indexFile, [])
  }

  private file(id: string): string {
    if (!/^[a-z0-9_]+$/i.test(id)) throw new Error('Bad task id')
    return path.join(this.dir, `${id}.json`)
  }

  save(task: TaskRecord): void {
    writeJson(this.file(task.id), task)
    const summary: TaskSummary = {
      id: task.id,
      request: task.request.slice(0, 200),
      status: task.status,
      createdAt: task.createdAt,
      endedAt: task.endedAt,
      steps: task.steps.length,
      files: task.files.length,
      undoable: task.files.filter((f) => f.backupId && !f.reverted).length + task.files.filter((f) => f.action === 'created' && !f.reverted).length,
    }
    const i = this.index.findIndex((t) => t.id === task.id)
    if (i >= 0) this.index[i] = summary
    else this.index.unshift(summary)
    writeJson(this.indexFile, this.index)
  }

  get(id: string): TaskRecord | null {
    try {
      return readJson<TaskRecord | null>(this.file(id), null)
    } catch {
      return null
    }
  }

  list(): TaskSummary[] {
    return this.index
  }

  delete(id: string): void {
    fs.rmSync(this.file(id), { force: true })
    this.index = this.index.filter((t) => t.id !== id)
    writeJson(this.indexFile, this.index)
  }

  clear(): void {
    for (const t of this.index) fs.rmSync(this.file(t.id), { force: true })
    this.index = []
    writeJson(this.indexFile, this.index)
  }

  /** Tasks that were running when the app stopped are marked as interrupted on the next start. */
  markInterrupted(): TaskRecord[] {
    const out: TaskRecord[] = []
    for (const s of this.index.filter((t) => t.status === 'running' || t.status === 'waiting')) {
      const t = this.get(s.id)
      if (!t) continue
      t.status = 'interrupted'
      t.endedAt = Date.now()
      t.error = 'Clawd was closed or restarted while this task was running.'
      for (const st of t.steps) if (st.status === 'running') st.status = 'failed'
      this.save(t)
      out.push(t)
    }
    return out
  }

  prune(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 86_400_000
    for (const t of [...this.index]) if ((t.endedAt ?? t.createdAt) < cutoff && t.status !== 'running') this.delete(t.id)
  }
}

interface BackupEntry {
  id: string
  taskId: string
  original: string
  /** Copy of the file before the change, or null when the path did not exist. */
  copy: string | null
  createdAt: number
}

export class UndoStore {
  private dir: string
  private manifestFile: string
  private manifest: BackupEntry[]

  constructor(root: string) {
    this.dir = path.join(root, 'backups')
    fs.mkdirSync(this.dir, { recursive: true })
    this.manifestFile = path.join(this.dir, 'manifest.json')
    this.manifest = readJson<BackupEntry[]>(this.manifestFile, [])
  }

  /** Copies a file (or records its absence) before it is modified, moved or deleted. */
  backup(taskId: string, original: string): string {
    const id = newId('bak')
    let copy: string | null = null
    if (fs.existsSync(original)) {
      const st = fs.statSync(original)
      if (st.isDirectory()) {
        copy = path.join(this.dir, id)
        fs.cpSync(original, copy, { recursive: true })
      } else {
        copy = path.join(this.dir, id + path.extname(original))
        fs.copyFileSync(original, copy)
      }
    }
    this.manifest.push({ id, taskId, original, copy, createdAt: Date.now() })
    writeJson(this.manifestFile, this.manifest)
    return id
  }

  /** Reverts the given file changes of a task, newest first. */
  revert(changes: FileChange[]): UndoResult {
    const res: UndoResult = { ok: true, reverted: [], failed: [] }
    for (const ch of [...changes].reverse()) {
      if (ch.reverted) continue
      try {
        if (ch.action === 'created' && !ch.backupId) {
          if (fs.existsSync(ch.path)) fs.rmSync(ch.path, { recursive: true, force: true })
        } else {
          const entry = this.manifest.find((b) => b.id === ch.backupId)
          if (!entry) throw new Error('No backup was kept for this change.')
          if (ch.action === 'moved' && ch.to && fs.existsSync(ch.to)) fs.rmSync(ch.to, { recursive: true, force: true })
          if (entry.copy === null) {
            if (fs.existsSync(entry.original)) fs.rmSync(entry.original, { recursive: true, force: true })
          } else {
            if (!fs.existsSync(entry.copy)) throw new Error('The backup copy is gone (it may have expired).')
            fs.mkdirSync(path.dirname(entry.original), { recursive: true })
            if (fs.existsSync(entry.original)) fs.rmSync(entry.original, { recursive: true, force: true })
            fs.cpSync(entry.copy, entry.original, { recursive: true })
          }
        }
        ch.reverted = true
        res.reverted.push(ch.path)
      } catch (err) {
        res.ok = false
        res.failed.push({ path: ch.path, reason: (err as Error).message })
      }
    }
    return res
  }

  prune(days: number): void {
    const cutoff = Date.now() - days * 86_400_000
    const keep: BackupEntry[] = []
    for (const b of this.manifest) {
      if (b.createdAt < cutoff) {
        if (b.copy) fs.rmSync(b.copy, { recursive: true, force: true })
      } else keep.push(b)
    }
    this.manifest = keep
    writeJson(this.manifestFile, this.manifest)
  }
}
