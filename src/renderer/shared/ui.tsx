// Small component kit shared by the panel and the settings app.

import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { Settings } from '../../shared/settings'
import { invoke, on } from './bridge'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** Keeps a rendering bug from blanking a whole window; offers a reload. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack)
  }
  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
        <strong>Something in this window broke.</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{this.state.error.message}</span>
        <button className="btn primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" disabled={disabled} onClick={() => onChange(!checked)} />
}

export function Slider({ value, min, max, step, onChange, format, label }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string; label?: string }) {
  const [local, setLocal] = useState(value)
  useEffect(() => {
    setLocal(value)
  }, [value])
  const p = ((local - min) / (max - min)) * 100
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 220 }}>
      <input
        aria-label={label}
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        style={{ ['--p' as string]: `${p}%`, flex: 1 }}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={() => onChange(local)}
        onKeyUp={() => onChange(local)}
      />
      <span className="mono faint" style={{ width: 52, textAlign: 'right', fontSize: 12 }}>
        {format ? format(local) : local}
      </span>
    </div>
  )
}

export function Select<T extends string>({ value, options, onChange, label, width }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string; width?: number }) {
  return (
    <select aria-label={label} className="select" value={value} onChange={(e) => onChange(e.target.value as T)} style={{ width: width ?? 220 }}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Badge({ tone, children, dot }: { tone?: 'ok' | 'warn' | 'danger' | 'accent'; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cx('badge', tone)}>
      {dot && <span className="dot" />}
      {children}
    </span>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span style={{ width: size, height: size, display: 'inline-block', border: '2px solid var(--border-strong)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
}

marked.setOptions({ gfm: true, breaks: true })

/** Renders model output as Markdown, sanitised; links open in the system browser. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { FORBID_TAGS: ['style', 'img', 'iframe', 'form', 'input'], FORBID_ATTR: ['style'] }), [text])
  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        if (a?.href) {
          e.preventDefault()
          if (/^https?:/.test(a.href)) void invoke('app:openExternal', a.href)
        }
      }}
    />
  )
}

/** Live settings with optimistic updates. */
export function useSettings(): [Settings | null, (patch: Parameters<typeof invoke<'settings:set'>>[1]) => void] {
  const [s, setS] = useState<Settings | null>(null)
  useEffect(() => {
    void invoke('settings:get').then(setS)
    return on('settings:changed', setS)
  }, [])
  return [s, (patch) => void invoke('settings:set', patch).then(setS)]
}

/** Applies the theme preference to <html data-theme>. */
export function useTheme(pref: 'system' | 'dark' | 'light' | undefined): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = pref === 'dark' || (pref !== 'light' && mq.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [pref])
}

export function timeAgo(t: number): string {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`
}
