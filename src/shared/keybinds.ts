// Accelerator parsing, normalisation and validation for the global shortcut editor.
// Accelerators use Electron's syntax ("Ctrl+Alt+Space").

export type Modifier = 'Ctrl' | 'Alt' | 'Shift' | 'Super'
const MOD_ORDER: Modifier[] = ['Ctrl', 'Alt', 'Shift', 'Super']
const MOD_ALIASES: Record<string, Modifier> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'Alt',
  shift: 'Shift',
  super: 'Super',
  win: 'Super',
  meta: 'Super',
  cmd: 'Super',
  command: 'Super',
}

const NAMED_KEYS: Record<string, string> = {
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  enter: 'Enter',
  return: 'Enter',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  esc: 'Escape',
  plus: 'Plus',
  printscreen: 'PrintScreen',
  pause: 'Pause',
}
const PUNCTUATION = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '`', '-', '='])

export interface Accelerator {
  mods: Modifier[]
  key: string
}

function normaliseKey(raw: string): string | null {
  const k = raw.trim()
  if (!k) return null
  if (/^[a-z]$/i.test(k)) return k.toUpperCase()
  if (/^[0-9]$/.test(k)) return k
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(k)) return k.toUpperCase()
  if (/^num([0-9]|add|sub|mult|div|dec)$/i.test(k)) return 'num' + k.slice(3).toLowerCase()
  if (PUNCTUATION.has(k)) return k
  return NAMED_KEYS[k.toLowerCase()] ?? null
}

export function parseAccelerator(text: string): Accelerator | null {
  if (!text || typeof text !== 'string') return null
  // "+" itself is spelled "Plus"; split on + but keep a trailing "+" key.
  const parts = text.split('+').map((p) => p.trim())
  if (parts.some((p) => p === '')) return null
  const mods = new Set<Modifier>()
  let key: string | null = null
  for (const part of parts) {
    const mod = MOD_ALIASES[part.toLowerCase()]
    if (mod) {
      mods.add(mod)
      continue
    }
    if (key) return null // two non-modifier keys
    key = normaliseKey(part)
    if (!key) return null
  }
  if (!key) return null
  return { mods: MOD_ORDER.filter((m) => mods.has(m)), key }
}

export function formatAccelerator(a: Accelerator): string {
  return [...a.mods, a.key].join('+')
}

/** Canonical spelling, or null if unparsable. */
export function normaliseAccelerator(text: string): string | null {
  const a = parseAccelerator(text)
  return a ? formatAccelerator(a) : null
}

/** Builds an accelerator from a DOM keyboard event (for the shortcut recorder). */
export function acceleratorFromEvent(e: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  const mods: Modifier[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  // Prefer the physical code so AltGr/shifted characters map to the base key.
  let key: string | null = null
  const code = e.code
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code
  else if (/^Numpad[0-9]$/.test(code)) key = 'num' + code.slice(6)
  else {
    const map: Record<string, string> = {
      Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Enter: 'Enter',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown', Escape: 'Escape', Comma: ',', Period: '.', Slash: '/', Semicolon: ';',
      Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`', Minus: '-', Equal: '=',
      NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
      PrintScreen: 'PrintScreen', Pause: 'Pause',
    }
    key = map[code] ?? null
  }
  if (!key) return null // a lone modifier press
  return formatAccelerator({ mods, key })
}

export interface ShortcutCheck {
  ok: boolean
  /** Blocking problem: the shortcut cannot be saved. */
  error?: string
  /** Non-blocking advice. */
  warnings: string[]
}

/** Shortcuts Windows or nearly every application already uses. */
const RESERVED: Record<string, string> = {
  'Alt+Tab': 'Windows uses it to switch windows',
  'Alt+F4': 'Windows uses it to close windows',
  'Alt+Space': 'opens the window menu in every app',
  'Ctrl+Alt+Delete': 'reserved by Windows security',
  'Ctrl+Shift+Escape': 'opens Task Manager',
  'Ctrl+Escape': 'opens the Start menu',
  'Ctrl+Space': 'switches input method in many setups',
  'Super+L': 'locks the PC',
  'Super+D': 'shows the desktop',
  'Super+E': 'opens File Explorer',
  'Super+R': 'opens Run',
  'Super+Tab': 'opens Task View',
  'Super+Shift+S': 'takes a screenshot',
  'Super+V': 'opens clipboard history',
  'Super+I': 'opens Settings',
  'Super+A': 'opens quick settings',
  'Super+N': 'opens notifications',
  'Super+X': 'opens the quick link menu',
  'Super+Period': 'opens the emoji panel',
  'Super+.': 'opens the emoji panel',
  'Super+Space': 'switches keyboard layout',
}
const COMMON_APP = new Set(['A', 'C', 'V', 'X', 'Z', 'Y', 'S', 'F', 'P', 'N', 'O', 'W', 'T', 'R', 'Q', 'B', 'I', 'U'])

/** Validates one accelerator in isolation and against the other configured shortcuts. */
export function checkShortcut(text: string, others: Record<string, string> = {}, self?: string): ShortcutCheck {
  const warnings: string[] = []
  if (!text) return { ok: true, warnings: ['Shortcut is disabled.'] }
  const a = parseAccelerator(text)
  if (!a) return { ok: false, error: 'That is not a valid shortcut.', warnings }
  const norm = formatAccelerator(a)
  const hasMain = a.mods.includes('Ctrl') || a.mods.includes('Alt') || a.mods.includes('Super')
  const fnKey = /^F(1[3-9]|2[0-4])$/.test(a.key)
  if (!hasMain && !fnKey) return { ok: false, error: 'Add Ctrl, Alt or Win so the shortcut does not block normal typing.', warnings }
  if (RESERVED[norm]) return { ok: false, error: `Not available: ${RESERVED[norm]}.`, warnings }
  if (a.mods.length === 1 && a.mods[0] === 'Ctrl' && COMMON_APP.has(a.key))
    return { ok: false, error: `Ctrl+${a.key} is used by almost every application.`, warnings }
  if (a.mods.includes('Super') && a.mods.length === 1) warnings.push('Many Win+key shortcuts belong to Windows and may not register.')
  if (a.mods.includes('Ctrl') && a.mods.includes('Alt') && !a.mods.includes('Shift') && (/^[0-9A-Z]$/.test(a.key) || PUNCTUATION.has(a.key)))
    warnings.push('On some keyboard layouts Ctrl+Alt acts as AltGr and this combination types a character.')
  for (const [name, other] of Object.entries(others)) {
    if (name === self || !other) continue
    if (normaliseAccelerator(other) === norm) return { ok: false, error: `Already used for "${name}".`, warnings }
  }
  return { ok: true, warnings }
}
