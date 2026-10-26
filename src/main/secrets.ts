// API credentials, encrypted with the OS keystore (DPAPI on Windows) via Electron safeStorage.
// Kept apart from settings and memory; never sent to renderers after being stored.

import { safeStorage } from 'electron'
import fs from 'node:fs'
import { dataPath, writeFileAtomic } from './paths'
import { logger } from './log'

const log = logger('secrets')
type Store = Record<string, string>

export class Secrets {
  private file = dataPath('secrets.bin')
  private cache: Store | null = null

  available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  private read(): Store {
    if (this.cache) return this.cache
    this.cache = {}
    if (!fs.existsSync(this.file)) return this.cache
    try {
      const json = safeStorage.decryptString(fs.readFileSync(this.file))
      this.cache = JSON.parse(json) as Store
    } catch (err) {
      log.warn('could not decrypt stored credentials; they will need to be entered again', err)
    }
    return this.cache
  }

  private write(store: Store): void {
    if (!this.available()) throw new Error('Secure storage is not available on this system, so the key cannot be saved.')
    writeFileAtomic(this.file, safeStorage.encryptString(JSON.stringify(store)))
    this.cache = store
  }

  has(id: string): boolean {
    return !!this.read()[id]
  }

  get(id: string): string | null {
    return this.read()[id] ?? null
  }

  set(id: string, value: string): void {
    const v = value.trim()
    if (!v) return this.clear(id)
    this.write({ ...this.read(), [id]: v })
  }

  clear(id: string): void {
    const s = { ...this.read() }
    delete s[id]
    this.write(s)
  }
}

