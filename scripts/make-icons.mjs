// Generates Clawd's app and tray icons from the 12x8 reference sprite (crisp, nearest-neighbour):
// resources/icons/clawd-<size>.png, resources/icons/tray-*.png and resources/icon.ico.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SPRITE = [
  '..########..',
  '..#.####.#..',
  '############',
  '############',
  '..########..',
  '..########..',
  '..#.#..#.#..',
  '..#.#..#.#..',
]
const ORANGE = [0xd7, 0x77, 0x57, 255]
const EYE = [0x14, 0x12, 0x10, 255]

function crc32(buf) {
  let c
  const table = crc32.table ?? (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  }))
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Renders the sprite into a size x size image; `cell` px per sprite pixel, optional rounded tile background. */
function render(size, { tile = null, eyes = EYE, body = ORANGE } = {}) {
  const buf = Buffer.alloc(size * size * 4)
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    buf[i] = c[0]
    buf[i + 1] = c[1]
    buf[i + 2] = c[2]
    buf[i + 3] = c[3]
  }
  if (tile) {
    const r = Math.round(size * 0.22)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const dx = Math.max(r - x, 0, x - (size - 1 - r))
        const dy = Math.max(r - y, 0, y - (size - 1 - r))
        if (dx * dx + dy * dy <= r * r) set(x, y, tile)
      }
  }
  const inner = tile ? size * 0.78 : size
  const cell = Math.max(1, Math.floor(inner / 12))
  const w = cell * 12
  const h = cell * 8
  const ox = Math.floor((size - w) / 2)
  const oy = Math.floor((size - h) / 2)
  SPRITE.forEach((row, r) => {
    for (let k = 0; k < 12; k++) {
      const ch = row[k]
      const isBody = ch === '#'
      const isEye = ch === '.' && r === 1 && (k === 3 || k === 8)
      if (!isBody && !isEye) continue
      for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) set(ox + k * cell + x, oy + r * cell + y, isEye ? eyes : body)
    }
  })
  return png(size, size, buf)
}

function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = 6 + dir.length
  images.forEach(({ size, data }, i) => {
    dir[i * 16] = size >= 256 ? 0 : size
    dir[i * 16 + 1] = size >= 256 ? 0 : size
    dir.writeUInt16LE(1, i * 16 + 4)
    dir.writeUInt16LE(32, i * 16 + 6)
    dir.writeUInt32LE(data.length, i * 16 + 8)
    dir.writeUInt32LE(offset, i * 16 + 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...images.map((i) => i.data)])
}

const out = path.resolve('resources/icons')
fs.mkdirSync(out, { recursive: true })
const tile = [0x1d, 0x1a, 0x17, 255]
const appSizes = [16, 24, 32, 48, 64, 128, 256]
const appImages = appSizes.map((size) => ({ size, data: render(size, { tile: size >= 32 ? tile : null }) }))
for (const { size, data } of appImages) fs.writeFileSync(path.join(out, `clawd-${size}.png`), data)
fs.writeFileSync(path.resolve('resources/icon.ico'), ico(appImages))
fs.writeFileSync(path.resolve('resources/icon.png'), render(512, { tile }))
// Tray icons have no tile; the @2x variant is picked automatically on high-DPI displays.
fs.writeFileSync(path.join(out, 'tray.png'), render(16))
fs.writeFileSync(path.join(out, 'tray@2x.png'), render(32))
fs.writeFileSync(path.join(out, 'tray-focus.png'), render(16, { body: [0x9a, 0x6a, 0x5a, 255] }))
fs.writeFileSync(path.join(out, 'tray-focus@2x.png'), render(32, { body: [0x9a, 0x6a, 0x5a, 255] }))
console.log('icons written to', out)
