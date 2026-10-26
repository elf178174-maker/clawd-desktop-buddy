// Claude Code companion tools. Clawd observes sessions through Claude Code's documented hooks
// (relayed by the desktop host) and reads session transcripts; he never types into a running
// session. Starting a separate headless Claude Code run requires explicit approval.

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { clip } from '../store'
import { approvalReasons, expandPath } from './paths'
import { cleanEnv } from './system'
import { fail, ok, type AnyTool } from './types'

interface TranscriptLine {
  type?: string
  timestamp?: string
  message?: { role?: string; content?: unknown }
}

/** Compact, readable digest of the last entries of a Claude Code transcript (JSONL). */
export function digestTranscript(file: string, maxEntries = 40): string {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split(/\r?\n/).filter(Boolean).slice(-maxEntries * 3)
  const out: string[] = []
  for (const line of lines) {
    let e: TranscriptLine
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const role = e.message?.role ?? e.type
    const content = e.message?.content
    const when = e.timestamp ? e.timestamp.slice(11, 19) + ' ' : ''
    if (typeof content === 'string') {
      if (content.trim()) out.push(`${when}${role}: ${clip(content.trim(), 600)}`)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const b of content as Record<string, unknown>[]) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push(`${when}${role}: ${clip(b.text.trim(), 600)}`)
      else if (b.type === 'tool_use') out.push(`${when}tool call ${String(b.name)}: ${clip(JSON.stringify(b.input ?? {}), 240)}`)
      else if (b.type === 'tool_result') {
        const c = b.content
        const text = typeof c === 'string' ? c : Array.isArray(c) ? (c as { text?: string }[]).map((x) => x.text ?? '').join(' ') : ''
        out.push(`${when}tool result${b.is_error ? ' (ERROR)' : ''}: ${clip(text.trim(), b.is_error ? 1200 : 300)}`)
      }
    }
  }
  return out.slice(-maxEntries).join('\n')
}

/** Read-only git with the repository's ability to run programs (fsmonitor, hooks, external diff, textconv, pager) switched off. */
function git(cwd: string, args: string[]): Promise<string> {
  const safe = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', '-c', 'core.pager=', '-c', 'diff.external=', '--no-pager', '-C', cwd]
  const env = { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  return new Promise((resolve) => {
    execFile('git', [...safe, ...args], { windowsHide: true, timeout: 15000, maxBuffer: 4_000_000, env }, (err, stdout, stderr) => resolve(err ? `(git ${args[0]} failed: ${clip(String(stderr || err.message).trim(), 200)})` : stdout.trim()))
  })
}

/** Repository settings that make even "git status" start programs (clean/smudge filters and friends). */
export function riskyGitConfig(dir: string): string | null {
  let cfg: string
  try {
    cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8')
  } catch {
    return null
  }
  const m = /^\s*\[(filter|include|includeif)\b[^\]]*\]/im.exec(cfg) ?? /^\s*(fsmonitor|hookspath|sshcommand|textconv|external|pager|editor|askpass|clean|smudge|process)\s*=.*$/im.exec(cfg)
  return m ? m[0].trim().slice(0, 60) : null
}

