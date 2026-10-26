// Persistent settings: validated on load, saved atomically, corrupt files backed up and recovered.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { dataPath, writeFileAtomic } from './paths'
import { logger } from './log'
import { defaultSettings, diffSettings, mergeSettings, sanitizeSettings, type DeepPartial, type Settings } from '../shared/settings'

const log = logger('settings')

export class SettingsStore extends EventEmitter {
  private value: Settings
  private readonly file: string
  /** A note for the UI when the file was damaged and had to be repaired. */
  recovered: string | null = null

  constructor(file = dataPath('settings.json')) {
    super()
    this.file = file
    this.value = this.load()
  }

  private load(): Settings {
    if (!fs.existsSync(this.file)) return defaultSettings()
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (err) {
      log.error('cannot read settings, using defaults', err)
      return defaultSettings()
    }
    try {
      const json = JSON.parse(raw)
      const clean = sanitizeSettings(json)
      const dropped = diffSettings(sanitizeSettings({}), clean).length
      if (JSON.stringify(clean) !== JSON.stringify({ ...json, version: clean.version })) {
        log.info('settings normalised on load', { changedFromDefaults: dropped })
      }
      return clean
    } catch (err) {
      // Unparsable JSON: keep a copy for inspection and start from defaults.
      const backup = `${this.file}.corrupt-${Date.now()}`
      try {
        fs.copyFileSync(this.file, backup)
      } catch {
        /* ignore */
      }
      this.recovered = `Settings file was damaged and has been reset. A copy was kept at ${backup}.`
      log.warn('settings file corrupt; reset to defaults', err)
      return defaultSettings()
    }
  }

  get(): Settings {
    return this.value
  }

  set(patch: DeepPartial<Settings>): Settings {
    const next = mergeSettings(this.value, patch)
    const changed = diffSettings(this.value, next)
    if (!changed.length) return this.value
    const prev = this.value
    this.value = next
    this.save()
    this.emit('change', next, prev, changed)
    return next
  }

  reset(section?: keyof Settings): Settings {
    const defaults = defaultSettings()
    const next = section ? { ...this.value, [section]: defaults[section] } : defaults
    const prev = this.value
    this.value = sanitizeSettings(next)
    this.save()
    this.emit('change', this.value, prev, diffSettings(prev, this.value))
    return this.value
  }

  private save(): void {
    try {
      writeFileAtomic(this.file, JSON.stringify(this.value, null, 2))
    } catch (err) {
      log.error('failed to save settings', err)
    }
  }

  onChange(fn: (next: Settings, prev: Settings, changed: string[]) => void): () => void {
    this.on('change', fn)
    return () => this.off('change', fn)
  }
}
