// Start with Windows: the setting writes and removes the per-user Run-key entry (HKCU, no admin),
// and a launch with --startup honours "Start tucked away". Always leaves the Run key as it found it.
import { execFileSync } from 'node:child_process'
import { check, done, launch, sleep } from './harness.mjs'

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const runKey = () => {
  try {
    const out = execFileSync('reg', ['query', KEY, '/v', 'Clawd'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const line = out.split(/\r?\n/).find((l) => l.includes('REG_SZ'))
    return line ? line.split('REG_SZ')[1].trim() : null
  } catch {
    return null
  }
}
const cleanup = () => {
  try {
    execFileSync('reg', ['delete', KEY, '/v', 'Clawd', '/f'], { stdio: 'ignore' })
  } catch {}
}

const existing = runKey()
if (existing) {
  console.log(`A Clawd startup entry already exists (${existing}); not touching it.`)
  process.exit(0)
}

let app = await launch()
try {
  await sleep(2000)
  check('Off by default: no Run-key entry', runKey() === null)

  await app.main(() => globalThis.__clawd.settings.set({ general: { startWithWindows: true } }))
  await sleep(500)
  const entry = runKey()
  check('Turning it on writes the Run-key entry', !!entry && /electron\.exe/i.test(entry) && /--startup/.test(entry), entry ?? 'none')

  await app.main(() => globalThis.__clawd.settings.set({ general: { startWithWindows: false } }))
  await sleep(500)
  check('Turning it off removes the entry', runKey() === null)
} finally {
  await app.close()
}

// A login launch (--startup) with "Start tucked away" keeps Clawd in the tray.
app = await launch({ settings: { general: { startInTray: true } }, args: ['--startup'] })
try {
  await sleep(3500)
  const vis = await app.main(() => globalThis.__clawd.companion.state.visibility)
  check('Login launch with "Start tucked away" stays hidden', vis === 'hidden', vis)
  check('A dev launch leaves the Run key alone', runKey() === null)
} finally {
  await app.close()
  if (!existing) cleanup()
}
done()