export const claudeCodeTools: AnyTool[] = [
  {
    name: 'claude_code_sessions',
    description:
      'Lists Claude Code sessions Clawd has observed through hooks: project, state (processing, running a tool, waiting for approval or input, completed, failed), last tool, recent errors and edited files.',
    category: 'context',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    risk: () => 'low',
    describe: () => ({ title: 'Check Claude Code sessions', details: 'States reported by Claude Code hooks' }),
    available: (s) => (s.integrations.claudeCode ? true : 'The Claude Code integration is turned off in Settings > Integrations.'),
    async run(_a, ctx) {
      const sessions = await ctx.host.call('cc.sessions')
      const selected = await ctx.host.call('cc.selected')
      if (!sessions.length) return fail('No Claude Code session has reported to Clawd. Check that the integration is installed in Settings > Integrations and that a session is running.')
      const lines = sessions.map((s) =>
        [
          `${s.id === selected ? '* ' : ''}session ${s.id.slice(0, 8)} in ${s.project} (${s.cwd})`,
          `  state: ${s.state}${s.certain ? '' : ' (inferred)'}; last event ${s.lastEvent} ${Math.round((Date.now() - s.updatedAt) / 1000)} s ago${s.tool ? `; tool ${s.tool}` : ''}`,
          s.message ? `  message: ${clip(s.message, 200)}` : '',
          s.lastError ? `  last error: ${clip(s.lastError, 400)}` : '',
          s.editedFiles.length ? `  edited: ${s.editedFiles.slice(-8).join(', ')}` : '',
          s.transcriptPath ? `  transcript: ${s.transcriptPath}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      return ok(lines.join('\n'), { untrusted: 'Claude Code session data', summary: `${sessions.length} session(s)` })
    },
  },
  {
    name: 'claude_code_transcript',
    description:
      'Reads the recent history of a Claude Code session (prompts, its replies, tool calls and errors) from its transcript. Use to explain why it is waiting, what failed, or what changed.',
    category: 'context',
    parameters: {
      type: 'object',
      properties: { session_id: { type: 'string', maxLength: 100, description: 'Defaults to the selected session.' }, entries: { type: 'integer', minimum: 5, maximum: 200 } },
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: () => ({ title: 'Read a Claude Code transcript', details: 'Recent session history' }),
    available: (s) => (s.integrations.claudeCode ? true : 'The Claude Code integration is turned off in Settings > Integrations.'),
    async run(a: { session_id?: string; entries?: number }, ctx) {
      const sessions = await ctx.host.call('cc.sessions')
      const id = a.session_id ?? (await ctx.host.call('cc.selected')) ?? sessions[0]?.id
      const s = sessions.find((x) => x.id === id || x.id.startsWith(id ?? '\u0000'))
      if (!s) return fail('That session is unknown.')
      if (!s.transcriptPath || !fs.existsSync(s.transcriptPath)) return fail('The transcript file for this session is not available.')
      const digest = digestTranscript(s.transcriptPath, a.entries ?? 40)
      return ok(`Session ${s.id.slice(0, 8)} in ${s.cwd}, state ${s.state}:\n${digest}`, { untrusted: 'Claude Code transcript', summary: `${s.project} transcript` })
    },
  },
  {
    name: 'project_status',
    description: 'Summarises a project folder: git branch and changed files, diff stats and recent commits. Read-only.',
    category: 'files_read',
    parameters: { type: 'object', properties: { path: { type: 'string', maxLength: 1000 } }, required: ['path'], additionalProperties: false },
    risk: (a: { path: string }) => (riskyGitConfig(expandPath(a.path)) ? 'high' : 'low'),
    describe: (a: { path: string }) => ({ title: 'Check project status', details: expandPath(a.path) }),
    needsApproval: (a: { path: string }, ctx) => {
      const dir = expandPath(a.path)
      const reasons = approvalReasons(dir, ctx.settings, 'read', ctx.extraRoots)
      const risky = riskyGitConfig(dir)
      if (risky) reasons.push(`the repository's git settings can start programs (${risky})`)
      return reasons
    },
    async run(a: { path: string }) {
      const dir = expandPath(a.path)
      if (!fs.existsSync(dir)) return fail(`${dir} does not exist.`)
      const [status, stat, log] = await Promise.all([git(dir, ['status', '--short', '--branch']), git(dir, ['diff', '--stat']), git(dir, ['log', '-8', '--oneline', '--decorate'])])
      const files = fs.readdirSync(dir).slice(0, 40).join(', ')
      return ok(`Project ${path.basename(dir)} (${dir})\nTop level: ${files}\n\ngit status:\n${status}\n\ndiff stat:\n${stat || '(no unstaged changes)'}\n\nrecent commits:\n${log}`, {
        untrusted: 'project files',
        summary: path.basename(dir),
      })
    },
  },
  {
    name: 'claude_code_run',
    description:
      'Starts a separate, headless Claude Code run ("claude -p") in a project folder with a prompt and returns its final answer. It does not touch the user\'s open sessions. It acts with Claude Code\'s own permissions and uses the user\'s Claude Code plan, so it always needs approval.',
    category: 'claude_code',
    parameters: {
      type: 'object',
      properties: { cwd: { type: 'string', maxLength: 1000 }, prompt: { type: 'string', maxLength: 20000 }, timeout_sec: { type: 'integer', minimum: 30, maximum: 1800 } },
      required: ['cwd', 'prompt'],
      additionalProperties: false,
    },
    risk: () => 'high',
    describe: (a: { cwd: string; prompt: string }) => ({ title: 'Start a Claude Code run', details: `In ${expandPath(a.cwd)}:\n${a.prompt}` }),
    needsApproval: () => ['sends instructions to another agent'],
    available: (s) => (s.integrations.claudeCode ? true : 'The Claude Code integration is turned off in Settings > Integrations.'),
    timeoutSec: 1800,
    async run(a: { cwd: string; prompt: string; timeout_sec?: number }, ctx) {
      const cwd = expandPath(a.cwd)
      if (!fs.existsSync(cwd)) return fail(`${cwd} does not exist.`)
      ctx.progress('Claude Code is working…')
      const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        // The prompt goes in on stdin: the command line holds only fixed arguments, so nothing the
        // model wrote can be read by a shell. (claude may be a .cmd shim, which needs the shell.)
        const child = spawn('claude', ['-p', '--output-format', 'json'], { cwd, windowsHide: true, shell: true, env: cleanEnv() })
        child.stdin.end(a.prompt)
        let out = ''
        let err = ''
        child.stdout.on('data', (b: Buffer) => (out += b.toString()))
        child.stderr.on('data', (b: Buffer) => (err += b.toString()))
        const kill = () => child.pid && spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        const timer = setTimeout(kill, (a.timeout_sec ?? 600) * 1000)
        ctx.signal.addEventListener('abort', kill, { once: true })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ code, out, err })
        })
        child.on('error', (e) => resolve({ code: -1, out: '', err: String(e) }))
      })
      if (result.code !== 0 && !result.out) return fail(`Claude Code exited with ${result.code}: ${clip(result.err.trim(), 800)}`)
      try {
        const json = JSON.parse(result.out) as { result?: string; is_error?: boolean; num_turns?: number; total_cost_usd?: number }
        const text = `Claude Code ${json.is_error ? 'reported an error' : 'finished'}${json.num_turns ? ` after ${json.num_turns} turns` : ''}:\n${json.result ?? ''}`
        return json.is_error ? fail(text, { untrusted: 'Claude Code output' }) : ok(text, { untrusted: 'Claude Code output', summary: 'Claude Code finished' })
      } catch {
        return ok(clip(result.out, 20000), { untrusted: 'Claude Code output' })
      }
    },
  },
]
