// Side-buddy helpers (quick actions, result splitting), the animation director and engine
// transitions, and the Claude Code session tracker.
import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() } }))

import { ClawdEngine } from '../../src/character/engine'
import { baseStateFor, Director } from '../../src/character/director'
import { STATES } from '../../src/character/states'
import { SessionTracker } from '../../src/main/claude-code'
import { isWritingTask, quickActionsFor, siteOf } from '../../src/shared/quick-actions'
import { splitResult } from '../../src/shared/result-split'
import type { CompanionState } from '../../src/shared/types'

const reddit = 'https://www.reddit.com/r/learnprogramming/comments/abc/rust_or_go/'

describe('quick actions', () => {
  it('a Reddit thread with a draft offers "Refine my comment" first, with its skill', () => {
    const a = quickActionsFor({ capturedAt: 0, url: reddit, draft: 'i think go' })
    expect(a[0]).toMatchObject({ label: 'Refine my comment', primary: true, skill: 'comment-refine' })
    expect(a.map((x) => x.label)).toContain('Summarize the thread')
    expect(a.filter((x) => x.primary)).toHaveLength(1)
  })
  it('a thread without a draft leads with the summary and offers help replying', () => {
    const a = quickActionsFor({ capturedAt: 0, url: reddit })
    expect(a[0]).toMatchObject({ label: 'Summarize the thread', primary: true })
    expect(a.map((x) => x.label)).toContain('Help me reply')
  })
  it('any other page offers a summary and takeaways; a selection adds writing actions', () => {
    expect(quickActionsFor({ capturedAt: 0, url: 'https://example.com/post' }).map((x) => x.label)).toEqual(['Summarize this page', 'Key takeaways'])
    const sel = quickActionsFor({ capturedAt: 0, app: 'Word', selection: 'teh text' })
    expect(sel.map((x) => x.label)).toEqual(['Refine', 'Shorten', 'Fix grammar', 'Explain'])
    expect(sel[0].primary).toBe(true)
  })
  it('no context: screen help, and an error title gets "Explain this error"', () => {
    expect(quickActionsFor(null).map((x) => x.label)).toEqual(["What's on my screen?"])
    expect(quickActionsFor({ capturedAt: 0, app: 'Terminal', title: 'Build failed - npm' })[0].label).toBe('Explain this error')
  })
  it('never offers more than four', () => {
    expect(quickActionsFor({ capturedAt: 0, url: reddit, draft: 'x', selection: 'y' }).length).toBeLessThanOrEqual(4)
  })
  it('siteOf and isWritingTask', () => {
    expect(siteOf('https://www.reddit.com/r/x')).toBe('reddit.com')
    expect(siteOf('not a url')).toBeNull()
    expect(isWritingTask('make it shorter')).toBe(true)
    expect(isWritingTask('what time is it')).toBe(false)
    expect(isWritingTask('What is 17 times 23? Reply with just the number.')).toBe(false)
    expect(isWritingTask('write me a short email to my landlord')).toBe(true)
  })
})

describe('splitResult', () => {
  it('takes the text inside <result> and the rest as a note', () => {
    expect(splitResult('<result>\nFixed text.\n</result>\nI kept your slang.')).toEqual({ text: 'Fixed text.', note: 'I kept your slang.' })
  })
  it('drops a "note" that only repeats the text', () => {
    expect(splitResult('Honestly I think Go is easier.\n<result>Honestly, I think Go is easier.</result>')).toEqual({ text: 'Honestly, I think Go is easier.', note: undefined })
  })
  it('turns a lead-in line into a note when there are no tags', () => {
    const r = splitResult("Sure! Here's a refined version of your comment:\n\nI think Go is easier to start with.")
    expect(r.text).toBe('I think Go is easier to start with.')
    expect(r.note).toMatch(/refined version/)
  })
  it('splits a trailing "Note:" paragraph', () => {
    const r = splitResult('I think Go is easier to start with, honestly.\n\nNote: I fixed the spelling of "useful".')
    expect(r).toEqual({ text: 'I think Go is easier to start with, honestly.', note: 'Note: I fixed the spelling of "useful".' })
  })
  it('removes quotes or a fence around the whole text, but not inner quotes', () => {
    expect(splitResult('<result>"Hello there."</result>').text).toBe('Hello there.')
    expect(splitResult('<result>```\ncode here\n```</result>').text).toBe('code here')
    expect(splitResult('<result>"A" and "B"</result>').text).toBe('"A" and "B"')
  })
  it('leaves a plain answer alone', () => {
    expect(splitResult('The capital of France is Paris.')).toEqual({ text: 'The capital of France is Paris.' })
  })
})

