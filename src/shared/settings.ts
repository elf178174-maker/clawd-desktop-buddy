// Settings schema. Every leaf has its own fallback (`.catch`), so a corrupt or outdated settings
// file degrades field by field instead of being thrown away wholesale.

import { z } from 'zod'

const bool = (d: boolean) => z.boolean().catch(d)
const num = (d: number, min = -Infinity, max = Infinity) =>
  z
    .number()
    .refine((v) => Number.isFinite(v) && v >= min && v <= max)
    .catch(d)
const int = (d: number, min = -Infinity, max = Infinity) =>
  z
    .number()
    .int()
    .refine((v) => v >= min && v <= max)
    .catch(d)
const str = (d: string, max = 2000) => z.string().max(max).catch(d)
const oneOf = <const T extends readonly [string, ...string[]]>(values: T, d: T[number]) => z.enum(values).catch(d)
const strList = (d: string[]) => z.array(z.string().max(1000)).max(200).catch(d)
function group<S extends z.ZodRawShape>(shape: S) {
  const obj = z.object(shape)
  return obj.prefault({} as z.input<typeof obj>).catch(() => obj.parse({}))
}

export const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'custom'] as const
export const PROVIDERS = ['ollama', 'openai', 'anthropic', 'gemini', 'compatible'] as const
export type ProviderId = (typeof PROVIDERS)[number]
export const PERMISSION_CATEGORIES = [
  'context', // reading the active window, selection, accessible text
  'screen', // screenshots
  'web', // search and reading public pages
  'browser', // reading the user's browser tabs through the extension
  'clipboard', // reading and writing the clipboard
  'files_read',
  'files_write',
  'files_delete',
  'apps', // launching applications and opening URLs
  'input', // moving the real mouse, clicking, typing
  'shell', // running commands
  'claude_code', // sending instructions to Claude Code
  'memory', // saving memories
  'notify',
] as const
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number]
export type PermissionRule = 'allow' | 'ask' | 'deny'
const rule = (d: PermissionRule) => oneOf(['allow', 'ask', 'deny'], d)

export const PERMISSION_PRESETS: Record<'careful' | 'balanced' | 'trusting', Record<PermissionCategory, PermissionRule>> = {
  careful: {
    context: 'ask', screen: 'ask', web: 'allow', browser: 'ask', clipboard: 'ask', files_read: 'ask', files_write: 'ask',
    files_delete: 'ask', apps: 'ask', input: 'ask', shell: 'ask', claude_code: 'ask', memory: 'ask', notify: 'allow',
  },
  balanced: {
    context: 'allow', screen: 'ask', web: 'allow', browser: 'allow', clipboard: 'allow', files_read: 'allow', files_write: 'ask',
    files_delete: 'ask', apps: 'ask', input: 'ask', shell: 'ask', claude_code: 'ask', memory: 'allow', notify: 'allow',
  },
  trusting: {
    context: 'allow', screen: 'allow', web: 'allow', browser: 'allow', clipboard: 'allow', files_read: 'allow', files_write: 'allow',
    files_delete: 'ask', apps: 'allow', input: 'ask', shell: 'ask', claude_code: 'ask', memory: 'allow', notify: 'allow',
  },
}

const permissionRules = group(
  Object.fromEntries(PERMISSION_CATEGORIES.map((c) => [c, rule(PERMISSION_PRESETS.balanced[c])])) as Record<PermissionCategory, ReturnType<typeof rule>>,
)

export const DEFAULT_SHORTCUTS = {
  summon: 'Ctrl+Alt+Space',
  voice: 'Ctrl+Alt+V',
  cancel: 'Ctrl+Alt+Backspace',
  toggleVisible: 'Ctrl+Alt+H',
  focusMode: 'Ctrl+Alt+F',
  settings: 'Ctrl+Alt+,',
} as const
export type ShortcutAction = keyof typeof DEFAULT_SHORTCUTS
export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  summon: 'Summon Clawd',
  voice: 'Start or stop voice input',
  cancel: 'Cancel the current task',
  toggleVisible: 'Hide or show Clawd',
  focusMode: 'Toggle focus mode',
  settings: 'Open settings',
}

