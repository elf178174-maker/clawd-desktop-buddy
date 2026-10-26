'use strict'
const dot = document.getElementById('dot')
const label = document.getElementById('status')
const code = document.getElementById('code')

function show(s) {
  dot.className = s && s.connected ? 'dot ok' : 'dot'
  label.textContent = s && s.connected ? 'Connected to Clawd' : (s && s.error) || 'Not connected'
}

chrome.runtime.sendMessage({ type: 'getStatus' }, show)
chrome.runtime.onMessage.addListener((m) => m.type === 'status' && show(m.status))
chrome.storage.local.get('pairing').then(({ pairing }) => {
  if (pairing) code.value = pairing
})
document.getElementById('pair').addEventListener('click', () => {
  const value = code.value.trim()
  if (!/^\d{2,5}:[a-f0-9]{48}$/.test(value)) {
    show({ connected: false, error: 'That is not a valid pairing code.' })
    return
  }
  label.textContent = 'Connecting…'
  chrome.runtime.sendMessage({ type: 'pair', pairing: value })
})
