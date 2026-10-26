// Downloads the local speech models listed in resources/models.json into ./models (development).
// The packaged app downloads the same manifest from Settings > Voice.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const manifest = JSON.parse(fs.readFileSync('resources/models.json', 'utf8'))
const out = path.resolve(process.argv[2] ?? 'models')
fs.mkdirSync(out, { recursive: true })

for (const m of manifest.models) {
  const target = path.join(out, m.dir ? path.join(m.dir, m.check) : m.file)
  if (fs.existsSync(target)) {
    console.log(`ok      ${m.id} (${m.label})`)
    continue
  }
  const url = `${manifest.base}/${m.url}`
  const tmp = path.join(out, path.basename(m.url) + '.part')
  console.log(`fetch   ${m.id} ${m.sizeMB} MB  ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp))
  if (m.dir) {
    // Windows ships bsdtar, which understands .tar.bz2 (use it explicitly: Git Bash's GNU tar
    // treats "C:" as a remote host).
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
    execFileSync(tar, ['-xjf', tmp, '-C', out], { stdio: 'inherit' })
    fs.rmSync(tmp)
  } else fs.renameSync(tmp, path.join(out, m.file))
  console.log(`done    ${m.id}`)
}
