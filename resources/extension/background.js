// Clawd browser extension: keeps a WebSocket to the Clawd desktop app on 127.0.0.1 and answers
// its requests (list tabs, read a page). Pages are only read when Clawd asks, which only happens
// when you ask Clawd something about a page.
'use strict'

let ws = null
let retry = 1000
let heartbeat = null
let status = { connected: false, error: 'Not paired yet' }

async function pairing() {
  const { pairing } = await chrome.storage.local.get('pairing')
  if (!pairing || !/^\d{2,5}:[a-f0-9]{48}$/.test(pairing)) return null
  const [port, token] = pairing.split(':')
  return { port: Number(port), token }
}

function setStatus(s) {
  status = s
  chrome.action.setBadgeText({ text: s.connected ? '' : '!' })
  chrome.action.setBadgeBackgroundColor({ color: '#d77757' })
  chrome.runtime.sendMessage({ type: 'status', status: s }).catch(() => {})
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  const p = await pairing()
  if (!p) return setStatus({ connected: false, error: 'Not paired yet' })
  try {
    ws = new WebSocket(`ws://127.0.0.1:${p.port}/browser?token=${p.token}`)
  } catch (e) {
    return schedule()
  }
  ws.onopen = () => {
    retry = 1000
    const ua = navigator.userAgentData?.brands?.map((b) => b.brand).filter((b) => !/Not|Chromium/.test(b))[0] || 'Chromium'
    ws.send(JSON.stringify({ type: 'hello', browser: ua, version: chrome.runtime.getManifest().version }))
    setStatus({ connected: true })
    clearInterval(heartbeat)
    // Regular traffic keeps the service worker alive while connected.
    heartbeat = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'ping' })), 20000)
    void reportActive()
  }
  ws.onmessage = (ev) => void handle(ev.data)
  ws.onclose = (ev) => {
    clearInterval(heartbeat)
    setStatus({ connected: false, error: ev.code === 1006 ? 'Clawd is not running (or the pairing code is wrong).' : `Disconnected (${ev.code})` })
    schedule()
  }
  ws.onerror = () => {}
}

function schedule() {
  setTimeout(connect, retry)
  retry = Math.min(30000, retry * 2)
}

async function handle(raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  if (typeof msg.id !== 'number') return
  const reply = (body) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ id: msg.id, ...body }))
  try {
    if (msg.method === 'listTabs') {
      const tabs = await chrome.tabs.query({})
      reply({ result: tabs.filter((t) => t.url && /^https?:/.test(t.url)).map((t) => ({ id: t.id, title: t.title || '', url: t.url, active: t.active, windowId: t.windowId })) })
    } else if (msg.method === 'getPage') {
      reply({ result: await getPage(msg.params || {}) })
    } else if (msg.method === 'getDraft') {
      reply({ result: await inActiveTab(readDraft, []) })
    } else if (msg.method === 'setDraft') {
      reply({ result: await inActiveTab(writeDraft, [String((msg.params || {}).text || '')]) })
    } else reply({ error: `Unknown method ${msg.method}` })
  } catch (e) {
    reply({ error: String(e && e.message ? e.message : e) })
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab
}

async function getPage({ tabId, maxChars = 60000, scroll = false }) {
  const tab = tabId ? await chrome.tabs.get(tabId) : await activeTab()
  if (!tab || !tab.id) throw new Error('No browser tab is active.')
  if (!/^https?:/.test(tab.url || '')) throw new Error('That tab is not a web page (browser pages cannot be read).')
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['vendor/Readability.js'] })
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage, args: [maxChars, scroll] })
  if (!res || !res.result) throw new Error('The page could not be read.')
  return res.result
}

async function inActiveTab(func, args) {
  const tab = await activeTab()
  if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) throw new Error('No web page is active in the browser.')
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args })
  return { ...(res && res.result), url: tab.url, title: tab.title || '' }
}

// Runs inside the page: the text box the user is typing in (their comment or reply draft).
function readDraft() {
  const deepActive = () => {
    let el = document.activeElement
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
    return el
  }
  const editable = (el) => el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url)$/i.test(el.type || 'text')))
  let el = deepActive()
  if (!editable(el)) {
    // Nothing focused: look for a comment composer that already has text (Reddit and common sites).
    const candidates = []
    const walk = (root) => {
      for (const n of root.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')) candidates.push(n)
      for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot)
    }
    walk(document)
    el = candidates.find((c) => ((c.value ?? c.innerText) || '').trim().length > 0) || null
  }
  if (!editable(el)) return { found: false, text: '' }
  const text = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText
  window.__clawdDraftTarget = el
  return { found: true, text: (text || '').trim(), kind: el.isContentEditable ? 'rich' : el.tagName.toLowerCase() }
}