const st = (p: Partial<CompanionState> = {}): CompanionState => ({ visibility: 'present', focus: false, agent: 'idle', cc: null, listening: false, speaking: false, panelOpen: false, needsUser: false, ...p })
const opts = { laptopProp: true, focusIntensity: 0.5 }

describe('director', () => {
  it('maps app state to a base animation with clear priorities', () => {
    expect(baseStateFor(st({ visibility: 'hidden', listening: true }), opts)[0]).toBe('hidden')
    expect(baseStateFor(st({ needsUser: true, agent: 'working' }), opts)[0]).toBe('permission')
    expect(baseStateFor(st({ listening: true, agent: 'working' }), opts)[0]).toBe('listen')
    expect(baseStateFor(st({ speaking: true }), opts)[0]).toBe('speak')
    expect(baseStateFor(st({ agent: 'thinking' }), opts)[0]).toBe('think')
    expect(baseStateFor(st({ agent: 'working' }), opts)[0]).toBe('work')
    expect(baseStateFor(st({ agent: 'done' }), opts)[0]).toBe('idle')
  })
  it('shows the laptop only while Claude Code works, and only when the prop is on', () => {
    expect(baseStateFor(st({ cc: 'tool' }), opts)[0]).toBe('type')
    expect(baseStateFor(st({ cc: 'processing' }), opts)[0]).toBe('waitCC')
    expect(baseStateFor(st({ cc: 'tool' }), { ...opts, laptopProp: false })[0]).toBe('work')
    expect(baseStateFor(st({ cc: 'waiting_approval' }), opts)).toEqual(['attention', { laptop: 1 }])
    expect(baseStateFor(st({ cc: 'idle' }), opts)[0]).toBe('idle')
    // Clawd's own work wins over Claude Code's.
    expect(baseStateFor(st({ cc: 'tool', agent: 'thinking' }), opts)[0]).toBe('think')
  })
  it('plays enter/leave on visibility changes and returns to the base after one-shots', () => {
    const engine = new ClawdEngine({ seed: 7 } as never)
    const d = new Director(engine, { ...opts })
    d.apply(st())
    expect(engine.state).toBe('enter')
    const run = (sec: number) => {
      let f
      for (let t = 0; t < sec; t += 1 / 60) f = engine.update({ dt: 1 / 60 })
      return f!
    }
    run(3)
    expect(engine.state).toBe('idle')
    d.apply(st({ agent: 'thinking' }))
    run(0.5)
    expect(engine.state).toBe('think')
    engine.play('poke')
    expect(engine.state).toBe('poke')
    run((STATES.poke.duration ?? 1) + 0.6)
    expect(engine.state).toBe('think')
    // A cancelled task can never leave him stuck: the base follows the app state.
    d.apply(st({ agent: 'cancelled' }))
    run(0.6)
    expect(engine.state).toBe('idle')
    d.apply(st({ visibility: 'hidden' }))
    expect(engine.state).toBe('leave')
    run(3)
    expect(engine.state).toBe('hidden')
  })
  it('every state animates without NaN for 4 seconds', () => {
    for (const name of Object.keys(STATES) as (keyof typeof STATES)[]) {
      const engine = new ClawdEngine({ seed: 3 } as never)
      engine.setBase('idle')
      engine.play(name)
      for (let t = 0; t < 4; t += 1 / 30) {
        const f = engine.update({ dt: 1 / 30, look: { x: 3, y: 2 }, lookActive: true, level: 0.5 })
        const bad = f.geometry.rects.find((r) => !Object.values(r).every((v) => typeof v !== "number" || Number.isFinite(v)))
        expect(bad, `${name} at ${t.toFixed(2)} s`).toBeUndefined()
      }
    }
  })
})

