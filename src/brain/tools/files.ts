// File and document tools. Every change is backed up first so it can be undone from the task
// timeline; deletions go to the Recycle Bin (and are backed up too).

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import fs from 'node:fs'
import path from 'node:path'
import type { FileChange } from '../../shared/types'
import { clip } from '../store'
import { approvalReasons, expandPath, isProtected } from './paths'
import { fail, ok, type AnyTool, type ToolContext } from './types'
import { docxText } from './zip'

const TEXT_LIMIT = 2_000_000

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
}

const pathParam = { type: 'string' as const, maxLength: 1000, description: 'Absolute path, or relative to the home folder with ~ (e.g. ~/Documents/notes.md).' }
const writeReasons = (p: string, ctx: ToolContext) => approvalReasons(p, ctx.settings, 'write', ctx.extraRoots)
const readReasons = (p: string, ctx: ToolContext) => approvalReasons(p, ctx.settings, 'read', ctx.extraRoots)

function recordChange(ctx: ToolContext, change: FileChange): FileChange {
  ctx.task.files.push(change)
  return change
}

/** Converts simple Markdown (headings, paragraphs, bullets, bold/italic) to a .docx buffer. */
async function markdownToDocx(md: string, title?: string): Promise<Buffer> {
  const paras: Paragraph[] = []
  const runs = (text: string): TextRun[] =>
    text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/).filter(Boolean).map((t) =>
      t.startsWith('**') ? new TextRun({ text: t.slice(2, -2), bold: true }) : t.startsWith('`') ? new TextRun({ text: t.slice(1, -1), font: 'Consolas' }) : t.startsWith('*') && t.length > 2 ? new TextRun({ text: t.slice(1, -1), italics: true }) : new TextRun(t),
    )
  for (const line of md.split(/\r?\n/)) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][h[1].length - 1]
      paras.push(new Paragraph({ heading: level, children: runs(h[2]) }))
    } else if (/^\s*[-*]\s+/.test(line)) paras.push(new Paragraph({ bullet: { level: 0 }, children: runs(line.replace(/^\s*[-*]\s+/, '')) }))
    else if (/^\s*\d+\.\s+/.test(line)) paras.push(new Paragraph({ children: runs(line.trim()) }))
    else paras.push(new Paragraph({ children: runs(line) }))
  }
  const doc = new Document({ title: title ?? 'Document', creator: 'Clawd', sections: [{ children: paras }] })
  return Buffer.from(await Packer.toBuffer(doc))
}

function markdownToHtml(md: string, title: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/`([^`]+)`/g, '<code>$1</code>')
  const out: string[] = []
  let list = false
  for (const line of md.split(/\r?\n/)) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    const li = /^\s*[-*]\s+(.*)$/.exec(line)
    if (!li && list) {
      out.push('</ul>')
      list = false
    }
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
    else if (li) {
      if (!list) out.push('<ul>')
      list = true
      out.push(`<li>${inline(li[1])}</li>`)
    } else if (line.trim()) out.push(`<p>${inline(line)}</p>`)
  }
  if (list) out.push('</ul>')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;color:#222}code{background:#f3f1ec;padding:0 .3em;border-radius:3px}</style></head><body>\n${out.join('\n')}\n</body></html>\n`
}