// Runs inside the page: replaces the draft with Clawd's version (never submits anything).
function writeDraft(text) {
  let el = window.__clawdDraftTarget
  if (!el || !el.isConnected) {
    el = document.activeElement
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
  }
  if (!el) return { ok: false, message: 'The comment box could not be found anymore.' }
  el.focus()
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    // Use the native setter so frameworks (React and friends) notice the change.
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, message: 'Put the new text in the box. Nothing was posted.' }
  }
  if (el.isContentEditable) {
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
    // insertText goes through the editor's own input handling (Lexical, Draft.js, ProseMirror).
    const ok = document.execCommand('insertText', false, text)
    if (!ok) el.innerText = text
    return { ok: true, message: 'Put the new text in the box. Nothing was posted.' }
  }
  return { ok: false, message: 'The focused element is not a text box.' }
}

// Runs inside the page.
async function extractPage(maxChars, scroll) {
  if (scroll) {
    // Load lazily rendered content by walking down the page, then return to where the user was.
    const start = window.scrollY
    let last = 0
    for (let i = 0; i < 25; i++) {
      window.scrollBy(0, window.innerHeight * 1.2)
      await new Promise((r) => setTimeout(r, 300))
      const h = document.documentElement.scrollHeight
      if (window.innerHeight + window.scrollY >= h - 4 && h === last) break
      last = h
    }
    window.scrollTo(0, start)
  }
  let title = document.title
  let text = ''
  let byline = ''
  // Reddit threads: the post plus its comments, without the page chrome.
  if (/(^|\.)reddit\.com$/.test(location.hostname)) {
    const clean = (s) => (s || '').replace(/\n{3,}/g, '\n\n').trim()
    const post = document.querySelector('shreddit-post')
    const oldPost = document.querySelector('.thing.link')
    if (post || oldPost) {
      const postTitle = post ? post.getAttribute('post-title') || document.querySelector('h1')?.innerText : oldPost.querySelector('a.title')?.innerText
      const sub = post ? post.getAttribute('subreddit-prefixed-name') : document.querySelector('.redditname a')?.innerText
      const author = post ? post.getAttribute('author') : oldPost.getAttribute('data-author')
      const body = post ? post.querySelector('[slot="text-body"]')?.innerText || '' : oldPost.querySelector('.usertext-body')?.innerText || ''
      const parts = [`${sub || 'Reddit'} · posted by u/${author || '?'}`, `TITLE: ${clean(postTitle)}`, body ? `POST:\n${clean(body)}` : '(link or media post without text)']
      const comments = post ? [...document.querySelectorAll('shreddit-comment')] : [...document.querySelectorAll('.comment')]
      if (comments.length) parts.push(`COMMENTS (${comments.length} loaded):`)
      for (const c of comments.slice(0, 120)) {
        const who = c.getAttribute('author') || c.getAttribute('data-author') || '?'
        const depth = Number(c.getAttribute('depth') || 0)
        const txt = c.querySelector(':scope > [slot="comment"]')?.innerText || c.querySelector(':scope > .entry .usertext-body')?.innerText || ''
        const score = c.getAttribute('score')
        if (txt.trim()) parts.push(`${'  '.repeat(Math.min(depth, 6))}- u/${who}${score ? ` (${score} points)` : ''}: ${clean(txt)}`)
      }
      text = parts.join('\n\n')
      title = postTitle || title
    }
  }
  try {
    if (!text && typeof Readability !== 'undefined') {
      const art = new Readability(document.cloneNode(true)).parse()
      if (art && art.textContent && art.textContent.trim().length > 400) {
        title = art.title || title
        text = art.textContent
        byline = art.byline || ''
      }
    }
  } catch (e) {
    /* fall back to the visible text */
  }
  if (!text) text = document.body ? document.body.innerText : ''
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n').trim()
  return { url: location.href, title, text: text.slice(0, maxChars), byline, length: text.length }
}

async function reportActive() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const tab = await activeTab()
  if (tab && tab.url && /^https?:/.test(tab.url)) ws.send(JSON.stringify({ type: 'activeTab', url: tab.url, title: tab.title || '' }))
}

chrome.tabs.onActivated.addListener(() => void reportActive())
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && (info.url || info.status === 'complete')) void reportActive()
})
chrome.windows.onFocusChanged.addListener(() => void reportActive())

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.type === 'getStatus') send(status)
  if (msg.type === 'pair') {
    void chrome.storage.local.set({ pairing: msg.pairing }).then(() => {
      ws?.close()
      ws = null
      retry = 1000
      void connect()
      send({ ok: true })
    })
    return true
  }
})

// Wake periodically so a restart of Clawd reconnects even after the worker went idle.
chrome.alarms.create('clawd-reconnect', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(() => void connect())
chrome.runtime.onStartup.addListener(() => void connect())
chrome.runtime.onInstalled.addListener(() => void connect())
void connect()