export const SettingsSchema = z.object({
  version: int(1),
  general: group({
    startWithWindows: bool(false),
    /** Start with Clawd tucked away; he appears when summoned. */
    startInTray: bool(false),
    showOnStartup: bool(true),
    theme: oneOf(['system', 'dark', 'light'], 'system'),
    language: oneOf(['en'], 'en'),
    /** Hide after this many minutes without interaction; 0 never hides. */
    hideAfterIdleMinutes: num(0, 0, 480),
    /** First-run welcome has been shown. */
    onboarded: bool(false),
  }),
  companion: group({
    /** CSS pixels per art unit (Clawd is 12 x 8 units). */
    size: num(7, 4, 16),
    display: str('primary', 64),
    corner: oneOf(CORNERS, 'bottom-right'),
    /** Distance from the screen edge for corner placements, in CSS px. */
    edgeOffset: num(240, 0, 2000),
    /** Free placement as fractions of the work area (corner = 'custom'). */
    customX: num(0.85, 0, 1),
    customY: num(1, 0, 1),
    clickThrough: oneOf(['smart', 'always', 'never'], 'smart'),
    avoidCovering: oneOf(['off', 'fade', 'move'], 'fade'),
    /** After being dropped he falls to the bottom of the screen. */
    gravity: bool(true),
  }),
  appearance: group({
    animationIntensity: num(1, 0, 1),
    idleFrequency: num(1, 0, 2),
    reducedMotion: oneOf(['system', 'on', 'off'], 'system'),
    cursorFollow: bool(true),
    pixelSnap: oneOf(['device', 'art'], 'device'),
    shadow: bool(true),
    laptopProp: bool(true),
    sitAfterSeconds: num(75, 0, 3600),
    napAfterMinutes: num(10, 0, 480),
    cursorTheme: oneOf(['ember', 'clawd', 'paper'], 'ember'),
    cursorStyle: oneOf(['smooth', 'pixel'], 'smooth'),
    /** Glow around the screen edges while Clawd uses his cursor, controls input, or listens. */
    edgeGlow: oneOf(['aurora', 'clawd', 'off'], 'aurora'),
    glowWhileListening: bool(true),
  }),
  sound: group({
    interactionSounds: bool(true),
    volume: num(0.45, 0, 1),
  }),
  voice: group({
    enabled: bool(true),
    wakeWord: bool(true),
    /** The user agreed to let the microphone stay open for the wake word. */
    wakeConsent: bool(false),
    /** Opening the panel starts listening right away; typing switches to the keyboard. */
    listenOnSummon: bool(true),
    wakePhrase: str('Hey Clawd', 60),
    sensitivity: num(0.5, 0, 1),
    micDevice: str('default', 300),
    language: oneOf(['en'], 'en'),
    endSilenceMs: int(900, 300, 4000),
    maxUtteranceSec: int(20, 3, 120),
    speak: bool(true),
    /** 'voice' speaks only when the request came by voice. */
    speakWhen: oneOf(['voice', 'always'], 'voice'),
    ttsEngine: oneOf(['kokoro', 'system'], 'kokoro'),
    ttsVoice: str('am_puck', 80),
    systemVoice: str('', 200),
    speed: num(1.05, 0.6, 1.6),
    volume: num(0.85, 0, 1),
  }),
  shortcuts: group({
    summon: str(DEFAULT_SHORTCUTS.summon, 80),
    voice: str(DEFAULT_SHORTCUTS.voice, 80),
    cancel: str(DEFAULT_SHORTCUTS.cancel, 80),
    toggleVisible: str(DEFAULT_SHORTCUTS.toggleVisible, 80),
    focusMode: str(DEFAULT_SHORTCUTS.focusMode, 80),
    settings: str(DEFAULT_SHORTCUTS.settings, 80),
  }),
  ai: group({
    provider: oneOf(PROVIDERS, 'ollama'),
    ollama: group({ baseUrl: str('http://127.0.0.1:11434', 300), model: str('qwen3.5:4b', 200), numCtx: int(16384, 2048, 262144), keepAlive: str('15m', 20) }),
    openai: group({ baseUrl: str('https://api.openai.com/v1', 300), model: str('', 200) }),
    anthropic: group({ baseUrl: str('https://api.anthropic.com', 300), model: str('', 200) }),
    gemini: group({ baseUrl: str('https://generativelanguage.googleapis.com/v1beta', 300), model: str('', 200) }),
    compatible: group({ name: str('Custom', 60), baseUrl: str('', 300), model: str('', 200) }),
    temperature: num(0.4, 0, 2),
    reasoning: oneOf(['off', 'low', 'medium', 'high'], 'off'),
    maxSteps: int(24, 1, 80),
    toolTimeoutSec: int(90, 5, 900),
    vision: oneOf(['auto', 'off'], 'auto'),
    /** What to do when the chosen provider is unreachable. */
    fallback: oneOf(['none', 'ollama'], 'none'),
  }),
  permissions: group({
    preset: oneOf(['careful', 'balanced', 'trusting', 'custom'], 'balanced'),
    rules: permissionRules,
    /** Folders Clawd may read and write without leaving them; anything else always asks. */
    fileRoots: strList([]),
    inputAutomation: bool(true),
    appControl: bool(true),
    shell: bool(true),
  }),
  privacy: group({
    microphone: bool(true),
    screenAwareness: bool(true),
    clipboardMonitor: bool(false),
    browserAccess: bool(true),
    /** Before sending selection/clipboard/screen/page content to a hosted (non-local) model. */
    cloudContext: oneOf(['ask', 'allow'], 'ask'),
    backgroundTasks: bool(true),
  }),
  suggestions: group({
    enabled: bool(true),
    frequency: oneOf(['rare', 'normal'], 'rare'),
    errors: bool(true),
    articles: bool(true),
    selection: bool(true),
    builds: bool(true),
    clipboard: bool(true),
  }),
  memory: group({
    enabled: bool(true),
    /** 'ask': Clawd proposes memories and you confirm; 'auto': saves durable preferences himself. */
    autoRemember: oneOf(['ask', 'auto', 'off'], 'ask'),
    retentionDays: int(0, 0, 3650),
  }),
  tasks: group({
    retentionDays: int(30, 1, 3650),
    /** 'summary' stores tool calls without their full outputs. */
    detail: oneOf(['summary', 'full'], 'full'),
    undoRetentionDays: int(14, 1, 365),
  }),
  focus: group({
    active: bool(false),
    trigger: oneOf(['manual', 'schedule', 'apps'], 'manual'),
    days: z.array(z.number().int().min(0).max(6)).max(7).catch([1, 2, 3, 4, 5]),
    start: str('09:00', 5),
    end: str('17:00', 5),
    apps: strList(['Code.exe', 'devenv.exe', 'WINWORD.EXE', 'POWERPNT.EXE']),
  }),
  notifications: group({
    enabled: bool(true),
    taskDone: bool(true),
    taskFailed: bool(true),
    permission: bool(true),
    claudeCode: bool(true),
    integration: bool(true),
    /** Only notify about finished tasks that ran at least this long, or while Clawd's panel was hidden. */
    minTaskSeconds: int(20, 0, 3600),
    quietHours: bool(false),
    quietStart: str('22:00', 5),
    quietEnd: str('08:00', 5),
  }),
  integrations: group({
    claudeCode: bool(true),
    browser: bool(true),
  }),
})

