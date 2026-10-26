// Where Clawd keeps its data. CLAWD_DATA_DIR redirects everything (used by the e2e tests).

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

let root: string | null = null

export function dataDir(): string {
  if (!root) {
    root = process.env.CLAWD_DATA_DIR ? path.resolve(process.env.CLAWD_DATA_DIR) : app.getPath('userData')
    fs.mkdirSync(root, { recursive: true })
  }
  return root
}

export function dataPath(...parts: string[]): string {
  const p = path.join(dataDir(), ...parts)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  return p
}

export function subdir(name: string): string {
  const p = path.join(dataDir(), name)
  fs.mkdirSync(p, { recursive: true })
  return p
}

/** Folder for bundled resources: `resources/` in development, process.resourcesPath when packaged. */
export function resourcePath(...parts: string[]): string {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'app-resources') : path.join(app.getAppPath(), 'resources')
  return path.join(base, ...parts)
}

/** Speech models live outside the app bundle so updates do not re-download them. */
export function modelsDir(): string {
  const p = process.env.CLAWD_MODELS_DIR
    ? path.resolve(process.env.CLAWD_MODELS_DIR)
    : app.isPackaged
      ? path.join(app.getPath('userData'), 'models')
      : path.join(app.getAppPath(), 'models')
  fs.mkdirSync(p, { recursive: true })
  return p
}

/** Writes a file atomically (temp file + rename) so a crash never leaves it half-written. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, data)
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    // On Windows a reader can briefly hold the target open; fall back to a direct write.
    fs.writeFileSync(file, data)
    fs.rmSync(tmp, { force: true })
    if ((err as NodeJS.ErrnoException).code !== 'EPERM' && (err as NodeJS.ErrnoException).code !== 'EACCES') throw err
  }
}
