// Local speech models: presence checks and an in-app downloader (Settings > Voice).

import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { logger } from './log'
import { modelsDir, resourcePath } from './paths'

const log = logger('models')

interface ModelEntry {
  id: string
  label: string
  url: string
  dir?: string
  file?: string
  check?: string
  sizeMB: number
}

function manifest(): { base: string; models: ModelEntry[] } {
  return JSON.parse(fs.readFileSync(resourcePath('models.json'), 'utf8'))
}

export class ModelManager extends EventEmitter {
  downloading: { file: string; received: number; total: number } | null = null
  error: string | null = null

  missing(): string[] {
    const dir = modelsDir()
    return manifest()
      .models.filter((m) => !fs.existsSync(path.join(dir, m.dir ? path.join(m.dir, m.check ?? '') : (m.file ?? ''))))
      .map((m) => m.label)
  }

  get present(): boolean {
    return this.missing().length === 0
  }

  async download(): Promise<void> {
    if (this.downloading) return
    const { base, models } = manifest()
    const dir = modelsDir()
    this.error = null
    try {
      for (const m of models) {
        const target = path.join(dir, m.dir ? path.join(m.dir, m.check ?? '') : (m.file ?? ''))
        if (fs.existsSync(target)) continue
        const url = `${base}/${m.url}`
        const tmp = path.join(dir, path.basename(m.url) + '.part')
        const res = await fetch(url, { redirect: 'follow' })
        if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${m.label}`)
        const total = Number(res.headers.get('content-length')) || m.sizeMB * 1e6
        this.downloading = { file: m.label, received: 0, total }
        this.emit('progress')
        let last = 0
        const counter = new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, ctrl) => {
            this.downloading!.received += chunk.byteLength
            if (Date.now() - last > 250) {
              last = Date.now()
              this.emit('progress')
            }
            ctrl.enqueue(chunk)
          },
        })
        await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as never), fs.createWriteStream(tmp))
        if (m.dir) {
          const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
          await new Promise<void>((resolve, reject) => execFile(tar, ['-xjf', tmp, '-C', dir], { windowsHide: true }, (err) => (err ? reject(err) : resolve())))
          fs.rmSync(tmp, { force: true })
        } else fs.renameSync(tmp, path.join(dir, m.file!))
        log.info('model ready', { id: m.id })
      }
    } catch (err) {
      this.error = (err as Error).message
      log.error('model download failed', err)
    } finally {
      this.downloading = null
      this.emit('progress')
      this.emit('done')
    }
  }
}
