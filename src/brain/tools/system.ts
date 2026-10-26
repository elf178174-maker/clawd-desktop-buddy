// Clipboard, applications, commands, keyboard/mouse automation and notifications.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { clip } from '../store'
import { expandPath } from './paths'
import { fail, ok, type AnyTool, type Risk } from './types'

const DESTRUCTIVE = [
  /\b(remove-item|rm|rmdir|rd|del|erase)\b/i,
  /\bformat(-volume)?\b/i,
  /\b(clear-content|clear-item|set-content|add-content|out-file|new-item|copy-item|move-item|rename-item)\b/i,
  /\b(stop-process|taskkill|kill)\b/i,
  /\b(stop-computer|restart-computer|shutdown)\b/i,
  /\breg(\.exe)?\s+(add|delete|import)\b/i,
  /\b(set-itemproperty|new-itemproperty|remove-itemproperty)\b/i,
  /\b(invoke-expression|iex)\b/i,
  /\b(invoke-webrequest|iwr|invoke-restmethod|irm|curl|wget)\b.*\|/i,
  /\bset-executionpolicy\b/i,
  /\b(bcdedit|diskpart|cipher|vssadmin|wmic)\b/i,
  /\bgit\s+(push|reset\s+--hard|clean|checkout\s+--|rebase|commit|branch\s+-D)\b/i,
  /\b(npm|pnpm|yarn)\s+(publish|unpublish)\b/i,
  /\bsc(\.exe)?\s+(delete|config|stop)\b/i,
  /(^|[^>])>{1,2}\s*[^&|]/, // output redirection writes files
]

export function commandRisk(cmd: string): Risk {
  return DESTRUCTIVE.some((r) => r.test(cmd)) ? 'high' : 'medium'
}

/** Document, media and archive types that open in a viewer rather than run code. */
const SAFE_TO_OPEN = /\.(txt|md|log|csv|tsv|json|xml|ya?ml|pdf|rtf|odt|ods|odp|docx|xlsx|pptx|png|jpe?g|gif|webp|bmp|svg|ico|heic|mp3|wav|flac|ogg|m4a|mp4|mkv|mov|webm|avi|zip|7z|rar|epub)$/i

/** Folders and known document types open in their viewer; anything else may run code. */
export function opensSafely(p: string): boolean {
  try {
    if (fs.statSync(p).isDirectory()) return true
  } catch {
    /* missing: judged by its name */
  }
  return SAFE_TO_OPEN.test(p)
}

