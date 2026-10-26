// Clawd's Claude Code hook (observer only). Claude Code runs it asynchronously for each hook
// event; it forwards a trimmed copy of the event to Clawd on 127.0.0.1 and always exits 0 with no
// output, so it can never block, alter or slow down a Claude Code session.
// Usage (from settings.json): node clawd-cc-hook.js <EventName>
'use strict'
const started = Date.now()
const fs = require('fs')
const path = require('path')
const http = require('http')

let input = ''
let sent = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  if (input.length < 4000000) input += d
})
process.stdin.on('end', send)
process.stdin.on('error', () => process.exit(0))
setTimeout(send, 2000)
setTimeout(() => process.exit(0), 4000).unref()

function trim(value, max) {
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) + '…' : value
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => trim(v, max))
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).slice(0, 40)) out[k] = trim(value[k], max)
    return out
  }
  return value
}

function send() {
  if (sent) return
  sent = true
  try {
    let payload = {}
    try {
      payload = JSON.parse(input || '{}')
    } catch (e) {
      payload = {}
    }
    // Keep what Clawd needs; drop bulky file contents and tool output.
    const slim = {
      session_id: payload.session_id,
      transcript_path: payload.transcript_path,
      cwd: payload.cwd,
      hook_event_name: payload.hook_event_name,
      permission_mode: payload.permission_mode,
      tool_name: payload.tool_name,
      tool_use_id: payload.tool_use_id,
      tool_input: payload.tool_input ? trim({ file_path: payload.tool_input.file_path, path: payload.tool_input.path, command: payload.tool_input.command, description: payload.tool_input.description, url: payload.tool_input.url, pattern: payload.tool_input.pattern }, 400) : undefined,
      error: trim(payload.error, 2000),
      is_interrupt: payload.is_interrupt,
      notification_type: payload.notification_type,
      message: trim(payload.message, 400),
      title: trim(payload.title, 200),
      source: payload.source,
      reason: payload.reason,
      agent_type: payload.agent_type,
      model: payload.model,
      session_title: trim(payload.session_title, 200),
      last_assistant_message: trim(payload.last_assistant_message, 600),
    }
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bridge.json'), 'utf8'))
    const body = JSON.stringify({ event: process.argv[2] || payload.hook_event_name, t: started, payload: slim })
    const req = http.request(
      { host: '127.0.0.1', port: info.port, path: '/cc/event', method: 'POST', timeout: 900, headers: { 'content-type': 'application/json', 'x-clawd-token': info.token, 'content-length': Buffer.byteLength(body) } },
      (res) => {
        res.resume()
        res.on('end', () => process.exit(0))
      },
    )
    req.on('error', () => process.exit(0))
    req.on('timeout', () => {
      req.destroy()
      process.exit(0)
    })
    req.end(body)
  } catch (e) {
    process.exit(0)
  }
}
