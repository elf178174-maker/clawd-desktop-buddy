// Runs every end-to-end suite in turn against the built app (npm run build first) and prints a
// summary. Usage: node tests/e2e/run.mjs [suite ...]   e.g. node tests/e2e/run.mjs smoke voice-first
// The suites run on the real desktop; they use throwaway data folders and leave your settings,
// Claude Code config and startup entries untouched.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ROOT } from './harness.mjs'

const ALL = ['smoke', 'interactions', 'startup', 'pointer-glow', 'panel-buddy', 'voice-first', 'extension', 'claude-code', 'packaged']
const pick = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const suites = pick.length ? pick : ALL
const results = []
for (const name of suites) {
  console.log(`\n=== ${name}`)
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'e2e', `${name}.mjs`), ...process.argv.slice(2).filter((a) => a.startsWith('-'))], { cwd: ROOT, encoding: 'utf8', timeout: 15 * 60_000 })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const lines = out.split(/\r?\n/).filter((l) => /^(PASS|FAIL|NOTE) /.test(l))
  console.log(lines.join('\n'))
  if (r.status !== 0 && !lines.some((l) => l.startsWith('FAIL'))) console.log(out.split(/\r?\n/).filter((l) => l.trim() && !/WARNING/.test(l)).slice(-8).join('\n'))
  const pass = lines.filter((l) => l.startsWith('PASS')).length
  const fail = lines.filter((l) => l.startsWith('FAIL')).length
  results.push({ name, ok: r.status === 0, pass, fail, s: ((Date.now() - t0) / 1000).toFixed(0) })
}
console.log('\n=== summary')
for (const x of results) console.log(`${x.ok ? 'ok  ' : 'FAIL'}  ${x.name.padEnd(14)} ${String(x.pass).padStart(3)} passed  ${x.fail} failed  ${x.s} s`)
const total = results.reduce((n, x) => n + x.pass, 0)
const bad = results.filter((x) => !x.ok)
console.log(`\n${total} checks passed across ${results.length} suites${bad.length ? `; ${bad.length} suite(s) failed` : ''}`)
process.exitCode = bad.length ? 1 : 0
