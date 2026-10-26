import { describe, expect, it } from 'vitest'
import { defaultSettings, diffSettings, mergeSettings, sanitizeSettings } from '../../src/shared/settings'
import { acceleratorFromEvent, checkShortcut, normaliseAccelerator, parseAccelerator } from '../../src/shared/keybinds'

describe('settings schema', () => {
  it('produces complete defaults', () => {
    const s = defaultSettings()
    expect(s.ai.provider).toBe('ollama')
    expect(s.ai.ollama.model).toBe('qwen3.5:4b')
    expect(s.shortcuts.summon).toBe('Ctrl+Alt+Space')
    expect(s.permissions.rules.shell).toBe('ask')
    expect(s.voice.wakePhrase).toBe('Hey Clawd')
    expect(s.voice.wakeConsent).toBe(false)
  })

  it('keeps valid fields and repairs invalid ones individually', () => {
    const s = sanitizeSettings({
      companion: { size: 9, corner: 'nowhere', gravity: 'yes' },
      ai: { temperature: 99, maxSteps: 12 },
      unknownSection: { x: 1 },
    })
    expect(s.companion.size).toBe(9)
    expect(s.companion.corner).toBe('bottom-right')
    expect(s.companion.gravity).toBe(true)
    expect(s.ai.temperature).toBe(0.4)
    expect(s.ai.maxSteps).toBe(12)
    expect((s as unknown as Record<string, unknown>).unknownSection).toBeUndefined()
  })

  it('survives garbage input', () => {
    for (const bad of [null, 42, 'text', [], { general: 'broken', voice: null }]) {
      const s = sanitizeSettings(bad)
      expect(s.general.theme).toBe('system')
      expect(s.voice.enabled).toBe(true)
    }
  })

  it('merges deep patches and replaces arrays', () => {
    const base = defaultSettings()
    const next = mergeSettings(base, { voice: { speed: 1.3 }, permissions: { fileRoots: ['C:\\work'] } })
    expect(next.voice.speed).toBe(1.3)
    expect(next.voice.wakePhrase).toBe('Hey Clawd')
    expect(next.permissions.fileRoots).toEqual(['C:\\work'])
    expect(diffSettings(base, next).sort()).toEqual(['permissions.fileRoots', 'voice.speed'])
  })

  it('rejects out-of-range numbers through merge', () => {
    const next = mergeSettings(defaultSettings(), { companion: { size: 400 } })
    expect(next.companion.size).toBe(7)
  })
})

describe('keyboard shortcuts', () => {
  it('parses and normalises accelerators', () => {
    expect(normaliseAccelerator('alt+ctrl+space')).toBe('Ctrl+Alt+Space')
    expect(normaliseAccelerator('Control+Shift+k')).toBe('Ctrl+Shift+K')
    expect(normaliseAccelerator('Win+F13')).toBe('Super+F13')
    expect(parseAccelerator('Ctrl+')).toBeNull()
    expect(parseAccelerator('Ctrl+A+B')).toBeNull()
    expect(parseAccelerator('Ctrl+Banana')).toBeNull()
  })

  it('builds accelerators from key events using physical keys', () => {
    expect(acceleratorFromEvent({ key: '@', code: 'Digit2', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })).toBe('Ctrl+Alt+2')
    expect(acceleratorFromEvent({ key: ' ', code: 'Space', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })).toBe('Ctrl+Alt+Space')
    expect(acceleratorFromEvent({ key: 'Control', code: 'ControlLeft', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBeNull()
  })

  it('blocks reserved, typing-hostile and duplicate shortcuts', () => {
    expect(checkShortcut('Alt+Tab').ok).toBe(false)
    expect(checkShortcut('Super+L').ok).toBe(false)
    expect(checkShortcut('Shift+A').ok).toBe(false)
    expect(checkShortcut('Ctrl+C').ok).toBe(false)
    expect(checkShortcut('Ctrl+Alt+Space').ok).toBe(true)
    expect(checkShortcut('F13').ok).toBe(true)
    const dup = checkShortcut('Ctrl+Alt+H', { 'Hide or show Clawd': 'Ctrl+Alt+H', 'Summon Clawd': 'Ctrl+Alt+Space' }, 'Summon Clawd')
    expect(dup.ok).toBe(false)
    expect(dup.error).toMatch(/Hide or show/)
  })

  it('warns about AltGr combinations', () => {
    const r = checkShortcut('Ctrl+Alt+2')
    expect(r.ok).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/AltGr/)
  })
})