export type Settings = z.infer<typeof SettingsSchema>

export function defaultSettings(): Settings {
  return SettingsSchema.parse({})
}

/** Validates arbitrary JSON into Settings, keeping every valid field and defaulting the rest. */
export function sanitizeSettings(raw: unknown): Settings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const parsed = SettingsSchema.safeParse(value)
  return parsed.success ? parsed.data : defaultSettings()
}

type Primitive = string | number | boolean | null | undefined | readonly unknown[]
export type DeepPartial<T> = T extends Primitive ? T : { [K in keyof T]?: DeepPartial<T[K]> }

/** Deep-merges a patch into settings and re-validates. Arrays are replaced, not merged. */
export function mergeSettings(base: Settings, patch: DeepPartial<Settings>): Settings {
  const merge = (a: unknown, b: unknown): unknown => {
    if (b === undefined) return a
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
      for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = merge(out[k], v)
      return out
    }
    return b
  }
  return sanitizeSettings(merge(base, patch))
}

/** Lists dotted paths whose values differ between two settings objects. */
export function diffSettings(a: Settings, b: Settings): string[] {
  const out: string[] = []
  const walk = (x: unknown, y: unknown, path: string) => {
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)])
      for (const k of keys) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], path ? `${path}.${k}` : k)
    } else if (JSON.stringify(x) !== JSON.stringify(y)) out.push(path)
  }
  walk(a, b, '')
  return out
}
