// Friendly names for common Windows applications (from their process names).

const KNOWN: Record<string, string> = {
  claude: 'Claude',
  code: 'VS Code',
  cursor: 'Cursor',
  devenv: 'Visual Studio',
  msedge: 'Edge',
  chrome: 'Chrome',
  arc: 'Arc',
  brave: 'Brave',
  firefox: 'Firefox',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
  winword: 'Word',
  excel: 'Excel',
  powerpnt: 'PowerPoint',
  onenote: 'OneNote',
  outlook: 'Outlook',
  olk: 'Outlook',
  'ms-teams': 'Teams',
  teams: 'Teams',
  explorer: 'File Explorer',
  windowsterminal: 'Terminal',
  cmd: 'Command Prompt',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  notepad: 'Notepad',
  'notepad++': 'Notepad++',
  discord: 'Discord',
  slack: 'Slack',
  spotify: 'Spotify',
  obsidian: 'Obsidian',
  notion: 'Notion',
  figma: 'Figma',
  unity: 'Unity',
  blender: 'Blender',
  krita: 'Krita',
  resolve: 'DaVinci Resolve',
  steam: 'Steam',
  acrobat: 'Acrobat',
  sumatrapdf: 'SumatraPDF',
  systemsettings: 'Settings',
  applicationframehost: 'Windows app',
  electron: 'Electron app',
}

export function prettyApp(process: string): string {
  const base = process.replace(/\.exe$/i, '')
  const k = base.toLowerCase()
  if (KNOWN[k]) return KNOWN[k]
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : base
}