/** The environment for commands Clawd runs, without API keys or tokens. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/(_API_KEY|_TOKEN|_SECRET|^CLAWD_)/i.test(k)) delete env[k]
  return env
}

function runPowerShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd, windowsHide: true, env: cleanEnv() })
    let out = ''
    const add = (b: Buffer) => {
      if (out.length < 200_000) out += b.toString('utf8')
    }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    let timedOut = false
    const killTree = () => {
      if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)
    const onAbort = () => killTree()
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code, out, timedOut })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, out: String(err), timedOut: false })
    })
  })
}

export const systemTools: AnyTool[] = [
  {
    name: 'clipboard_read',
    description: 'Reads the text currently on the clipboard.',
    category: 'clipboard',
    sendsContext: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    risk: () => 'low',
    describe: () => ({ title: 'Read the clipboard', details: 'Text currently copied' }),
    async run(_a, ctx) {
      const t = await ctx.host.call('clipboard.read')
      if (!t) return fail('The clipboard has no text.')
      return ok(t, { untrusted: 'clipboard', summary: `${t.length} characters` })
    },
  },
  {
    name: 'clipboard_write',
    description: 'Puts text on the clipboard (replacing what is there) so the user can paste it.',
    category: 'clipboard',
    parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 500000 } }, required: ['text'], additionalProperties: false },
    risk: () => 'low',
    describe: (a: { text: string }) => ({ title: `Copy to the clipboard (${a.text.length.toLocaleString('en-US')} characters)`, details: clip(a.text, 20000) }),
    escalateWhenTainted: () => true,
    async run(a: { text: string }, ctx) {
      await ctx.host.call('clipboard.write', a.text)
      const back = await ctx.host.call('clipboard.read')
      if (back !== a.text) return fail('The clipboard did not keep the text.')
      return ok('Copied to the clipboard.', { summary: `Copied ${a.text.length} characters` })
    },
  },
  {
    name: 'open_url',
    description: "Opens a web address in the user's default browser.",
    category: 'apps',
    parameters: { type: 'object', properties: { url: { type: 'string', maxLength: 2000 } }, required: ['url'], additionalProperties: false },
    risk: () => 'low',
    describe: (a: { url: string }) => ({ title: 'Open a link', details: a.url }),
    egress: (a: { url: string }) => [a.url],
    available: (s) => (s.permissions.appControl ? true : 'Application control is turned off in Settings > Permissions.'),
    async run(a: { url: string }, ctx) {
      if (!/^https?:\/\//i.test(a.url)) return fail('Only http(s) links can be opened.')
      const r = await ctx.host.call('apps.openUrl', a.url)
      return r.ok ? ok(`Opened ${a.url}.`, { artifacts: [{ kind: 'link', title: a.url, url: a.url }] }) : fail(r.message)
    },
  },
  {
    name: 'open_path',
    description: 'Opens a file or folder with its default application (e.g. a document in Word, a folder in Explorer).',
    category: 'apps',
    parameters: { type: 'object', properties: { path: { type: 'string', maxLength: 1000 } }, required: ['path'], additionalProperties: false },
    risk: (a: { path: string }) => (opensSafely(expandPath(a.path)) ? 'low' : 'high'),
    describe: (a: { path: string }) => ({ title: 'Open a file or folder', details: expandPath(a.path) }),
    needsApproval: (a: { path: string }) => (opensSafely(expandPath(a.path)) ? [] : ['may run a program (not a known document type)']),
    available: (s) => (s.permissions.appControl ? true : 'Application control is turned off in Settings > Permissions.'),
    async run(a: { path: string }, ctx) {
      const p = expandPath(a.path)
      if (!fs.existsSync(p)) return fail(`${p} does not exist.`)
      const r = await ctx.host.call('apps.openPath', p)
      return r.ok ? ok(`Opened ${p}.`) : fail(r.message)
    },
  },
  {
    name: 'open_app',
    description: 'Starts an installed application by name (as it appears in the Start menu), e.g. "Notepad", "Spotify", "Visual Studio Code".',
    category: 'apps',
    parameters: { type: 'object', properties: { name: { type: 'string', maxLength: 200 } }, required: ['name'], additionalProperties: false },
    risk: () => 'medium',
    describe: (a: { name: string }) => ({ title: 'Start an application', details: a.name }),
    available: (s) => (s.permissions.appControl ? true : 'Application control is turned off in Settings > Permissions.'),
    async run(a: { name: string }, ctx) {
      const r = await ctx.host.call('apps.launch', a.name)
      return r.ok ? ok(r.message) : fail(r.message)
    },
  },
  {
    name: 'run_command',
    description:
      'Runs a PowerShell command and returns its output (stdout and stderr). Use for developer tasks such as builds, git, or checking versions. Always needs the user\'s approval; prefer the file tools for file changes.',
    category: 'shell',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', maxLength: 8000 },
        cwd: { type: 'string', maxLength: 1000, description: 'Working folder (default: home).' },
        timeout_sec: { type: 'integer', minimum: 1, maximum: 900 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    risk: (a: { command: string }) => commandRisk(a.command),
    describe: (a: { command: string; cwd?: string }) => ({ title: 'Run a command', details: `${a.cwd ? `In ${expandPath(a.cwd)}:\n` : ''}${a.command}` }),
    needsApproval: () => ['runs a command on your computer'],
    available: (s) => (s.permissions.shell ? true : 'Running commands is turned off in Settings > Permissions.'),
    timeoutSec: 900,
    async run(a: { command: string; cwd?: string; timeout_sec?: number }, ctx) {
      const cwd = a.cwd ? expandPath(a.cwd) : process.env.USERPROFILE ?? 'C:\\'
      if (!fs.existsSync(cwd)) return fail(`Folder ${cwd} does not exist.`)
      ctx.progress(`Running: ${clip(a.command, 80)}`)
      const r = await runPowerShell(a.command, cwd, (a.timeout_sec ?? 120) * 1000, ctx.signal)
      const out = clip(r.out.trim(), 30000)
      if (r.timedOut) return fail(`The command timed out after ${a.timeout_sec ?? 120} s and was stopped.\n${out}`)
      if (r.code !== 0) return fail(`Exit code ${r.code}.\n${out}`, { untrusted: 'command output', summary: `exit ${r.code}` })
      return ok(out || '(no output)', { untrusted: 'command output', summary: `exit 0, ${r.out.length} chars` })
    },
  },
  {
    name: 'input_type_text',
    description: 'Types text into whatever has keyboard focus, as if the user typed it. Moves real input: needs approval every time.',
    category: 'input',
    parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 20000 } }, required: ['text'], additionalProperties: false },
    risk: () => 'high',
    describe: (a: { text: string }) => ({ title: `Type with the keyboard (${a.text.length.toLocaleString('en-US')} characters)`, details: a.text }),
    needsApproval: () => ['controls your keyboard'],
    available: (s) => (s.permissions.inputAutomation ? true : 'Keyboard and mouse automation is turned off in Settings > Permissions.'),
    async run(a: { text: string }, ctx) {
      const r = await ctx.host.call('input.type', a.text)
      return r.ok ? ok(`Typed ${a.text.length} characters into the focused window. Verify the result (e.g. read_window_text) before saying it worked.`) : fail(r.message)
    },
  },
  {
    name: 'input_press_keys',
    description: 'Presses a key combination in the focused window, e.g. "ctrl+s", "alt+tab", "enter". Needs approval every time.',
    category: 'input',
    parameters: { type: 'object', properties: { keys: { type: 'string', maxLength: 60 } }, required: ['keys'], additionalProperties: false },
    risk: () => 'high',
    describe: (a: { keys: string }) => ({ title: 'Press keys', details: a.keys }),
    needsApproval: () => ['controls your keyboard'],
    available: (s) => (s.permissions.inputAutomation ? true : 'Keyboard and mouse automation is turned off in Settings > Permissions.'),
    async run(a: { keys: string }, ctx) {
      const r = await ctx.host.call('input.keys', a.keys)
      return r.ok ? ok(`Pressed ${a.keys}.`) : fail(r.message)
    },
  },
  {
    name: 'input_click',
    description: 'Moves the real mouse to screen coordinates and clicks. Use list_ui_elements to find coordinates. Needs approval every time.',
    category: 'input',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean' } },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    risk: () => 'high',
    describe: (a: { x: number; y: number; button?: string; double?: boolean }) => ({ title: 'Click with the mouse', details: `${a.double ? 'Double-' : ''}${a.button ?? 'left'} click at (${Math.round(a.x)}, ${Math.round(a.y)})` }),
    needsApproval: () => ['controls your mouse'],
    available: (s) => (s.permissions.inputAutomation ? true : 'Keyboard and mouse automation is turned off in Settings > Permissions.'),
    async run(a: { x: number; y: number; button?: 'left' | 'right'; double?: boolean }, ctx) {
      const r = await ctx.host.call('input.click', a.x, a.y, a.button ?? 'left', !!a.double)
      return r.ok ? ok(`Clicked at (${Math.round(a.x)}, ${Math.round(a.y)}).`) : fail(r.message)
    },
  },
  {
    name: 'notify',
    description: 'Shows a desktop notification (useful at the end of long background work).',
    category: 'notify',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', maxLength: 120 }, body: { type: 'string', maxLength: 600 } },
      required: ['title', 'body'],
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: (a: { title: string }) => ({ title: 'Show a notification', details: a.title }),
    async run(a: { title: string; body: string }, ctx) {
      const shown = await ctx.host.call('notify', a.title, a.body, ctx.task.id)
      return shown ? ok('Notification shown.') : ok('Notifications are muted right now (focus mode, quiet hours, or turned off).')
    },
  },
]
