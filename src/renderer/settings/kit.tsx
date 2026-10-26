// Layout pieces for the settings app, with built-in search filtering.

import { createContext, useContext, type ReactNode } from 'react'

export const SearchContext = createContext('')

export function Section({ title, desc, children, id }: { title: string; desc?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="s-section" id={id}>
      <div className="s-section-head">
        <h2>{title}</h2>
        {desc && <p className="muted">{desc}</p>}
      </div>
      <div className="s-card">{children}</div>
    </section>
  )
}

/** One setting: label and description on the left, the control on the right. Hidden by search. */
export function Row({ label, desc, children, keywords, stack, warn }: { label: string; desc?: ReactNode; children?: ReactNode; keywords?: string; stack?: boolean; warn?: ReactNode }) {
  const q = useContext(SearchContext).trim().toLowerCase()
  if (q) {
    const hay = `${label} ${typeof desc === 'string' ? desc : ''} ${keywords ?? ''}`.toLowerCase()
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return null
  }
  return (
    <div className={stack ? 'row stack' : 'row'}>
      <div className="row-text">
        <div className="row-label">{label}</div>
        {desc && <div className="row-desc">{desc}</div>}
        {warn && <div className="row-warn">{warn}</div>}
      </div>
      {children !== undefined && <div className="row-control">{children}</div>}
    </div>
  )
}

export function Callout({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'ok' | 'danger'; children: ReactNode }) {
  return (
    <div className={`callout ${tone}`}>
      <div className="callout-body">{children}</div>
    </div>
  )
}
