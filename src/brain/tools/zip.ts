// Just enough of a ZIP reader to pull text out of .docx/.pptx/.xlsx files (no dependencies).

import zlib from 'node:zlib'

export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  // Find the end of central directory record.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (entryName === name) {
      const lNameLen = buf.readUInt16LE(local + 26)
      const lExtraLen = buf.readUInt16LE(local + 28)
      const start = local + 30 + lNameLen + lExtraLen
      const data = buf.subarray(start, start + compSize)
      if (method === 0) return data
      if (method === 8) return zlib.inflateRawSync(data)
      return null
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** Plain text of a .docx document, one paragraph per line. */
export function docxText(buf: Buffer): string | null {
  const xml = readZipEntry(buf, 'word/document.xml')
  if (!xml) return null
  return xml
    .toString('utf8')
    .split(/<\/w:p>/)
    .map((p) => unxml((p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
