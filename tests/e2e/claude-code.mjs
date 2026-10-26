// Claude Code integration end to end, against a sandbox settings file (CLAWD_CC_SETTINGS), never
// the user's own: install next to another tool's hooks, run the installed hook command the way
// Claude Code does (PowerShell, JSON on stdin), run one real `claude -p` session with those
// settings, then uninstall and check the other tool's hooks are untouched.
// Pass --no-claude to skip the real Claude Code run.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, done, launch, sleep } from './harness.mjs'

const { main, close, dir } = await launch()
const ccFile = path.join(dir, 'cc-settings.json')
const otherTool = {
  model: 'opus',
  hooks: {
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo other-tool-stop' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other-tool-guard' }] }],
  },
}
fs.writeFileSync(ccFile, JSON.stringify(otherTool, null, 2))

const sessions = () => main(() => globalThis.__clawd.cc.list())
const session = async (id) => (await sessions()).find((s) => s.id === id)
const waitState = async (id, state, ms = 6000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const s = await session(id)
    if (s?.state === state) return s
    await sleep(100)
  }
  return session(id)
}

try {
  await sleep(2000)
  // 1. Install
  const st = await main(() => {
    globalThis.__clawd.hooks.install()
    return globalThis.__clawd.hooks.status(true)
  })
  const json = JSON.parse(fs.readFileSync(ccFile, 'utf8'))
  check('Hooks install for every event', st.installed && st.events.length === 13, `${st.events.length} events`)
  const stopCmds = json.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))
  check("Other tool's hooks and settings are kept", json.model === 'opus' && stopCmds.includes('echo other-tool-stop') && json.hooks.PreToolUse.some((g) => g.matcher === 'Bash' && g.hooks[0].command === 'echo other-tool-guard'), JSON.stringify(stopCmds))
  check('Other hooks are counted, not touched', st.otherHooks === 2, `${st.otherHooks}`)
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('cc-settings.json.clawd-backup-'))
  check('A backup is made before changing the file', backups.length === 1)
  const ours = json.hooks.UserPromptSubmit.flatMap((g) => g.hooks).find((h) => h.command.includes('clawd-cc-hook.js'))
  check('Our hook is async, observer-only, PowerShell', ours.async === true && ours.shell === 'powershell' && ours.timeout === 5, ours.command)
  main(() => {
    globalThis.__clawd.hooks.install()
  })
  await sleep(300)
  const again = JSON.parse(fs.readFileSync(ccFile, 'utf8'))
  check('Installing twice does not duplicate entries', again.hooks.Stop.flatMap((g) => g.hooks).filter((h) => h.command.includes('clawd-cc-hook.js')).length === 1)

  // 2. Fire the installed command exactly as configured, with Claude Code's JSON on stdin.
  const id = 'e2e-' + Date.now()
  const cwd = path.join(os.tmpdir(), 'my-project')
  const fire = (event, extra = {}) => {
    const cmd = again.hooks[event].flatMap((g) => g.hooks).find((h) => h.command.includes('clawd-cc-hook.js')).command
    const t0 = Date.now()
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { input: JSON.stringify({ session_id: id, cwd, hook_event_name: event, transcript_path: path.join(cwd, 't.jsonl'), ...extra }), encoding: 'utf8', timeout: 15000 })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), ms: Date.now() - t0 }
  }
  const r1 = fire('SessionStart', { source: 'startup' })
  check('Hook exits 0 with no output', r1.code === 0 && r1.out.trim() === '', `${r1.ms} ms ${r1.out.slice(0, 120)}`)
  let s = await waitState(id, 'idle')
  check('SessionStart registers the session', s?.state === 'idle' && s.project === 'my-project', JSON.stringify(s && { state: s.state, project: s.project }))
  fire('UserPromptSubmit', { prompt: 'fix the tests' })
  s = await waitState(id, 'processing')
  check('UserPromptSubmit -> processing', s?.state === 'processing')
  const cc = await main(() => globalThis.__clawd.companion.state.cc)
  check('Clawd gets the session state (laptop prop)', cc === 'processing', String(cc))
  fire('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'a.ts'), old_string: 'x'.repeat(5000) } })
  s = await waitState(id, 'tool')
  check('PreToolUse -> tool', s?.state === 'tool' && s.tool === 'Edit')
  fire('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'a.ts') }, tool_response: { ok: true } })
  s = await waitState(id, 'processing')
  check('PostToolUse records the edited file', s?.editedFiles?.some((f) => f.endsWith('a.ts')))
  fire('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  s = await waitState(id, 'waiting_approval')
  check('Permission prompt -> waiting for approval', s?.state === 'waiting_approval' && /permission/.test(s.message ?? ''))
  fire('Stop', {})
  s = await waitState(id, 'completed')
  check('Stop -> completed', s?.state === 'completed')
  fire('SessionEnd', { reason: 'exit' })
  s = await waitState(id, 'disconnected')
  check('SessionEnd -> disconnected', s?.state === 'disconnected')

  // 3. A real Claude Code session with the sandbox settings (user settings not loaded).
  if (!process.argv.includes('--no-claude')) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-cc-real-'))
    const before = new Set((await sessions()).map((x) => x.id))
    const t0 = Date.now()
    const r = spawnSync('claude.exe', ['-p', 'Reply with just the word OK.', '--settings', ccFile, '--setting-sources', 'project', '--max-turns', '1', '--model', 'haiku'], { cwd: work, encoding: 'utf8', timeout: 180000 })
    const real = await (async () => {
      for (let i = 0; i < 40; i++) {
        const fresh = (await sessions()).find((x) => !before.has(x.id) && x.cwd && path.basename(x.cwd) === path.basename(work))
        if (fresh && fresh.events >= 3) return fresh
        await sleep(250)
      }
      return (await sessions()).find((x) => !before.has(x.id))
    })()
    const out = `${r.stdout ?? ''} ${r.stderr ?? ''}`.trim()
    const signedOut = /authenticate|log ?in|OAuth/i.test(out) && r.status !== 0
    if (signedOut) console.log(`NOTE  claude CLI is not signed in here (${out.slice(0, 80)}); the turn fails, but its hooks still fire`)
    else check('Real \`claude -p\` answers with the hooks installed', r.status === 0 && /OK/i.test(r.stdout ?? ''), `exit ${r.status}, ${((Date.now() - t0) / 1000).toFixed(1)} s: ${out.slice(0, 200)}`)
    const want = signedOut ? 'failed' : 'completed'
    check(`Clawd follows the real session through its hooks (${want})`, !!real && real.events >= 3 && real.state === want, real ? `${real.events} events, last ${real.lastEvent}, state ${real.state}` : 'no session')
    fs.rmSync(work, { recursive: true, force: true })
  }

  // 4. Uninstall: only ours go.
  const st2 = await main(() => {
    globalThis.__clawd.hooks.uninstall()
    return globalThis.__clawd.hooks.status(true)
  })
  const after = JSON.parse(fs.readFileSync(ccFile, 'utf8'))
  check('Uninstall removes only Clawd entries', !st2.installed && st2.events.length === 0 && JSON.stringify(after) === JSON.stringify(otherTool), JSON.stringify(after).slice(0, 200))
} finally {
  await close()
}
done()
