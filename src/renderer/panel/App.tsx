// Clawd's side-buddy panel: a quick-ask bar, context-aware actions, and one result card with ways
// to apply or tweak it. Earlier results live in History rather than a scrolling chat.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  ClipboardCopy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  GitCompare,
  Globe,
  History,
  LoaderCircle,
  MessageSquareText,
  Mic,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Pin,
  PinOff,
  Plus,
  Replace,
  Settings as Gear,
  ShieldAlert,
  Square,
  TextCursorInput,
  Undo2,
  VolumeX,
  X,
} from 'lucide-react'
import type { AgentSnapshot, BrowserStatus, SummonContext, TaskSummary, VoiceStatus } from '../../shared/api'
import { isWritingTask, quickActionsFor, siteOf, TWEAKS, type QuickAction } from '../../shared/quick-actions'
import type { AgentEvent, AgentPhase, ChatMessage, Clarification, PermissionDecision, PermissionRequest, ProviderStatus, TaskRecord, TaskStep } from '../../shared/types'
import { invoke, on } from '../shared/bridge'
import { ClawdMini } from '../shared/ClawdMini'
import { wordDiff } from '../shared/diff'
import { Badge, cx, duration, Markdown, Spinner, timeAgo, useSettings, useTheme } from '../shared/ui'

type View = { kind: 'home' } | { kind: 'history' } | { kind: 'task'; id: string }

const PHASE_LABEL: Record<AgentPhase, string> = {
  idle: 'Ready',
  thinking: 'Thinking',
  working: 'Working',
  waiting_permission: 'Needs your OK',
  waiting_user: 'Waiting for your answer',
  speaking: 'Speaking',
  done: 'Done',
  error: 'Something went wrong',
  cancelled: 'Stopped',
}

