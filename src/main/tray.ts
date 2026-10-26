// System tray: the always-available way to reveal and control Clawd.

import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import { resourcePath } from './paths'

export interface TrayActions {
  summon: () => void
  toggleVisible: () => void
  toggleVoice: () => void
  toggleWake: () => void
  toggleFocus: () => void
  openSettings: (section?: string) => void
  cancelTask: () => void
  quit: () => void
}

export interface TrayModel {
  visible: boolean
  focus: boolean
  voiceAvailable: boolean
  wakeOn: boolean
  busy: boolean
  status: string
}

export class ClawdTray {
  private tray: Tray
  private model: TrayModel = { visible: true, focus: false, voiceAvailable: false, wakeOn: false, busy: false, status: '' }

  constructor(private actions: TrayActions) {
    this.tray = new Tray(this.icon(false))
    this.tray.setToolTip('Clawd')
    this.tray.on('click', () => actions.summon())
    this.render()
  }

  private icon(focus: boolean) {
    const file = resourcePath('icons', focus ? 'tray-focus.png' : 'tray.png')
    const img = nativeImage.createFromPath(file)
    const hi = nativeImage.createFromPath(file.replace(/\.png$/, '@2x.png'))
    if (!hi.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() })
    return img.isEmpty() ? nativeImage.createFromPath(path.join(resourcePath('icons'), 'clawd-16.png')) : img
  }

  update(patch: Partial<TrayModel>): void {
    const prevFocus = this.model.focus
    this.model = { ...this.model, ...patch }
    if (prevFocus !== this.model.focus) this.tray.setImage(this.icon(this.model.focus))
    this.tray.setToolTip(this.model.status ? `Clawd: ${this.model.status}` : 'Clawd')
    this.render()
  }

  private render(): void {
    const m = this.model
    const a = this.actions
    const items: MenuItemConstructorOptions[] = [
      { label: 'Talk to Clawd', click: a.summon },
      { label: m.visible ? 'Hide Clawd' : 'Show Clawd', click: a.toggleVisible },
      { type: 'separator' },
      { label: 'Voice input', enabled: m.voiceAvailable, click: a.toggleVoice },
      { label: 'Listen for "Hey Clawd"', type: 'checkbox', checked: m.wakeOn, enabled: m.voiceAvailable, click: a.toggleWake },
      { label: 'Focus mode', type: 'checkbox', checked: m.focus, click: a.toggleFocus },
      { type: 'separator' },
      { label: 'Stop current task', enabled: m.busy, click: a.cancelTask },
      { label: 'Task history', click: () => a.openSettings('tasks') },
      { label: 'Settings', click: () => a.openSettings() },
      { type: 'separator' },
      { label: 'Quit Clawd', click: a.quit },
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  destroy(): void {
    this.tray.destroy()
  }
}
