// Clawd's settings application: searchable, every control bound to a real setting.

import { useEffect, useState } from 'react'
import { Bot, Brain, Cable, Info, Keyboard, ListChecks, Mic, Palette, Search, Settings2, ShieldCheck, Sparkles } from 'lucide-react'
import type { Settings } from '../../shared/settings'
import { ClawdMini } from '../shared/ClawdMini'
import { useSettings, useTheme } from '../shared/ui'
import { SearchContext } from './kit'
import { AboutSection, IntegrationsSection, MemorySection, PermissionsSection, SuggestionsSection, TasksSection } from './sections2'
import { AISection, AppearanceSection, GeneralSection, ShortcutsSection, VoiceSection } from './sections'

export type Patch = Parameters<ReturnType<typeof useSettings>[1]>[0]
export interface SectionProps {
  s: Settings
  set: (patch: Patch) => void
}

const NAV = [
  { id: 'general', label: 'General', icon: Settings2, C: GeneralSection },
  { id: 'appearance', label: 'Appearance & motion', icon: Palette, C: AppearanceSection },
  { id: 'voice', label: 'Voice', icon: Mic, C: VoiceSection },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, C: ShortcutsSection },
  { id: 'ai', label: 'AI model', icon: Bot, C: AISection },
  { id: 'permissions', label: 'Permissions & privacy', icon: ShieldCheck, C: PermissionsSection },
  { id: 'suggestions', label: 'Focus & notifications', icon: Sparkles, C: SuggestionsSection },
  { id: 'integrations', label: 'Integrations', icon: Cable, C: IntegrationsSection },
  { id: 'memory', label: 'Memory', icon: Brain, C: MemorySection },
  { id: 'tasks', label: 'Tasks & history', icon: ListChecks, C: TasksSection },
  { id: 'about', label: 'About', icon: Info, C: AboutSection },
] as const

export function App() {
  const [s, set] = useSettings()
  useTheme(s?.general.theme)
  const initial = location.hash.replace('#', '')
  const [page, setPage] = useState<string>(NAV.some((n) => n.id === initial) ? initial : 'general')
  const [query, setQuery] = useState('')
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace('#', '')
      if (NAV.some((n) => n.id === h)) {
        setPage(h)
        setQuery('')
      }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  if (!s) return <div className="loading" />
  const searching = query.trim().length > 0
  return (
    <div className="settings">
      <aside className="nav">
        <div className="nav-brand">
          <ClawdMini scale={2.6} width={44} height={28} />
          <div>
            <div className="pixel" style={{ fontSize: 14 }}>
              clawd
            </div>
            <div className="faint" style={{ fontSize: 11 }}>
              Settings
            </div>
          </div>
        </div>
        <label className="search">
          <Search size={14} />
          <input placeholder="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <nav>
          {NAV.map((n) => (
            <button
              key={n.id}
              className={!searching && page === n.id ? 'active' : ''}
              onClick={() => {
                setQuery('')
                setPage(n.id)
                history.replaceState(null, '', `#${n.id}`)
              }}
            >
              <n.icon size={15} />
              {n.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="main">
        <div className="titlebar-space" />
        <SearchContext.Provider value={query}>
          <div className="page">
            {searching ? (
              <>
                <h1>Results for “{query}”</h1>
                {NAV.filter((n) => n.id !== 'about').map((n) => (
                  <div key={n.id} className="search-group">
                    <n.C s={s} set={set} />
                  </div>
                ))}
                <div className="no-results faint">No other settings match.</div>
              </>
            ) : (
              NAV.filter((n) => n.id === page).map((n) => (
                <div key={n.id}>
                  <h1>{n.label}</h1>
                  <n.C s={s} set={set} />
                </div>
              ))
            )}
          </div>
        </SearchContext.Provider>
      </main>
    </div>
  )
}