const clean = (m: string) => m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function App() {
  const [settings] = useSettings()
  useTheme(settings?.general.theme)
  const [view, setView] = useState<View>({ kind: 'home' })
  const [tasks, setTasks] = useState<Record<string, TaskRecord>>({})
  const [answers, setAnswers] = useState<Record<string, ChatMessage>>({})
  const [current, setCurrent] = useState<string | null>(null)
  const [phase, setPhase] = useState<AgentPhase>('idle')
  const [activeTask, setActiveTask] = useState<string | null>(null)
  const [stream, setStream] = useState<Record<string, string>>({})
  const [perms, setPerms] = useState<PermissionRequest[]>([])
  const [asks, setAsks] = useState<Clarification[]>([])
  const [proposals, setProposals] = useState<{ id: string; text: string }[]>([])
  const [ctx, setCtx] = useState<SummonContext | null>(null)
  const [useCtx, setUseCtx] = useState(true)
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null)
  const [voice, setVoice] = useState<VoiceStatus | null>(null)
  const [pinned, setPinned] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // Original selections/drafts by task, kept in memory only, for "Compare".
  const [originals, setOriginals] = useState<Record<string, string>>({})
  const [fresh, setFresh] = useState(true)
  const [voiceHint, setVoiceHint] = useState<string | null>(null)
  const [model, setModel] = useState<ProviderStatus | null>(null)
  const [browser, setBrowser] = useState<BrowserStatus | null>(null)
  const modelCheckedAt = useRef(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const activeTaskRef = useRef<string | null>(null)
  activeTaskRef.current = activeTask
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const viewRef = useRef(view)
  viewRef.current = view

  const loadTask = (id: string) => void invoke('tasks:get', id).then((t) => t && setTasks((prev) => ({ ...prev, [t.id]: t })))

  const refresh = useCallback(async () => {
    const [conv, snap] = await Promise.all([invoke('agent:conversation'), invoke('agent:snapshot')])
    setSnapshot(snap)
    setPhase(snap.phase)
    setActiveTask(snap.taskId)
    setPerms(snap.pending)
    setAsks(snap.clarifications)
    setCtx(snap.context)
    const map: Record<string, ChatMessage> = {}
    for (const m of conv) if (m.role === 'assistant' && m.taskId) map[m.taskId] = m
    setAnswers(map)
    const lastMsg = conv[conv.length - 1]
    const show = snap.taskId ?? lastMsg?.taskId ?? null
    // Results older than a few minutes are history; the panel opens clean.
    if (show && (snap.taskId || (lastMsg && Date.now() - lastMsg.createdAt < 10 * 60_000))) {
      setCurrent(show)
      setFresh(false)
      loadTask(show)
    }
  }, [])

  const checkModel = useCallback((force = false) => {
    if (!force && Date.now() - modelCheckedAt.current < 60_000) return
    modelCheckedAt.current = Date.now()
    void invoke('agent:checkModel').then((st) => {
      setModel(st)
      if (!st.ok) modelCheckedAt.current = 0
    }).catch(() => {})
  }, [])

  useEffect(() => {
    void refresh().catch(() => setNotice('Clawd is still waking up…'))
    void invoke('voice:status').then(setVoice)
    void invoke('browser:status').then(setBrowser).catch(() => {})
    checkModel()
    const offs = [
      on('agent:event', (e: AgentEvent) => {
        switch (e.type) {
          case 'phase':
            setPhase(e.phase)
            setActiveTask(e.phase === 'idle' || e.phase === 'done' || e.phase === 'error' || e.phase === 'cancelled' ? null : e.taskId)
            if (e.taskId && e.phase === 'thinking') setCurrent(e.taskId)
            if (e.phase === 'done' || e.phase === 'error' || e.phase === 'cancelled') void invoke('agent:snapshot').then(setSnapshot)
            break
          case 'task':
            setTasks((prev) => ({ ...prev, [e.task.id]: e.task }))
            break
          case 'delta':
            setStream((s) => ({ ...s, [e.taskId]: (s[e.taskId] ?? '') + e.text }))
            break
          case 'message':
            if (e.message.role === 'assistant' && e.message.taskId) {
              setAnswers((a) => ({ ...a, [e.message.taskId!]: e.message }))
              setStream((s) => ({ ...s, [e.message.taskId!]: '' }))
            }
            if (e.message.taskId) setCurrent(e.message.taskId)
            break
          case 'permission':
            setPerms((p) => [...p.filter((x) => x.id !== e.request.id), e.request])
            break
          case 'permission_resolved':
            setPerms((p) => p.filter((x) => x.id !== e.id))
            break
          case 'clarify':
            setAsks((a) => [...a, e.request])
            break
          case 'clarify_resolved':
            setAsks((a) => a.filter((x) => x.id !== e.id))
            break
          case 'memory_proposal':
            setProposals((p) => [...p, { id: e.id, text: e.text }])
            break
        }
      }),
      on('panel:focusInput', (p) => {
        setView({ kind: 'home' })
        checkModel()
        if (p.context !== undefined) {
          setCtx(p.context ?? null)
          setUseCtx(true)
          // A fresh summon with new context starts a new topic.
          if (p.context && (p.context.selection || p.context.draft || p.context.url)) {
            setFresh(true)
            setCurrent((c) => (c && activeTaskRef.current === c ? c : null))
          }
        }
        setTimeout(() => inputRef.current?.focus(), 30)
      }),
      on('panel:show', (p) => {
        if (p.taskId) setView({ kind: 'task', id: p.taskId })
      }),
      on('voice:status', (v) => {
        setVoice(v)
        if (v.listening) setVoiceHint(null)
      }),
      on('browser:status', setBrowser),
      on('panel:voiceText', ({ text }) => {
        if (text) void sendRef.current(text, { source: 'voice' })
        else setVoiceHint("Didn't catch that. Try again, or type.")
      }),
    ]
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const v = voiceRef.current
      if (v?.speaking) void invoke('voice:stopSpeaking')
      else if (v?.listening || v?.recognizing) void invoke('voice:cancel')
      else if (viewRef.current.kind !== 'home') setView(viewRef.current.kind === 'task' ? { kind: 'history' } : { kind: 'home' })
      else void invoke('panel:hide')
    }
    window.addEventListener('keydown', esc)
    return () => {
      offs.forEach((f) => f())
      window.removeEventListener('keydown', esc)
    }
  }, [refresh, checkModel])

  // Grow the window with its content (bounded) so a short answer stays compact.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    let t = 0
    const measure = () => {
      window.clearTimeout(t)
      t = window.setTimeout(() => {
        const top = el.querySelector('.top') as HTMLElement
        const body = el.querySelector('.content > *') as HTMLElement | null
        const notice = el.querySelector('.notice') as HTMLElement | null
        const bodyH = body && body.childElementCount ? body.scrollHeight + 22 : 0
        const want = top.offsetHeight + bodyH + (notice?.offsetHeight ?? 0) + 20
        void invoke('panel:size', Math.max(150, Math.min(640, want)))
      }, 40)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el.querySelector('.top')!)
    const body = el.querySelector('.content > *')
    if (body) ro.observe(body)
    measure()
    return () => ro.disconnect()
  })

  const busy = !!activeTask && phase !== 'done' && phase !== 'error' && phase !== 'cancelled'

  const send = async (text: string, opts: { fresh?: boolean; skill?: string; source?: 'text' | 'voice'; applyTo?: 'draft' | 'selection'; label?: string } = {}) => {
    const t = text.trim()
    if (!t) return
    setNotice(null)
    setVoiceHint(null)
    setView({ kind: 'home' })
    const startFresh = opts.fresh ?? fresh
    try {
      const { taskId } = await invoke('agent:send', t, { source: opts.source ?? 'text', useSelection: useCtx, fresh: startFresh, skill: opts.skill, applyTo: opts.applyTo, label: opts.label })
      const orig = useCtx ? (ctx?.draft ?? ctx?.selection) : undefined
      if (orig && startFresh) setOriginals((o) => ({ ...o, [taskId]: orig }))
      else if (current && originals[current]) setOriginals((o) => ({ ...o, [taskId]: o[current] }))
      setCurrent(taskId)
      setFresh(false)
    } catch (err) {
      setNotice(clean((err as Error).message))
    }
  }

  // Voice text arrives through a listener set up once; it must reach the current send().
  const sendRef = useRef(send)
  sendRef.current = send

  const actions = useMemo(() => (useCtx ? quickActionsFor(ctx) : quickActionsFor(null)), [ctx, useCtx])
  const task = current ? tasks[current] : undefined
  const answer = current ? answers[current] : undefined

  return (
    <div className="shell" ref={rootRef}>
      <div className="card">
        <div className="top">
          <Header
            phase={phase}
            snapshot={snapshot}
            model={model}
            voice={voice}
            view={view}
            setView={setView}
            pinned={pinned}
            onPin={() => {
              setPinned(!pinned)
              void invoke('panel:pin', !pinned)
            }}
            onNew={() => {
              setCurrent(null)
              setFresh(true)
              setView({ kind: 'home' })
              setTimeout(() => inputRef.current?.focus(), 20)
            }}
          />
          {view.kind === 'home' && (
            <>
              <AskBar inputRef={inputRef} busy={busy} voice={voice} hint={voiceHint} followUp={!!current && !fresh} onSend={(t) => void send(t)} onStop={() => void invoke('agent:cancel')} />
              <ContextStrip
                ctx={ctx}
                useCtx={useCtx}
                setUseCtx={setUseCtx}
                actions={busy ? [] : actions.filter((a) => !(current && !fresh && tasks[current]?.label === a.label))}
                secondary={!!current && !fresh}
                model={model}
                retryModel={() => checkModel(true)}
                browser={browser}
                run={(a) => void send(a.prompt, { fresh: true, skill: a.skill ?? '', applyTo: a.applyTo, label: a.label })}
              />
            </>
          )}
        </div>
        {notice && (
          <div className="notice">
            <CircleAlert size={14} /> {notice}
          </div>
        )}
        <div className="content">
          {view.kind === 'home' && (
            <div className="stack">
              {perms.map((p) => (
                <PermissionCard key={p.id} req={p} />
              ))}
              {asks.map((a) => (
                <ClarifyCard key={a.id} req={a} />
              ))}
              {current && (
                <ResultCard
                  task={task}
                  answer={answer}
                  streamText={stream[current] ?? ''}
                  running={current === activeTask && busy}
                  phase={phase}
                  original={originals[current]}
                  onTweak={(t) => void send(t.prompt, { fresh: false, applyTo: task?.applyTo, label: `${(task?.label ?? 'Result').split(' · ')[0]} · ${t.label}` })}
                  onRetry={() => task && void send(task.request, { fresh: false, applyTo: task.applyTo, label: task.label })}
                  modelDown={model?.ok === false}
                  openDetails={() => setView({ kind: 'task', id: current })}
                />
              )}
              {proposals.map((p) => (
                <div className="proposal" key={p.id}>
                  <Brain size={14} />
                  <span>
                    Remember: <em>{p.text}</em>
                  </span>
                  <button
                    className="btn sm primary"
                    onClick={() => {
                      setProposals((x) => x.filter((y) => y.id !== p.id))
                      void invoke('agent:memoryProposal', p.id, true)
                    }}
                  >
                    Remember
                  </button>
                  <button
                    className="btn sm ghost"
                    onClick={() => {
                      setProposals((x) => x.filter((y) => y.id !== p.id))
                      void invoke('agent:memoryProposal', p.id, false)
                    }}
                  >
                    No
                  </button>
                </div>
              ))}
            </div>
          )}
          {view.kind === 'history' && <TaskList open={(id) => setView({ kind: 'task', id })} />}
          {view.kind === 'task' && <TaskDetail id={view.id} live={tasks[view.id]} back={() => setView({ kind: 'history' })} />}
        </div>
      </div>
    </div>
  )
}