export const fileTools: AnyTool[] = [
  {
    name: 'list_files',
    description: 'Lists the contents of a folder (names, sizes, modified dates). Use recursive with care.',
    category: 'files_read',
    parameters: {
      type: 'object',
      properties: { path: pathParam, recursive: { type: 'boolean' }, max: { type: 'integer', minimum: 1, maximum: 2000 } },
      required: ['path'],
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: (a: { path: string }) => ({ title: 'List a folder', details: expandPath(a.path) }),
    needsApproval: (a: { path: string }, ctx) => readReasons(expandPath(a.path), ctx),
    async run(a: { path: string; recursive?: boolean; max?: number }) {
      const root = expandPath(a.path)
      if (!fs.existsSync(root)) return fail(`${root} does not exist.`)
      if (!fs.statSync(root).isDirectory()) return fail(`${root} is a file, not a folder.`)
      const max = a.max ?? 300
      const lines: string[] = []
      const walk = (dir: string, depth: number) => {
        let entries: fs.Dirent[] = []
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch (err) {
          lines.push(`${'  '.repeat(depth)}(cannot read: ${(err as Error).message})`)
          return
        }
        entries.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name))
        for (const e of entries) {
          if (lines.length >= max) return
          const full = path.join(dir, e.name)
          if (e.isDirectory()) {
            lines.push(`${'  '.repeat(depth)}${e.name}/`)
            if (a.recursive && !/^(node_modules|\.git|\.venv|__pycache__)$/.test(e.name) && depth < 6) walk(full, depth + 1)
          } else {
            try {
              const st = fs.statSync(full)
              lines.push(`${'  '.repeat(depth)}${e.name}  ${fmtSize(st.size)}  ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')}`)
            } catch {
              lines.push(`${'  '.repeat(depth)}${e.name}`)
            }
          }
        }
      }
      walk(root, 0)
      // File names are chosen by whoever made the files (downloads, archives): data, not instructions.
      return ok(`${root}\n${lines.join('\n')}${lines.length >= max ? `\n(stopped at ${max} entries)` : ''}`, { untrusted: 'file names', summary: `${lines.length} entries in ${path.basename(root)}` })
    },
  },
  {
    name: 'read_file',
    description: 'Reads a text file (code, notes, logs, csv, json, md...) or the text of a .docx document. Returns up to max_chars characters; use offset to page through long files.',
    category: 'files_read',
    parameters: {
      type: 'object',
      properties: {
        path: pathParam,
        offset: { type: 'integer', minimum: 0 },
        max_chars: { type: 'integer', minimum: 200, maximum: 200000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: (a: { path: string }) => ({ title: 'Read a file', details: expandPath(a.path) }),
    needsApproval: (a: { path: string }, ctx) => readReasons(expandPath(a.path), ctx),
    async run(a: { path: string; offset?: number; max_chars?: number }) {
      const p = expandPath(a.path)
      if (!fs.existsSync(p)) return fail(`${p} does not exist.`)
      const st = fs.statSync(p)
      if (st.isDirectory()) return fail(`${p} is a folder; use list_files.`)
      if (st.size > 50_000_000) return fail(`${p} is too large to read (${fmtSize(st.size)}).`)
      const buf = fs.readFileSync(p)
      let text: string
      if (/\.docx$/i.test(p)) {
        const t = docxText(buf)
        if (t === null) return fail('Could not read the text of that .docx file.')
        text = t
      } else if (/\.pdf$/i.test(p)) return fail('Reading PDF files is not supported yet. Ask the user to copy the text or open it in the browser and use browser_get_page.')
      else if (isBinary(buf)) return fail(`${p} looks like a binary file and cannot be read as text.`)
      else text = buf.subarray(0, TEXT_LIMIT).toString('utf8')
      const off = a.offset ?? 0
      const max = a.max_chars ?? 30000
      const slice = text.slice(off, off + max)
      const more = off + max < text.length ? `\n[... ${text.length - off - max} more characters; continue with offset=${off + max}]` : ''
      return ok(`${p} (${fmtSize(st.size)})\n\n${slice}${more}`, { untrusted: `file ${path.basename(p)}`, summary: `${path.basename(p)}: ${slice.length} chars` })
    },
  },
  {
    name: 'search_files',
    description: 'Finds files under a folder whose name matches a pattern and/or whose text contains a phrase. Skips node_modules and .git.',
    category: 'files_read',
    parameters: {
      type: 'object',
      properties: {
        path: pathParam,
        name: { type: 'string', maxLength: 200, description: 'Substring or *.ext pattern for file names.' },
        contains: { type: 'string', maxLength: 300, description: 'Text to look for inside files (case-insensitive).' },
        max: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    risk: () => 'low',
    describe: (a: { path: string; name?: string; contains?: string }) => ({ title: 'Search files', details: `${expandPath(a.path)} ${a.name ?? ''} ${a.contains ? `"${a.contains}"` : ''}` }),
    needsApproval: (a: { path: string }, ctx) => readReasons(expandPath(a.path), ctx),
    timeoutSec: 60,
    async run(a: { path: string; name?: string; contains?: string; max?: number }, ctx) {
      const root = expandPath(a.path)
      if (!fs.existsSync(root)) return fail(`${root} does not exist.`)
      const max = a.max ?? 100
      const nameRe = a.name ? new RegExp('^' + a.name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null
      const needle = a.contains?.toLowerCase()
      const hits: string[] = []
      let scanned = 0
      const walk = (dir: string, depth: number) => {
        if (hits.length >= max || depth > 12 || ctx.signal.aborted) return
        let entries: fs.Dirent[] = []
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (hits.length >= max) return
          const full = path.join(dir, e.name)
          if (e.isDirectory()) {
            if (!/^(node_modules|\.git|\.venv|__pycache__|dist|out|build)$/.test(e.name)) walk(full, depth + 1)
            continue
          }
          const nameOk = nameRe ? nameRe.test(e.name) || e.name.toLowerCase().includes((a.name ?? '').toLowerCase()) : true
          if (!nameOk) continue
          if (needle) {
            try {
              const st = fs.statSync(full)
              if (st.size > 2_000_000) continue
              const buf = fs.readFileSync(full)
              if (isBinary(buf)) continue
              scanned++
              const text = buf.toString('utf8')
              const i = text.toLowerCase().indexOf(needle)
              if (i < 0) continue
              const line = text.slice(0, i).split('\n').length
              hits.push(`${full}:${line}: ${clip(text.slice(Math.max(0, i - 60), i + 100).replace(/\s+/g, ' '), 180)}`)
            } catch {
              continue
            }
          } else hits.push(full)
        }
      }
      walk(root, 0)
      if (!hits.length) return fail(`No matches under ${root}${needle ? ` (${scanned} files scanned)` : ''}.`)
      return ok(hits.join('\n'), { untrusted: 'file search results', summary: `${hits.length} matches` })
    },
  },
  {
    name: 'write_file',
    description: 'Creates or overwrites a text file. The previous version is backed up so the change can be undone. Prefer edit_file for small changes to existing files.',
    category: 'files_write',
    parameters: {
      type: 'object',
      properties: { path: pathParam, content: { type: 'string', maxLength: 2_000_000 }, overwrite: { type: 'boolean', description: 'Must be true to replace an existing file.' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    risk: (a: { path: string }) => (fs.existsSync(expandPath(a.path)) ? 'high' : 'medium'),
    describe: (a: { path: string; content: string }) => ({
      title: fs.existsSync(expandPath(a.path)) ? 'Overwrite a file' : 'Create a file',
      details: `${expandPath(a.path)} (${a.content.length.toLocaleString('en-US')} characters)\n\n${clip(a.content, 20000)}`,
    }),
    needsApproval: (a: { path: string }, ctx) => {
      const r = writeReasons(expandPath(a.path), ctx)
      if (fs.existsSync(expandPath(a.path))) r.push('replaces an existing file')
      return r
    },
    async run(a: { path: string; content: string; overwrite?: boolean }, ctx) {
      const p = expandPath(a.path)
      if (isProtected(p)) return fail(`${p} is in a protected system location; Clawd will not write there.`)
      const exists = fs.existsSync(p)
      if (exists && fs.statSync(p).isDirectory()) return fail(`${p} is a folder.`)
      if (exists && !a.overwrite) return fail(`${p} already exists. Set overwrite=true to replace it (a backup is kept), or use edit_file.`)
      const backupId = exists ? ctx.undo.backup(ctx.task.id, p) : undefined
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, a.content, 'utf8')
      const written = fs.readFileSync(p, 'utf8')
      if (written !== a.content) return fail(`Wrote ${p} but the content read back differs.`)
      const change = recordChange(ctx, { path: p, action: exists ? 'modified' : 'created', backupId })
      return ok(`${exists ? 'Overwrote' : 'Created'} ${p} (${fmtSize(Buffer.byteLength(a.content))}). Verified by reading it back.`, {
        files: [change],
        artifacts: [{ kind: 'file', title: path.basename(p), path: p }],
        summary: `${exists ? 'Updated' : 'Created'} ${path.basename(p)}`,
      })
    },
  },
  {
    name: 'edit_file',
    description: 'Replaces an exact piece of text in a file with new text (backed up first). old_text must appear exactly once unless replace_all is true.',
    category: 'files_write',
    parameters: {
      type: 'object',
      properties: {
        path: pathParam,
        old_text: { type: 'string', maxLength: 200000 },
        new_text: { type: 'string', maxLength: 200000 },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
    risk: () => 'medium',
    describe: (a: { path: string; old_text: string; new_text: string; replace_all?: boolean }) => ({
      title: 'Edit a file',
      details: `${expandPath(a.path)}${a.replace_all ? ' (every occurrence)' : ''}\n\n- ${clip(a.old_text, 6000)}\n+ ${clip(a.new_text, 6000)}`,
    }),
    needsApproval: (a: { path: string }, ctx) => writeReasons(expandPath(a.path), ctx),
    async run(a: { path: string; old_text: string; new_text: string; replace_all?: boolean }, ctx) {
      const p = expandPath(a.path)
      if (isProtected(p)) return fail(`${p} is in a protected system location.`)
      if (!fs.existsSync(p)) return fail(`${p} does not exist.`)
      const text = fs.readFileSync(p, 'utf8')
      const count = text.split(a.old_text).length - 1
      if (count === 0) return fail('old_text was not found in the file. Read the file again and copy the exact text.')
      if (count > 1 && !a.replace_all) return fail(`old_text appears ${count} times. Include more surrounding text, or set replace_all=true.`)
      const backupId = ctx.undo.backup(ctx.task.id, p)
      const next = a.replace_all ? text.split(a.old_text).join(a.new_text) : text.replace(a.old_text, () => a.new_text)
      fs.writeFileSync(p, next, 'utf8')
      const change = recordChange(ctx, { path: p, action: 'modified', backupId })
      return ok(`Edited ${p}: ${a.replace_all ? count : 1} replacement(s).`, { files: [change], summary: `Edited ${path.basename(p)}` })
    },
  },
  {
    name: 'move_path',
    description: 'Moves or renames a file or folder. Will not overwrite an existing destination.',
    category: 'files_write',
    parameters: {
      type: 'object',
      properties: { from: pathParam, to: pathParam },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    risk: () => 'medium',
    describe: (a: { from: string; to: string }) => ({ title: 'Move or rename', details: `${expandPath(a.from)}\n→ ${expandPath(a.to)}` }),
    needsApproval: (a: { from: string; to: string }, ctx) => [...writeReasons(expandPath(a.from), ctx), ...writeReasons(expandPath(a.to), ctx)],
    async run(a: { from: string; to: string }, ctx) {
      const from = expandPath(a.from)
      const to = expandPath(a.to)
      if (isProtected(from) || isProtected(to)) return fail('Protected system locations cannot be changed.')
      if (!fs.existsSync(from)) return fail(`${from} does not exist.`)
      if (fs.existsSync(to)) return fail(`${to} already exists.`)
      const backupId = ctx.undo.backup(ctx.task.id, from)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.renameSync(from, to)
      const change = recordChange(ctx, { path: from, action: 'moved', to, backupId })
      return ok(`Moved ${from} → ${to}.`, { files: [change], summary: `Moved ${path.basename(from)}` })
    },
  },
  {
    name: 'make_folder',
    description: 'Creates a folder (and any missing parent folders).',
    category: 'files_write',
    parameters: { type: 'object', properties: { path: pathParam }, required: ['path'], additionalProperties: false },
    risk: () => 'low',
    describe: (a: { path: string }) => ({ title: 'Create a folder', details: expandPath(a.path) }),
    needsApproval: (a: { path: string }, ctx) => writeReasons(expandPath(a.path), ctx),
    async run(a: { path: string }, ctx) {
      const p = expandPath(a.path)
      if (isProtected(p)) return fail('Protected system locations cannot be changed.')
      if (fs.existsSync(p)) return ok(`${p} already exists.`)
      fs.mkdirSync(p, { recursive: true })
      const change = recordChange(ctx, { path: p, action: 'created' })
      return ok(`Created folder ${p}.`, { files: [change], summary: `Created ${path.basename(p)}/` })
    },
  },
  {
    name: 'delete_path',
    description: 'Deletes a file or folder by moving it to the Recycle Bin (a backup copy is also kept for undo). Always confirm intent with the user first if unclear.',
    category: 'files_delete',
    parameters: { type: 'object', properties: { path: pathParam }, required: ['path'], additionalProperties: false },
    risk: () => 'high',
    describe: (a: { path: string }) => ({ title: 'Delete (to the Recycle Bin)', details: expandPath(a.path) }),
    needsApproval: (a: { path: string }, ctx) => writeReasons(expandPath(a.path), ctx),
    async run(a: { path: string }, ctx) {
      const p = expandPath(a.path)
      if (isProtected(p)) return fail('Protected system locations cannot be changed.')
      if (!fs.existsSync(p)) return fail(`${p} does not exist.`)
      const backupId = ctx.undo.backup(ctx.task.id, p)
      const r = await ctx.host.call('files.trash', p)
      if (!r.ok) return fail(`Could not delete ${p}: ${r.message}`)
      if (fs.existsSync(p)) return fail(`${p} still exists after deleting.`)
      const change = recordChange(ctx, { path: p, action: 'deleted', backupId })
      return ok(`Moved ${p} to the Recycle Bin.`, { files: [change], summary: `Deleted ${path.basename(p)}` })
    },
  },
  {
    name: 'create_document',
    description: 'Creates a document from Markdown content as .md, .txt, .html or .docx (Word). Will not overwrite an existing file.',
    category: 'files_write',
    parameters: {
      type: 'object',
      properties: {
        path: { ...pathParam, description: 'Destination; the extension (.md, .txt, .html, .docx) picks the format.' },
        markdown: { type: 'string', maxLength: 1_000_000 },
        title: { type: 'string', maxLength: 200 },
      },
      required: ['path', 'markdown'],
      additionalProperties: false,
    },
    risk: () => 'medium',
    describe: (a: { path: string; markdown: string }) => ({ title: 'Create a document', details: `${expandPath(a.path)}\n\n${clip(a.markdown, 500)}` }),
    needsApproval: (a: { path: string }, ctx) => writeReasons(expandPath(a.path), ctx),
    async run(a: { path: string; markdown: string; title?: string }, ctx) {
      const p = expandPath(a.path)
      if (isProtected(p)) return fail('Protected system locations cannot be changed.')
      if (fs.existsSync(p)) return fail(`${p} already exists. Choose another name.`)
      const ext = path.extname(p).toLowerCase()
      const title = a.title ?? path.basename(p, ext)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      if (ext === '.docx') fs.writeFileSync(p, await markdownToDocx(a.markdown, title))
      else if (ext === '.html' || ext === '.htm') fs.writeFileSync(p, markdownToHtml(a.markdown, title), 'utf8')
      else if (ext === '.md' || ext === '.txt' || ext === '') fs.writeFileSync(p, a.markdown, 'utf8')
      else return fail(`Unsupported document type "${ext}". Use .md, .txt, .html or .docx.`)
      if (!fs.existsSync(p) || fs.statSync(p).size === 0) return fail('The document was not written.')
      const change = recordChange(ctx, { path: p, action: 'created' })
      return ok(`Created ${p} (${fmtSize(fs.statSync(p).size)}).`, {
        files: [change],
        artifacts: [{ kind: 'file', title: path.basename(p), path: p }],
        summary: `Created ${path.basename(p)}`,
      })
    },
  },
]
