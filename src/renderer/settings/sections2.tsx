// Settings sections: Permissions & privacy, Focus & notifications, Integrations, Memory, Tasks, About.

import { useEffect, useState } from 'react'
import { Copy, FolderOpen, FolderPlus, Pin, PinOff, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import type { AppInfo, BrowserStatus, CCInstallStatus, Diagnostics, TaskSummary } from '../../shared/api'
import { PERMISSION_CATEGORIES, PERMISSION_PRESETS, type PermissionCategory, type PermissionRule } from '../../shared/settings'
import type { CCSession, IntegrationStatus, MemoryItem, MemoryKind, PermissionDecisionRecord, SkillInfo } from '../../shared/types'
import { TaskDetail } from '../panel/App'
import { invoke, on } from '../shared/bridge'
import { Badge, Segmented, Select, Slider, Spinner, timeAgo, Toggle } from '../shared/ui'
import type { SectionProps } from './App'
import { Callout, Row, Section } from './kit'

const CATEGORY_INFO: Record<PermissionCategory, { label: string; desc: string }> = {
  context: { label: 'Read the active window', desc: 'App name, window title, selected text, accessible window text.' },
  screen: { label: 'Take screenshots', desc: 'Capture the screen or a window for the model to look at.' },
  web: { label: 'Search and read the web', desc: 'Public web search and pages.' },
  browser: { label: 'Read your browser tabs', desc: 'Through the Clawd browser extension.' },
  clipboard: { label: 'Use the clipboard', desc: 'Read and write copied text.' },
  files_read: { label: 'Read files', desc: 'Inside your allowed folders; anything else always asks.' },
  files_write: { label: 'Create and change files', desc: 'Backed up first, so changes can be undone.' },
  files_delete: { label: 'Delete files', desc: 'To the Recycle Bin, with a backup.' },
  apps: { label: 'Open apps and links', desc: 'Start applications, open files and web links.' },
  input: { label: 'Control keyboard and mouse', desc: 'Typing and clicking for you. Always asks.' },
  shell: { label: 'Run commands', desc: 'PowerShell commands. Always asks.' },
  claude_code: { label: 'Instruct Claude Code', desc: 'Start a separate Claude Code run. Always asks.' },
  memory: { label: 'Save memories', desc: 'Remember preferences and facts.' },
  notify: { label: 'Show notifications', desc: '' },
}

export function PermissionsSection({ s, set }: SectionProps) {
  const p = s.permissions
  const [history, setHistory] = useState<PermissionDecisionRecord[]>([])
  useEffect(() => void invoke('permissions:history').then(setHistory), [])
  const setRule = (c: PermissionCategory, r: PermissionRule) => set({ permissions: { preset: 'custom', rules: { [c]: r } } })
  return (
    <>
      <Section title="What Clawd may do" desc="Risky actions (deleting, commands, typing for you, overwriting files) always ask, whatever is set here. After Clawd has read web pages, documents or other apps during a task, anything consequential asks too, so instructions hidden in content can't act on your behalf.">
        <Row label="Preset" keywords="careful balanced trusting">
          <Segmented
            value={p.preset}
            onChange={(v) => (v === 'custom' ? set({ permissions: { preset: v } }) : set({ permissions: { preset: v, rules: { ...PERMISSION_PRESETS[v] } } }))}
            options={[{ value: 'careful', label: 'Careful' }, { value: 'balanced', label: 'Balanced' }, { value: 'trusting', label: 'Trusting' }, { value: 'custom', label: 'Custom' }]}
          />
        </Row>
        {PERMISSION_CATEGORIES.map((c) => (
          <Row key={c} label={CATEGORY_INFO[c].label} desc={CATEGORY_INFO[c].desc} keywords={`permission ${c}`}>
            <Segmented value={p.rules[c]} onChange={(r) => setRule(c, r)} options={[{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask' }, { value: 'deny', label: 'Deny' }]} />
          </Row>
        ))}
      </Section>
      <Section title="Capabilities">
        <Row label="Keyboard and mouse automation" desc="Off removes these tools entirely." keywords="input typing clicking">
          <Toggle checked={p.inputAutomation} onChange={(v) => set({ permissions: { inputAutomation: v } })} />
        </Row>
        <Row label="Open applications" keywords="launch apps">
          <Toggle checked={p.appControl} onChange={(v) => set({ permissions: { appControl: v } })} />
        </Row>
        <Row label="Run commands" keywords="powershell shell terminal">
          <Toggle checked={p.shell} onChange={(v) => set({ permissions: { shell: v } })} />
        </Row>
        <Row label="Allowed folders" desc="Clawd reads and writes here without extra questions (per the rules above). Anything outside always asks. Empty means your Documents, Desktop, Downloads and project folders." keywords="file access directories" stack>
          <div className="folders">
            {p.fileRoots.map((f) => (
              <div key={f} className="folder">
                <FolderOpen size={13} />
                <span className="mono">{f}</span>
                <button className="btn ghost icon sm" onClick={() => set({ permissions: { fileRoots: p.fileRoots.filter((x) => x !== f) } })}>
                  <X size={13} />
                </button>
              </div>
            ))}
            <button
              className="btn sm"
              onClick={async () => {
                const dir = await invoke('app:pickFolder')
                if (dir && !p.fileRoots.includes(dir)) set({ permissions: { fileRoots: [...p.fileRoots, dir] } })
              }}
            >
              <FolderPlus size={13} /> Add folder
            </button>
          </div>
        </Row>
      </Section>
      <Section title="Privacy">
        <Row label="Microphone" desc="Off stops all listening, including the wake word.">
          <Toggle checked={s.privacy.microphone} onChange={(v) => set({ privacy: { microphone: v } })} />
        </Row>
        <Row label="Screen awareness" desc="Clawd notices which app is in front and reads it when you ask. Nothing is sent anywhere unless you make a request. Off disables all screen context." keywords="active window context">
          <Toggle checked={s.privacy.screenAwareness} onChange={(v) => set({ privacy: { screenAwareness: v } })} />
        </Row>
        <Row label="Clipboard companion" desc="When you copy text, Clawd may offer to explain or summarise it. He only looks locally; nothing is sent unless you click an offer." keywords="clipboard monitor copy">
          <Toggle checked={s.privacy.clipboardMonitor} onChange={(v) => set({ privacy: { clipboardMonitor: v } })} />
        </Row>
        <Row label="Browser access" desc="Let Clawd read pages through his browser extension.">
          <Toggle checked={s.privacy.browserAccess} onChange={(v) => set({ privacy: { browserAccess: v } })} />
        </Row>
        <Row label="Sending your context to hosted models" desc="With a cloud provider, ask before your selection, screen, clipboard or pages are sent. Local models never send anything off this PC." keywords="cloud data external">
          <Segmented value={s.privacy.cloudContext} onChange={(v) => set({ privacy: { cloudContext: v } })} options={[{ value: 'ask', label: 'Ask each task' }, { value: 'allow', label: 'Allow' }]} />
        </Row>
      </Section>
      <Section title="Permission history">
        <div className="history">
          {history.slice(0, 40).map((h) => (
            <div key={h.requestId + h.at} className="history-row">
              <span className="faint mono">{new Date(h.at).toLocaleString()}</span>
              <span>{h.summary}</span>
              <Badge tone={h.decision === 'deny' ? 'danger' : 'ok'}>{h.decision.replace('_', ' ')}</Badge>
              <span className="faint">{h.automatic ? 'rule' : 'you'}</span>
            </div>
          ))}
          {!history.length && <div className="faint">Nothing yet.</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn" onClick={() => void invoke('permissions:clearAlways')}>
            Forget all "always allow" choices
          </button>
        </div>
      </Section>
    </>
  )
}

export function SuggestionsSection({ s, set }: SectionProps) {
  const f = s.focus
  const n = s.notifications
  const g = s.suggestions
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return (
    <>
      <Section title="Focus mode" desc="Clawd becomes still and quiet: fewer animations, no suggestions, no nonessential notifications. Permission requests still reach you, and the shortcut still works.">
        <Row label="Focus mode now" keywords="do not disturb quiet">
          <Toggle checked={f.active} onChange={(v) => set({ focus: { active: v } })} />
        </Row>
        <Row label="Turn on automatically">
          <Segmented value={f.trigger} onChange={(v) => set({ focus: { trigger: v } })} options={[{ value: 'manual', label: 'Manually' }, { value: 'schedule', label: 'On a schedule' }, { value: 'apps', label: 'In certain apps' }]} />
        </Row>
        {f.trigger === 'schedule' && (
          <Row label="Schedule">
            <div className="inline">
              {days.map((d, i) => (
                <button key={d} className={`btn sm ${f.days.includes(i) ? 'primary' : ''}`} onClick={() => set({ focus: { days: f.days.includes(i) ? f.days.filter((x) => x !== i) : [...f.days, i].sort() } })}>
                  {d}
                </button>
              ))}
              <input className="input" type="time" value={f.start} onChange={(e) => set({ focus: { start: e.target.value } })} style={{ width: 100 }} />
              –
              <input className="input" type="time" value={f.end} onChange={(e) => set({ focus: { end: e.target.value } })} style={{ width: 100 }} />
            </div>
          </Row>
        )}
        {f.trigger === 'apps' && (
          <Row label="Apps" desc="Program file names, comma separated (e.g. Code.exe, WINWORD.EXE)." stack>
            <input className="input" style={{ width: '100%' }} defaultValue={f.apps.join(', ')} onBlur={(e) => set({ focus: { apps: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} />
          </Row>
        )}
      </Section>
      <Section title="Quick suggestions" desc="Occasional offers in Clawd's speech bubble. Dismissed offers don't come back for a day.">
        <Row label="Suggestions">
          <Toggle checked={g.enabled} onChange={(v) => set({ suggestions: { enabled: v } })} />
        </Row>
        <Row label="How often" desc="At most one every 15 minutes (rare) or 4 minutes (normal).">
          <Segmented value={g.frequency} onChange={(v) => set({ suggestions: { frequency: v } })} options={[{ value: 'rare', label: 'Rare' }, { value: 'normal', label: 'Normal' }]} />
        </Row>
        {(
          [
            ['errors', 'Error dialogs', 'Offer to explain an error that pops up.'],
            ['builds', 'Claude Code errors', 'Offer to investigate when a Claude Code tool fails.'],
            ['clipboard', 'Copied text', 'Needs the clipboard companion (Privacy).'],
            ['articles', 'Long articles', 'Offer a summary of a long page in your browser.'],
          ] as const
        ).map(([k, label, desc]) => (
          <Row key={k} label={label} desc={desc}>
            <Toggle checked={g[k]} onChange={(v) => set({ suggestions: { [k]: v } })} />
          </Row>
        ))}
      </Section>
      <Section title="Notifications">
        <Row label="Desktop notifications">
          <Toggle checked={n.enabled} onChange={(v) => set({ notifications: { enabled: v } })} />
        </Row>
        {(
          [
            ['taskDone', 'A long task finished'],
            ['taskFailed', 'A task failed'],
            ['permission', 'Clawd needs permission'],
            ['claudeCode', 'Claude Code needs attention or finished'],
            ['integration', 'An integration stopped working'],
          ] as const
        ).map(([k, label]) => (
          <Row key={k} label={label}>
            <Toggle checked={n[k]} onChange={(v) => set({ notifications: { [k]: v } })} />
          </Row>
        ))}
        <Row label="Only for tasks longer than" desc="Short tasks you watched don't need a notification.">
          <Slider value={n.minTaskSeconds} min={0} max={300} step={5} onChange={(v) => set({ notifications: { minTaskSeconds: v } })} format={(v) => `${v}s`} />
        </Row>
        <Row label="Quiet hours">
          <div className="inline">
            <Toggle checked={n.quietHours} onChange={(v) => set({ notifications: { quietHours: v } })} />
            <input className="input" type="time" value={n.quietStart} onChange={(e) => set({ notifications: { quietStart: e.target.value } })} style={{ width: 100 }} />–
            <input className="input" type="time" value={n.quietEnd} onChange={(e) => set({ notifications: { quietEnd: e.target.value } })} style={{ width: 100 }} />
          </div>
        </Row>
      </Section>
    </>
  )
}

export function IntegrationsSection({ s, set }: SectionProps) {
  const [cc, setCc] = useState<CCInstallStatus | null>(null)
  const [sessions, setSessions] = useState<CCSession[]>([])
  const [browser, setBrowser] = useState<BrowserStatus | null>(null)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [status, setStatus] = useState<IntegrationStatus[]>([])
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const load = () => {
    void invoke('cc:status').then(setCc)
    void invoke('cc:sessions').then(setSessions)
    void invoke('browser:status').then(setBrowser)
    void invoke('skills:list').then(setSkills).catch(() => {})
    void invoke('integrations:status').then(setStatus)
  }
  useEffect(() => {
    load()
    const offs = [on('cc:sessions', setSessions), on('browser:status', setBrowser), on('integrations:changed', setStatus)]
    return () => offs.forEach((f) => f())
  }, [])
  const guard = async (fn: () => Promise<unknown>) => {
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
    load()
  }
  return (
    <>
      <Section title="Status">
        {status.map((st) => (
          <Row key={st.id} label={st.label} desc={st.detail}>
            <Badge tone={st.ok ? 'ok' : 'warn'} dot>
              {st.ok ? 'OK' : 'Check'}
            </Badge>
          </Row>
        ))}
      </Section>
      {err && <Callout tone="danger">{err}</Callout>}
      <Section title="Claude Code" desc="Clawd watches Claude Code through its official hooks: lightweight observer scripts that report what a session is doing. They never block or change Claude Code. Clawd's own AI stays separate.">
        <Row label="Claude Code integration" keywords="hooks coding companion">
          <Toggle checked={s.integrations.claudeCode} onChange={(v) => set({ integrations: { claudeCode: v } })} />
        </Row>
        <Row label="Hooks" desc={cc ? `In ${cc.settingsPath}. ${cc.otherHooks ? `${cc.otherHooks} other hook(s) there are left untouched. ` : ''}A backup is made before every change.` : ''} warn={cc?.error}>
          <div className="inline">
            {cc && <Badge tone={cc.installed ? 'ok' : 'warn'} dot>{cc.installed ? `Installed (${cc.events.length} events)` : 'Not installed'}</Badge>}
            {cc?.installed ? (
              <button className="btn" onClick={() => void guard(() => invoke('cc:uninstall'))}>
                Remove hooks
              </button>
            ) : (
              <button className="btn primary" onClick={() => void guard(() => invoke('cc:install'))}>
                Install hooks
              </button>
            )}
          </div>
        </Row>
        <Row label="Sessions" desc="Choose whose activity drives Clawd's laptop animation and whose context he uses." stack>
          <div className="sessions">
            {sessions.length === 0 && <div className="faint">No sessions seen yet. Start Claude Code in a terminal after installing the hooks.</div>}
            {sessions.map((x) => (
              <button key={x.id} className="session" onClick={() => void invoke('cc:select', x.id)}>
                <span className="mono">{x.project}</span>
                <Badge tone={x.state === 'failed' ? 'danger' : x.state.startsWith('waiting') ? 'warn' : x.state === 'disconnected' ? undefined : 'ok'} dot>
                  {x.state.replace('_', ' ')}
                  {x.certain ? '' : '?'}
                </Badge>
                <span className="faint">{timeAgo(x.updatedAt)}</span>
              </button>
            ))}
          </div>
        </Row>
      </Section>
      <Section title="Browser extension" desc="Lets Clawd read whole pages (beyond what's visible) when you ask, e.g. “summarize this entire page”. Works in Chromium browsers: Arc, Edge, Chrome, Brave.">
        <Row label="Browser integration">
          <Toggle checked={s.integrations.browser} onChange={(v) => set({ integrations: { browser: v } })} />
        </Row>
        <Row label="Connection">{browser && <Badge tone={browser.connected ? 'ok' : 'warn'} dot>{browser.connected ? `Connected: ${browser.clients.map((c) => c.browser).join(', ')}` : 'Not connected'}</Badge>}</Row>
        <Row label="Install" desc="1. Open your browser's extensions page (arc://extensions, edge://extensions or chrome://extensions) and turn on Developer mode. 2. Click “Load unpacked” and choose the extension folder. 3. Open the extension, paste the pairing code, and connect." stack>
          <div className="inline">
            <button className="btn" onClick={() => void invoke('browser:openExtensionFolder')}>
              <FolderOpen size={13} /> Open extension folder
            </button>
            {browser && (
              <button
                className="btn"
                onClick={async () => {
                  await invoke('app:copy', `${browser.port}:${browser.token}`)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }}
              >
                <Copy size={13} /> {copied ? 'Copied' : 'Copy pairing code'}
              </button>
            )}
          </div>
        </Row>
      </Section>
      <Section title="Skills" desc="Skills teach Clawd how to handle certain kinds of tasks. They are instructions only: anything a skill suggests still runs through your permissions. Skills with warnings start disabled.">
        {skills.map((k) => (
          <Row key={k.id} label={`${k.name}  ·  v${k.version}${k.builtin ? '  ·  built-in' : ''}`} desc={k.description} warn={[...k.errors, ...k.warnings].join(' ') || undefined} keywords={`skill ${k.taskTypes.join(' ')}`}>
            <div className="inline">
              {k.permissions.length > 0 && <span className="faint" style={{ fontSize: 12 }}>uses {k.permissions.join(', ')}</span>}
              {!k.builtin && (
                <button className="btn ghost icon sm" title="Remove" onClick={() => void guard(() => invoke('skills:remove', k.id))}>
                  <Trash2 size={13} />
                </button>
              )}
              <Toggle checked={k.enabled} disabled={k.errors.length > 0} onChange={(v) => void guard(() => invoke('skills:enable', k.id, v))} />
            </div>
          </Row>
        ))}
        <div className="inline" style={{ padding: '10px 14px' }}>
          <button className="btn" onClick={() => void guard(() => invoke('skills:install'))}>
            <Upload size={13} /> Install a skill folder
          </button>
          <button className="btn ghost" onClick={() => void invoke('skills:openFolder')}>
            <FolderOpen size={13} /> Open skills folder
          </button>
        </div>
      </Section>
      <Section title="Troubleshooting">
        <Row label="Diagnostics" desc="Recent log lines and performance; useful when something misbehaves.">
          <button className="btn" onClick={() => void invoke('app:diagnostics').then(setDiag)}>
            <RefreshCw size={13} /> Collect
          </button>
        </Row>
        {diag && (
          <div style={{ padding: '0 14px 14px' }}>
            {diag.perf && (
              <div className="faint" style={{ marginBottom: 6 }}>
                Overlay: {diag.perf.fps.toFixed(0)} fps, {diag.perf.frameMs.toFixed(2)} ms per frame · Main process CPU {diag.perf.cpu.toFixed(1)}% · {diag.perf.memoryMB} MB
              </div>
            )}
            <pre className="log">{diag.logTail.join('\n')}</pre>
          </div>
        )}
      </Section>
    </>
  )
}

const KINDS: MemoryKind[] = ['preference', 'fact', 'project', 'workflow', 'correction', 'note']

export function MemorySection({ s, set }: SectionProps) {
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState('')
  const [kind, setKind] = useState<MemoryKind>('preference')
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const load = (query = q) => void invoke('memory:list', query || undefined).then(setItems).catch((e) => setErr(String(e.message)))
  useEffect(() => {
    load()
  }, [])
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
    load()
  }
  return (
    <>
      <Section title="Memory settings" desc="Memory is separate from conversation history. It holds durable things: preferences, corrections, projects, workflows and anything you ask Clawd to remember. Credentials are never stored.">
        <Row label="Remember things between conversations">
          <Toggle checked={s.memory.enabled} onChange={(v) => set({ memory: { enabled: v } })} />
        </Row>
        <Row label="When Clawd wants to remember something" desc="Ask: he proposes and you confirm. Automatic: he saves durable preferences himself.">
          <Segmented value={s.memory.autoRemember} onChange={(v) => set({ memory: { autoRemember: v } })} options={[{ value: 'ask', label: 'Ask me' }, { value: 'auto', label: 'Automatic' }, { value: 'off', label: 'Never' }]} />
        </Row>
        <Row label="Forget unused memories after" desc="Pinned memories are always kept.">
          <Select value={String(s.memory.retentionDays)} onChange={(v) => set({ memory: { retentionDays: Number(v) } })} options={[{ value: '0', label: 'Never' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '1 year' }]} />
        </Row>
      </Section>
      {err && <Callout tone="danger">{err}</Callout>}
      <Section title="What Clawd remembers">
        <div className="mem-tools">
          <input className="input" placeholder="Search memories" value={q} onChange={(e) => (setQ(e.target.value), load(e.target.value))} style={{ flex: 1 }} />
          <button
            className="btn danger"
            disabled={!items?.length}
            onClick={() => {
              if (confirm('Forget everything Clawd remembers? This cannot be undone.')) void run(() => invoke('memory:clear'))
            }}
          >
            <Trash2 size={13} /> Clear all
          </button>
        </div>
        <div className="mem-add">
          <input className="input" placeholder="Add something for Clawd to remember…" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && draft.trim() && void run(async () => (await invoke('memory:add', draft.trim(), kind), setDraft('')))} />
          <Select width={130} value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: k }))} />
          <button className="btn primary" disabled={!draft.trim()} onClick={() => void run(async () => (await invoke('memory:add', draft.trim(), kind), setDraft('')))}>
            <Plus size={13} /> Add
          </button>
        </div>
        <div className="mem-list">
          {!items && <Spinner />}
          {items?.length === 0 && <div className="faint" style={{ padding: 14 }}>Nothing remembered yet.</div>}
          {items?.map((m) => (
            <div key={m.id} className="mem">
              <Badge tone={m.kind === 'correction' ? 'warn' : m.kind === 'preference' ? 'accent' : undefined}>{m.kind}</Badge>
              {editing === m.id ? (
                <input className="input" autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} style={{ flex: 1 }} onKeyDown={(e) => {
                  if (e.key === 'Enter') void run(async () => (await invoke('memory:update', m.id, { text: editText }), setEditing(null)))
                  if (e.key === 'Escape') setEditing(null)
                }} />
              ) : (
                <span className="mem-text" onDoubleClick={() => (setEditing(m.id), setEditText(m.text))} title="Double-click to edit">
                  {m.text}
                </span>
              )}
              <span className="faint mem-meta">
                {m.source === 'agent' ? 'Clawd' : 'you'} · used {m.useCount}×
              </span>
              <button className="btn ghost icon sm" title={m.pinned ? 'Unpin' : 'Pin (always use, never expires)'} onClick={() => void run(() => invoke('memory:update', m.id, { pinned: !m.pinned }))}>
                {m.pinned ? <PinOff size={13} /> : <Pin size={13} />}
              </button>
              <button className="btn ghost icon sm" title="Forget" onClick={() => void run(() => invoke('memory:remove', m.id))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </Section>
    </>
  )
}

export function TasksSection({ s, set }: SectionProps) {
  const [list, setList] = useState<TaskSummary[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const load = () => void invoke('tasks:list').then(setList).catch(() => setList([]))
  useEffect(() => {
    load()
  }, [])
  if (open)
    return (
      <div className="s-card" style={{ padding: 16 }}>
        <TaskDetail id={open} back={() => setOpen(null)} />
      </div>
    )
  return (
    <>
      <Section title="History & recovery">
        <Row label="Keep task history for" keywords="retention timeline">
          <Select value={String(s.tasks.retentionDays)} onChange={(v) => set({ tasks: { retentionDays: Number(v) } })} options={[7, 30, 90, 365].map((d) => ({ value: String(d), label: `${d} days` }))} />
        </Row>
        <Row label="Store tool outputs" desc="Full keeps what each step returned (useful for review). Summary keeps only short descriptions." keywords="logging privacy">
          <Segmented value={s.tasks.detail} onChange={(v) => set({ tasks: { detail: v } })} options={[{ value: 'full', label: 'Full' }, { value: 'summary', label: 'Summary' }]} />
        </Row>
        <Row label="Keep file backups for undo" desc="Clawd copies files before changing them so you can revert.">
          <Select value={String(s.tasks.undoRetentionDays)} onChange={(v) => set({ tasks: { undoRetentionDays: Number(v) } })} options={[3, 7, 14, 30, 90].map((d) => ({ value: String(d), label: `${d} days` }))} />
        </Row>
      </Section>
      <Section title="Recent tasks">
        <div className="tasks">
          {!list && <Spinner />}
          {list?.length === 0 && <div className="faint" style={{ padding: 14 }}>No tasks yet.</div>}
          {list?.map((t) => (
            <button key={t.id} className="task" onClick={() => setOpen(t.id)}>
              <Badge tone={t.status === 'done' ? 'ok' : t.status === 'failed' ? 'danger' : t.status === 'interrupted' ? 'warn' : undefined} dot>
                {t.status}
              </Badge>
              <span className="task-req">{t.request}</span>
              {t.files > 0 && <span className="faint">{t.files} file change{t.files === 1 ? '' : 's'}</span>}
              <span className="faint">{timeAgo(t.createdAt)}</span>
            </button>
          ))}
        </div>
        {!!list?.length && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 14px 12px' }}>
            <button
              className="btn danger"
              onClick={() => {
                if (confirm('Delete the whole task history? File backups for undo are kept until they expire.')) void invoke('tasks:clear').then(load)
              }}
            >
              <Trash2 size={13} /> Clear history
            </button>
          </div>
        )}
      </Section>
    </>
  )
}

export function AboutSection() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => void invoke('app:info').then(setInfo), [])
  return (
    <>
      <Section title="Clawd">
        <Row label="Version" desc={info ? `${info.version} · Electron ${info.electron} · ${info.platform}` : ''} />
        <Row label="Data folder" desc={info?.dataDir}>
          <button className="btn" onClick={() => info && void invoke('app:openPath', info.dataDir)}>
            <FolderOpen size={13} /> Open
          </button>
        </Row>
        <Row label="Logs" desc={info?.logsDir}>
          <button className="btn" onClick={() => info && void invoke('app:openPath', info.logsDir)}>
            <FolderOpen size={13} /> Open
          </button>
        </Row>
      </Section>
      <Callout>
        Clawd is a fan-made desktop companion inspired by Anthropic's Clawd mascot. It is not an official Anthropic product and is not affiliated with or endorsed by Anthropic. Clawd runs on whichever AI model you choose.
      </Callout>
      <Section title="Open-source parts">
        <Row label="sherpa-onnx" desc="Wake word, speech recognition and speech synthesis runtime (Apache-2.0)." />
        <Row label="Kokoro-82M" desc="Clawd's voice (Apache-2.0)." />
        <Row label="Moonshine" desc="Speech recognition model (MIT)." />
        <Row label="Silero VAD" desc="Voice activity detection (MIT)." />
        <Row label="Mozilla Readability" desc="Article extraction for web pages (Apache-2.0)." />
        <Row label="Electron, React, Lucide, Geist, Silkscreen" desc="App framework, UI, icons and fonts (MIT / ISC / OFL)." />
      </Section>
    </>
  )
}
