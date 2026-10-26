// Debug helper: launch, send one request through the agent, print events and the log tail.
import fs from 'node:fs'
import path from 'node:path'
import { launch, sleep } from './harness.mjs'

const { main, close, dir } = await launch({ env: { CLAWD_DEBUG: '1' } })
try {
  await sleep(4000)
  await main(() => {
    globalThis.__events = []
    globalThis.__clawd.brain.on('agent', (e) => globalThis.__events.push(e.type === 'delta' ? { type: 'delta' } : e))
  })
  const id = await main(() => globalThis.__clawd.brain.call('send', process.argv?.[99] ?? 'What is 17 times 23? Reply with just the number.', { source: 'text' }))
  console.log('task', id)
  for (let i = 0; i < 30; i++) {
    await sleep(3000)
    const ev = await main(() => globalThis.__events.splice(0))
    for (const e of ev) console.log(JSON.stringify(e).slice(0, 300))
    if (ev.some((e) => e.type === 'phase' && ['done', 'error', 'cancelled'].includes(e.phase))) break
  }
} finally {
  const log = path.join(dir, 'logs', 'clawd.log')
  if (fs.existsSync(log)) console.log('--- log ---\n' + fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n'))
  await close()
}