function Header({ phase, snapshot, model, voice, view, setView, pinned, onPin, onNew }: { phase: AgentPhase; snapshot: AgentSnapshot | null; model: ProviderStatus | null; voice: VoiceStatus | null; view: View; setView: (v: View) => void; pinned: boolean; onPin: () => void; onNew: () => void }) {
  const p = model ?? snapshot?.provider
  const mood = phase === 'thinking' ? 'think' : phase === 'working' ? 'work' : phase === 'waiting_permission' || phase === 'waiting_user' ? 'permission' : 'idle'
  const idle = phase === 'idle' || phase === 'done' || phase === 'error' || phase === 'cancelled'
  const ear = idle && voice?.listening ? 'Listening…' : idle && voice?.recognizing ? 'Got it…' : null
  return (
    <div className="header">
      <div className="brand">
        <ClawdMini scale={1.9} width={30} height={20} state={mood} />
        <div className="status" title={p ? `${p.model || p.provider}: ${p.message}` : undefined} role="status" aria-live="polite">
          <span className={cx('state-dot', ear ? 'listening' : phase)} />
          {ear ?? PHASE_LABEL[phase]}
        </div>
      </div>
      <div className="tools">
        {voice?.speaking && (
          <button className="btn ghost sm" title="Stop talking (Esc)" onClick={() => void invoke('voice:stopSpeaking')}>
            <VolumeX size={14} /> Stop talking
          </button>
        )}
        {view.kind !== 'home' ? (
          <button className="btn ghost sm" onClick={() => setView(view.kind === 'task' ? { kind: 'history' } : { kind: 'home' })}>
            <ArrowLeft size={14} /> Back
          </button>
        ) : (
          <>
            <button className="btn ghost icon sm" title="New question" aria-label="New question" onClick={onNew}>
              <Plus size={15} />
            </button>
            <button className="btn ghost icon sm" title="History" onClick={() => setView({ kind: 'history' })}>
              <History size={15} />
            </button>
          </>
        )}
        <button className="btn ghost icon sm" title={pinned ? 'Unpin (hide when I click elsewhere)' : 'Keep open'} aria-pressed={pinned} onClick={onPin}>
          {pinned ? <PinOff size={15} /> : <Pin size={15} />}
        </button>
        <button className="btn ghost icon sm" title="Settings" onClick={() => void invoke('app:open', 'settings')}>
          <Gear size={15} />
        </button>
        <button className="btn ghost icon sm" title="Close (Esc)" onClick={() => void invoke('panel:hide')}>
          <X size={15} />
        </button>
      </div>
    </div>
  )
}