describe('Claude Code session tracker', () => {
  const ev = (event: string, payload: Record<string, unknown>, t = Date.now()) => ({ event, t, payload: { session_id: 's1', cwd: 'C:\\code\\my-app', ...payload } })
  it('follows a session through its hook events', () => {
    const tr = new SessionTracker()
    const states: string[] = []
    tr.on('state', (s) => states.push(s.state))
    tr.handle(ev('SessionStart', { source: 'startup' }))
    tr.handle(ev('UserPromptSubmit', {}))
    tr.handle(ev('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'C:\\code\\my-app\\a.ts' } }))
    tr.handle(ev('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'C:\\code\\my-app\\a.ts' } }))
    tr.handle(ev('Notification', { notification_type: 'permission_prompt', message: 'Allow Bash?' }))
    tr.handle(ev('Stop', {}))
    const s = tr.list()[0]
    expect(states).toEqual(['processing', 'tool', 'processing', 'waiting_approval', 'completed'])
    expect(s).toMatchObject({ project: 'my-app', state: 'completed', toolCount: 1 })
    expect(s.editedFiles).toEqual(['C:\\code\\my-app\\a.ts'])
    tr.dispose()
  })
  it('ignores events without a session id and stale out-of-order events', () => {
    const tr = new SessionTracker()
    tr.handle({ event: 'UserPromptSubmit', t: Date.now(), payload: {} })
    expect(tr.list()).toEqual([])
    const now = Date.now()
    tr.handle(ev('Stop', {}, now))
    tr.handle(ev('UserPromptSubmit', {}, now - 5000))
    expect(tr.list()[0].state).toBe('completed')
    tr.dispose()
  })
  it('a slow approval-prone tool becomes "possibly waiting for approval" (uncertain)', () => {
    vi.useFakeTimers()
    const tr = new SessionTracker()
    tr.handle(ev('UserPromptSubmit', { permission_mode: 'default' }))
    tr.handle(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }))
    vi.advanceTimersByTime(5000)
    expect(tr.list()[0]).toMatchObject({ state: 'waiting_approval', certain: false })
    tr.dispose()
    vi.useRealTimers()
  })
  it('does not guess approval waits when Claude Code auto-accepts', () => {
    vi.useFakeTimers()
    const tr = new SessionTracker()
    tr.handle(ev('UserPromptSubmit', { permission_mode: 'bypassPermissions' }))
    tr.handle(ev('PreToolUse', { tool_name: 'Bash', permission_mode: 'bypassPermissions' }))
    vi.advanceTimersByTime(5000)
    expect(tr.list()[0].state).toBe('tool')
    tr.dispose()
    vi.useRealTimers()
  })
  it('focus prefers the selected session, else the most recent; ended sessions drop out', () => {
    const tr = new SessionTracker()
    tr.handle(ev('SessionStart', { session_id: 'a', cwd: 'C:\\a' }))
    tr.handle(ev('SessionStart', { session_id: 'b', cwd: 'C:\\b' }, Date.now() + 10))
    tr.select('a')
    expect(tr.focus()?.id).toBe('a')
    tr.handle(ev('SessionEnd', { session_id: 'a', cwd: 'C:\\a' }))
    expect(tr.focus()?.id).toBe('b')
    tr.dispose()
  })
})

describe('Claude Code hook installer', () => {
  it("adds and removes only Clawd's entries; other tools' groups stay exactly as they were", async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-hooks-'))
    const file = path.join(dir, 'settings.json')
    process.env.CLAWD_CC_SETTINGS = file
    process.env.CLAWD_DATA_DIR = dir
    const other = {
      theme: 'dark',
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'other-tool stop' }] }, { matcher: 'odd', hooks: [] }],
        PreToolUse: [{ matcher: 'Bash' }],
      },
    }
    fs.writeFileSync(file, JSON.stringify(other))
    const { HookInstaller } = await import('../../src/main/claude-code')
    const h = new HookInstaller()
    h.install()
    h.install()
    const mid = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(mid.hooks.Stop.slice(0, 2)).toEqual(other.hooks.Stop)
    expect(mid.hooks.PreToolUse[0]).toEqual({ matcher: 'Bash' })
    expect(mid.hooks.Stop.filter((g: { hooks: { command: string }[] }) => g.hooks.some((x) => x.command.includes('clawd-cc-hook.js')))).toHaveLength(1)
    h.uninstall()
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(other)
    delete process.env.CLAWD_CC_SETTINGS
    delete process.env.CLAWD_DATA_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('splitResult for non-writing answers', () => {
  it('keeps a summary whole even if the model tagged only its first line', () => {
    const r = splitResult('<result>The post asks Rust or Go.</result>\n\n- Go is faster to learn\n- Rust teaches ownership', false)
    expect(r.note).toBeUndefined()
    expect(r.text).toMatch(/^The post asks Rust or Go\.\n\n- Go is faster/)
  })
  it('a long "note" after a writing result stays in the answer', () => {
    const long = 'Extra: ' + 'word '.repeat(80)
    const r = splitResult(`<result>Fixed.</result>\n${long}`)
    expect(r.note).toBeUndefined()
    expect(r.text.startsWith('Fixed.')).toBe(true)
  })
})
