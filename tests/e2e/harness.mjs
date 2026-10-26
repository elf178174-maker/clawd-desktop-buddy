// Drives the real Clawd app with Playwright's Electron support. Each run gets a throwaway data
// folder (CLAWD_DATA_DIR) so the user's own profile is never touched.
import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', '..')
export const SHOTS = path.join(ROOT, 'tests', 'e2e', 'shots')
fs.mkdirSync(SHOTS, { recursive: true })

export async function launch({ settings, env = {}, dataDir, args = [], reuse = false, exe } = {}) {
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-e2e-'))
  // Tests run on the real desktop: no welcome bubbles and no microphone unless a test asks for them.
  const quiet = { general: { onboarded: true }, voice: { wakeWord: false, listenOnSummon: false } }
  const merged = settings ? { ...quiet, ...settings, general: { ...quiet.general, ...(settings.general ?? {}) }, voice: { ...quiet.voice, ...(settings.voice ?? {}) } } : quiet
  // reuse: start again on the data folder of an earlier launch, settings as that run left them.
  if (!reuse) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(merged, null, 2))
  const app = await electron.launch({
    executablePath: exe ?? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: exe ? args : [...args, ROOT],
    cwd: ROOT,
    env: { ...process.env, CLAWD_DATA_DIR: dir, CLAWD_MODELS_DIR: path.join(ROOT, 'models'), CLAWD_CC_SETTINGS: path.join(dir, 'cc-settings.json'), ...env },
    timeout: 60000,
  })
  const page = async (name, timeout = 20000) => {
    const t0 = Date.now()
    for (;;) {
      const w = app.windows().find((p) => p.url().includes(`/${name}/`))
      if (w) {
        await w.waitForLoadState('domcontentloaded')
        return w
      }
      if (Date.now() - t0 > timeout) throw new Error(`window ${name} not found; have ${app.windows().map((p) => p.url()).join(', ')}`)
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  const main = (fn, arg) => app.evaluate(fn, arg)
  const close = async ({ keep = false } = {}) => {
    await app.close().catch(() => {})
    if (!keep) fs.rmSync(dir, { recursive: true, force: true })
  }
  return { app, page, main, close, dir }
}

/** Captures the real desktop (all monitors) with the native helper, including layered windows. */
export function desktopShot(file, target = 'screen') {
  return new Promise((resolve, reject) => {
    const p = spawn(path.join(ROOT, 'native', 'bin', 'clawd-native.exe'), [], { stdio: ['pipe', 'pipe', 'inherit'] })
    let out = ''
    p.stdout.on('data', (b) => {
      out += b
      if (out.includes('\n')) {
        const r = JSON.parse(out.split('\n')[0])
        p.stdin.end()
        r.ok ? resolve(r.v) : reject(new Error(r.e))
      }
    })
    p.stdin.write(JSON.stringify({ id: 1, m: 'screenshot', a: { target, maxWidth: 0, file } }) + '\n')
  })
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
export function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  return ok
}
export function done() {
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  process.exitCode = failures ? 1 : 0
}