function AskBar({ inputRef, busy, voice, hint, followUp, onSend, onStop }: { inputRef: React.RefObject<HTMLTextAreaElement | null>; busy: boolean; voice: VoiceStatus | null; hint: string | null; followUp: boolean; onSend: (t: string) => void; onStop: () => void }) {
  const [text, setText] = useState('')
  const [setup, setSetup] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  const listening = !!voice?.listening
  const recognizing = !!voice?.recognizing
  const needsModels = !!voice && !voice.modelsPresent
  // The mic level drives the waveform through a CSS variable, without re-rendering.
  useEffect(() => {
    return on('voice:level', (v) => barRef.current?.style.setProperty('--lvl', Math.min(1, v).toFixed(3)))
  }, [])
  useEffect(() => {
    if (!listening) barRef.current?.style.setProperty('--lvl', '0')
  }, [listening])
  useEffect(() => {
    if (voice?.modelsPresent) setSetup(false)
  }, [voice?.modelsPresent])
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(120, el.scrollHeight) + 'px'
    // Scroll only once it is at its tallest (sub-pixel rounding at 150-200% scaling would otherwise
    // show a scrollbar on a single line).
    el.style.overflowY = el.scrollHeight > 121 ? 'auto' : 'hidden'
  }, [text])
  const submit = () => {
    if (!text.trim()) return
    onSend(text)
    setText('')
  }
  const placeholder = listening
    ? 'Listening… or just start typing'
    : recognizing
      ? 'Got it, one sec…'
      : hint ?? (busy ? 'Working… type to redirect me' : followUp ? 'Ask a follow-up, or something new…' : 'Ask Clawd anything…')
  const dl = voice?.downloading
  return (
    <>
      <div ref={barRef} className={cx('askbar', listening && 'listening', recognizing && 'recognizing')}>
        {(listening || recognizing) && (
          <span className="wave" aria-hidden>
            {[0.55, 0.9, 1, 0.75, 0.5].map((k, i) => (
              <i key={i} style={{ '--k': k, '--d': `${i * -0.17}s` } as React.CSSProperties} />
            ))}
          </span>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          placeholder={placeholder}
          aria-label="Ask Clawd"
          value={text}
          onChange={(e) => {
            // Typing means the keyboard won: stop listening, and stop talking over the user.
            if (e.target.value && (listening || recognizing)) void invoke('voice:cancel')
            if (e.target.value && voice?.speaking) void invoke('voice:stopSpeaking')
            setText(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {voice && (
          <button
            className={cx('btn ghost icon sm mic', listening && 'listening')}
            title={needsModels ? 'Talk to Clawd (needs a one-time download)' : listening ? 'Listening… click to stop' : 'Speak'}
            aria-label={listening ? 'Stop listening' : 'Speak'}
            aria-pressed={listening}
            onClick={() => (needsModels ? setSetup(!setup) : void invoke('voice:toggle'))}
          >
            <Mic size={15} />
          </button>
        )}
        {busy && !text ? (
          <button className="btn icon sm stop" title="Stop" aria-label="Stop" onClick={onStop}>
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <button className="btn primary icon sm" title="Ask (Enter)" aria-label="Ask" onClick={submit} disabled={!text.trim()}>
            <ArrowUp size={15} />
          </button>
        )}
      </div>
      {needsModels && (setup || dl) && (
        <div className="voice-setup">
          {dl ? (
            <>
              <span>
                Downloading my ears and voice… {Math.round((dl.received / Math.max(1, dl.total)) * 100)}%
              </span>
              <progress max={Math.max(1, dl.total)} value={dl.received} />
            </>
          ) : (
            <>
              <span>To talk, I need a one-time 620 MB download. It runs only on this PC.</span>
              <button className="btn sm primary" onClick={() => void invoke('voice:download')}>
                <Download size={13} /> Download
              </button>
              <button className="btn ghost sm" onClick={() => setSetup(false)}>
                Not now
              </button>
            </>
          )}
        </div>
      )}
    </>
  )
}

function ContextStrip({
  ctx,
  useCtx,
  setUseCtx,
  actions,
  secondary,
  model,
  retryModel,
  browser,
  run,
}: {
  ctx: SummonContext | null
  useCtx: boolean
  setUseCtx: (v: boolean) => void
  actions: QuickAction[]
  secondary: boolean
  model: ProviderStatus | null
  retryModel: () => void
  browser: BrowserStatus | null
  run: (a: QuickAction) => void
}) {
  const site = siteOf(ctx?.url)
  const what = ctx?.draft ? 'your comment' : ctx?.selection ? `the selected text (${ctx.selection.length.toLocaleString()} chars)` : null
  const browserHint = !!ctx?.isBrowser && !ctx.url && browser?.enabled !== false && !browser?.connected
  if (model?.ok === false) {
    return (
      <div className="context">
        <div className="model-down" role="alert">
          <CircleAlert size={14} />
          <span>I can't think yet: {model.message}</span>
        </div>
        <div className="actions">
          <button className="action primary" onClick={retryModel}>
            Try again
          </button>
          <button className="action" onClick={() => void invoke('app:open', 'settings', 'ai')}>
            AI settings
          </button>
        </div>
      </div>
    )
  }
  if (!ctx?.app && !what && !actions.length) return null
  return (
    <div className="context">
      {(ctx?.app || what) && (
        <div className="ctx-line">
          {site ? <Globe size={12} /> : <MessageSquareText size={12} />}
          <span className="ctx-where" title={ctx?.title}>
            {site ?? ctx?.app}
            {ctx?.title && ctx.title.trim().toLowerCase() !== (site ?? ctx.app ?? '').trim().toLowerCase() ? ` · ${ctx.title}` : ''}
          </span>
          {what && (
            <button className={cx('ctx-toggle', !useCtx && 'off')} aria-pressed={!useCtx} onClick={() => setUseCtx(!useCtx)} title={useCtx ? 'Click to leave it out' : 'Click to include it'}>
              {useCtx ? `Using ${what}` : `Leaving out ${what}`}
            </button>
          )}
        </div>
      )}
      {browserHint && (
        <div className="ctx-hint">
          <span>Connect your browser so I can read pages and your comment.</span>
          <button className="btn ghost sm" onClick={() => void invoke('app:open', 'settings', 'integrations')}>
            Set up
          </button>
        </div>
      )}
      {actions.length > 0 && (
        <div className={cx('actions', secondary && 'secondary')}>
          {actions.map((a) => (
            <button key={a.id} className={cx('action', a.primary && !secondary && 'primary')} onClick={() => run(a)}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ResultCard({ task, answer, streamText, running, phase, original, onTweak, onRetry, modelDown, openDetails }: { task?: TaskRecord; answer?: ChatMessage; streamText: string; running: boolean; phase: AgentPhase; original?: string; onTweak: (t: QuickAction) => void; onRetry: () => void; modelDown: boolean; openDetails: () => void }) {
  const text = answer?.text ?? (task?.status === 'done' ? task.result : undefined)
  const failed = task?.status === 'failed' || task?.status === 'interrupted'
  const writing = !!task && (!!task.applyTo || isWritingTask(task.request))
  return (
    <div className="result" aria-live="polite">
      {task && (
        <button className="result-head" onClick={openDetails} title="Show details">
          <span className="result-request">{task.label ?? task.request}</span>
          <StepsBadge task={task} />
        </button>
      )}
      {running && <Progress task={task} text={streamText} phase={phase} />}
      {!running && text && !failed && (
        <>
          <Answer text={text} task={task} original={original} writing={writing} />
          {(answer?.note ?? task?.resultNote) && <div className="result-note">{answer?.note ?? task?.resultNote}</div>}
          {writing && (
            <div className="tweaks">
              {TWEAKS.map((t) => (
                <button key={t.id} className="chip" onClick={() => onTweak(t)}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {answer?.memories && answer.memories.length > 0 && (
            <details className="memories">
              <summary>
                <Brain size={12} /> Used {answer.memories.length} {answer.memories.length === 1 ? 'memory' : 'memories'}
              </summary>
              <ul>
                {answer.memories.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {!running && (failed || task?.status === 'cancelled') && (
        <>
          <div className={cx('result-error', task?.status === 'cancelled' && 'muted')}>{task?.status === 'cancelled' ? 'Stopped.' : (answer?.text ?? task?.error ?? 'That did not work.')}</div>
          {failed && (
            <div className="answer-actions">
              <button className="btn sm primary" onClick={onRetry}>
                <RotateCcw size={13} /> Try again
              </button>
              {modelDown && (
                <button className="btn ghost sm" onClick={() => void invoke('app:open', 'settings', 'ai')}>
                  <Gear size={13} /> AI settings
                </button>
              )}
            </div>
          )}
        </>
      )}
      {!running && !task && <Spinner />}
    </div>
  )
}

function StepsBadge({ task }: { task: TaskRecord }) {
  const tools = task.steps.filter((s) => s.kind === 'tool')
  return (
    <span className="faint steps-badge">
      {tools.length ? `${tools.length} step${tools.length === 1 ? '' : 's'}` : ''}
      {task.files.length ? ` · ${task.files.length} file${task.files.length === 1 ? '' : 's'}` : ''}
      {task.endedAt && tools.length ? ` · ${duration(task.endedAt - task.createdAt)}` : ''}
      <ChevronRight size={13} />
    </span>
  )
}

/** Final answer with ways to use it: put it back where it came from, copy, compare, edit. */
function Answer({ text, task, original, writing }: { text: string; task?: TaskRecord; original?: string; writing: boolean }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'compare'>('view')
  const [draft, setDraft] = useState(text)
  const [flash, setFlash] = useState<string | null>(null)
  useEffect(() => {
    setDraft(text)
    setMode('view')
  }, [text])
  // Once edited, the edited text is the result everywhere (view, compare, apply).
  const edited = draft !== text
  const current = edited ? draft : text
  const target = task?.applyTo
  const apply = async (how: 'copy' | 'replace' | 'insert' | 'draft') => {
    try {
      const r = await invoke('result:apply', current, how)
      setFlash(r.message)
    } catch (err) {
      setFlash(clean((err as Error).message))
    }
    setTimeout(() => setFlash(null), 4000)
  }
  return (
    <div className="answer">
      {mode === 'edit' ? (
        <textarea
          className="textarea"
          value={draft}
          aria-label="Edit the result"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setMode('view')
            }
          }}
          rows={Math.min(14, Math.max(4, draft.split('\n').length + 1))}
          style={{ width: '100%' }}
          autoFocus
        />
      ) : mode === 'compare' && original ? (
        <div className="diff">
          {wordDiff(original, current).map((p, i) => (
            <span key={i} className={p.kind}>
              {p.text}
            </span>
          ))}
        </div>
      ) : (
        <Markdown text={current} />
      )}
      {edited && mode !== 'edit' && (
        <div className="edited-tag">
          Edited ·{' '}
          <button className="link" onClick={() => setDraft(text)}>
            Revert
          </button>
        </div>
      )}
      <div className="answer-actions">
        {target === 'draft' && (
          <button className="btn sm primary" onClick={() => void apply('draft')} title="Put this into the comment box you were writing in. Nothing is posted.">
            <Replace size={13} /> Put in comment box
          </button>
        )}
        {target === 'selection' && (
          <button className="btn sm primary" onClick={() => void apply('replace')} title="Replace the text you had selected">
            <Replace size={13} /> Replace selection
          </button>
        )}
        <button className="btn ghost sm" onClick={() => void apply('copy')}>
          <ClipboardCopy size={13} /> Copy
        </button>
        {writing && !target && (
          <button className="btn ghost sm" onClick={() => void apply('insert')} title="Paste at the cursor in the app you were using">
            <TextCursorInput size={13} /> Insert
          </button>
        )}
        {original && target && (
          <button className={cx('btn ghost sm', mode === 'compare' && 'on')} aria-pressed={mode === 'compare'} onClick={() => setMode(mode === 'compare' ? 'view' : 'compare')}>
            <GitCompare size={13} /> Compare
          </button>
        )}
        {writing && (
          <button className={cx('btn ghost sm', mode === 'edit' && 'on')} aria-pressed={mode === 'edit'} onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}>
            <Pencil size={13} /> {mode === 'edit' ? 'Done editing' : 'Edit'}
          </button>
        )}
        {flash && (
          <span className="flash" role="status">
            {flash}
          </span>
        )}
      </div>
      {task && task.artifacts.filter((a) => a.kind === 'file').length > 0 && (
        <div className="artifacts">
          {task.artifacts
            .filter((a) => a.kind === 'file' && a.path)
            .map((a) => (
              <div key={a.path} className="artifact">
                <FileText size={14} />
                <span className="name" title={a.path}>
                  {a.title}
                </span>
                <button className="btn ghost icon sm" title="Open" onClick={() => void invoke('app:openPath', a.path!)}>
                  <ExternalLink size={13} />
                </button>
                <button className="btn ghost icon sm" title="Show in folder" onClick={() => void invoke('app:reveal', a.path!)}>
                  <FolderOpen size={13} />
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function stepIcon(s: TaskStep) {
  if (s.status === 'running') return <LoaderCircle size={13} className="spin" />
  if (s.status === 'done') return <CircleCheck size={13} className="ok" />
  if (s.status === 'denied') return <CircleSlash size={13} className="warn" />
  if (s.status === 'skipped') return <CircleDashed size={13} className="faint" />
  return <CircleAlert size={13} className="danger" />
}

/** Compact progress: the plan (if any), the current step, and the answer as it streams. */
function Progress({ task, text, phase }: { task?: TaskRecord; text: string; phase: AgentPhase }) {
  const [open, setOpen] = useState(false)
  const steps = task?.steps ?? []
  const currentStep = [...steps].reverse().find((s) => s.status === 'running') ?? steps[steps.length - 1]
  return (
    <div className="progress-box">
      {task && task.plan.length > 0 && (
        <div className="plan">
          {task.plan.map((p, i) => (
            <div key={i} className={cx('plan-item', p.status)}>
              {p.status === 'done' ? <Check size={13} /> : p.status === 'active' ? <LoaderCircle size={13} className="spin" /> : p.status === 'failed' ? <X size={13} /> : <span className="pending-dot" />}
              <span>{p.text}</span>
            </div>
          ))}
        </div>
      )}
      <button className="now" onClick={() => setOpen(!open)} disabled={!steps.length}>
        <Spinner size={12} />
        <span>{currentStep && currentStep.status === 'running' ? currentStep.title : PHASE_LABEL[phase]}…</span>
        {steps.length > 0 && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
      </button>
      {open && (
        <div className="steps">
          {steps.slice(-10).map((s) => (
            <div key={s.id} className="step">
              {s.kind === 'recovery' ? <Undo2 size={13} className="warn" /> : stepIcon(s)}
              <span className="step-title">{s.title}</span>
            </div>
          ))}
        </div>
      )}
      {text && (
        <div className="streaming">
          <Markdown text={text} />
        </div>
      )}
    </div>
  )
}

function PermissionCard({ req }: { req: PermissionRequest }) {
  const decide = (d: PermissionDecision) => void invoke('agent:decide', req.id, d)
  return (
    <div className={cx('perm', req.risk)}>
      <div className="perm-head">
        <ShieldAlert size={15} />
        <strong>{req.title}</strong>
        <Badge tone={req.risk === 'high' ? 'danger' : req.risk === 'medium' ? 'warn' : undefined}>{req.risk} risk</Badge>
      </div>
      {req.details && <pre className="perm-details">{req.details}</pre>}
      {req.reasons.length > 0 && <div className="perm-why faint">Asking because {req.reasons.join('; ')}.</div>}
      <div className="perm-actions">
        <button className="btn primary sm" onClick={() => decide('allow_once')}>
          Allow once
        </button>
        <button className="btn sm" onClick={() => decide('allow_task')} title="Allow this kind of action for the rest of this task">
          Allow for this task
        </button>
        {req.allowAlways && (
          <button className="btn sm ghost" onClick={() => decide('allow_always')}>
            Always allow
          </button>
        )}
        <button className="btn sm danger" onClick={() => decide('deny')}>
          Deny
        </button>
      </div>
    </div>
  )
}

function ClarifyCard({ req }: { req: Clarification }) {
  const [text, setText] = useState('')
  const answer = (a: string) => a.trim() && void invoke('agent:answer', req.id, a.trim())
  return (
    <div className="clarify">
      <div className="clarify-q">{req.question}</div>
      {req.options && req.options.length > 0 && (
        <div className="chips">
          {req.options.map((o) => (
            <button key={o} className="chip" onClick={() => answer(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="input" style={{ flex: 1 }} placeholder="Type your answer…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && answer(text)} autoFocus />
        <button className="btn primary sm" onClick={() => answer(text)}>
          Answer
        </button>
      </div>
    </div>
  )
}

function TaskList({ open }: { open: (id: string) => void }) {
  const [list, setList] = useState<TaskSummary[] | null>(null)
  useEffect(() => {
    void invoke('tasks:list').then(setList)
  }, [])
  if (!list) return <div className="pad"><Spinner /></div>
  if (!list.length) return <div className="pad faint">Nothing here yet. Things you ask Clawd show up here.</div>
  return (
    <div className="tasklist">
      {list.slice(0, 80).map((t) => (
        <button key={t.id} className="task-row" onClick={() => open(t.id)}>
          <TaskStatusIcon status={t.status} />
          <span className="req">{t.request}</span>
          <span className="faint when">{timeAgo(t.createdAt)}</span>
        </button>
      ))}
    </div>
  )
}

function TaskStatusIcon({ status }: { status: TaskRecord['status'] }) {
  if (status === 'done') return <CircleCheck size={14} className="ok" />
  if (status === 'running' || status === 'waiting') return <LoaderCircle size={14} className="spin" />
  if (status === 'cancelled') return <CircleSlash size={14} className="faint" />
  if (status === 'interrupted') return <MoreHorizontal size={14} className="warn" />
  return <CircleAlert size={14} className="danger" />
}

export function TaskDetail({ id, live, back }: { id: string; live?: TaskRecord; back?: () => void }) {
  const [task, setTask] = useState<TaskRecord | null>(live ?? null)
  const [undo, setUndo] = useState<string | null>(null)
  useEffect(() => {
    if (live) setTask(live)
    else void invoke('tasks:get', id).then(setTask)
  }, [id, live])
  const files = task?.files ?? []
  const revertable = useMemo(() => files.filter((f) => !f.reverted), [files])
  if (!task) return <div className="pad"><Spinner /></div>
  return (
    <div className="detail">
      {back && (
        <button className="btn ghost sm" onClick={back} style={{ marginBottom: 6 }}>
          ← History
        </button>
      )}
      <div className="detail-req">{task.request}</div>
      <div className="detail-meta faint">
        <TaskStatusIcon status={task.status} /> {task.status} · {new Date(task.createdAt).toLocaleString()} {task.endedAt && `· ${duration(task.endedAt - task.createdAt)}`} · {task.model.model || task.model.provider}
      </div>
      {task.error && <div className="notice inline">{task.error}</div>}
      {task.result && (
        <div className="section">
          <Markdown text={task.result} />
        </div>
      )}
      {task.plan.length > 0 && (
        <div className="plan">
          {task.plan.map((p, i) => (
            <div key={i} className={cx('plan-item', p.status)}>
              {p.status === 'done' ? <Check size={13} /> : p.status === 'failed' ? <X size={13} /> : <span className="pending-dot" />}
              <span>{p.text}</span>
            </div>
          ))}
        </div>
      )}
      {task.steps.length > 0 && (
        <div className="section">
          <div className="section-title">Steps</div>
          <div className="timeline">
            {task.steps.map((s) => (
              <details key={s.id} className="tl-step">
                <summary>
                  {s.kind === 'recovery' ? <Undo2 size={13} className="warn" /> : stepIcon(s)}
                  <span className="tl-title">{s.title}</span>
                  <span className="faint mono tl-time">{new Date(s.startedAt).toLocaleTimeString()}</span>
                </summary>
                {s.input && <pre className="tl-pre">{s.input}</pre>}
                {s.output && <pre className="tl-pre">{s.output}</pre>}
                {s.error && <pre className="tl-pre danger">{s.error}</pre>}
              </details>
            ))}
          </div>
        </div>
      )}
      {task.permissions.length > 0 && (
        <div className="section">
          <div className="section-title">Permissions</div>
          {task.permissions.map((p) => (
            <div key={p.requestId} className="perm-row">
              <span>{p.summary}</span>
              <Badge tone={p.decision === 'deny' ? 'danger' : 'ok'}>{p.decision.replace('_', ' ')}</Badge>
              <span className="faint">{p.automatic ? 'by rule' : 'by you'}</span>
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="section">
          <div className="section-title">
            Files
            {revertable.length > 0 && (
              <button
                className="btn sm"
                onClick={async () => {
                  const r = await invoke('tasks:undo', task.id)
                  setUndo(r.ok ? `Reverted ${r.reverted.length} change(s).` : `Reverted ${r.reverted.length}; failed: ${r.failed.map((f) => `${f.path} (${f.reason})`).join(', ')}`)
                  setTask(await invoke('tasks:get', task.id))
                }}
              >
                <Undo2 size={13} /> Undo all
              </button>
            )}
          </div>
          {files.map((f, i) => (
            <div key={i} className="file-row">
              <span className={cx('badge', f.reverted ? '' : 'accent')}>{f.reverted ? 'reverted' : f.action}</span>
              <span className="mono path" title={f.path}>
                {f.path}
                {f.to ? ` → ${f.to}` : ''}
              </span>
              {!f.reverted && (
                <button
                  className="btn ghost sm"
                  title={f.backupId || f.action === 'created' ? 'Undo this change' : 'No backup for this change'}
                  disabled={!f.backupId && f.action !== 'created'}
                  onClick={async () => {
                    const r = await invoke('tasks:undo', task.id, i)
                    setUndo(r.ok ? 'Reverted.' : (r.failed[0]?.reason ?? 'Could not revert.'))
                    setTask(await invoke('tasks:get', task.id))
                  }}
                >
                  <Undo2 size={13} />
                </button>
              )}
            </div>
          ))}
          {undo && (
            <div className="faint" style={{ marginTop: 6 }}>
              {undo}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
