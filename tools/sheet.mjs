// Bundles a sheet page with esbuild and renders it offscreen with Electron.
// node tools/sheet.mjs tools/sheets/style.ts out.png 1800 1400
import { build } from 'esbuild'
import { spawnSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { pathToFileURL } from 'url'

const [entry, out, w = '1600', h = '1200', ...extra] = process.argv.slice(2)
const outDir = path.resolve('tools/.sheet-build')
fs.mkdirSync(outDir, { recursive: true })
const js = path.join(outDir, path.basename(entry).replace(/\.ts$/, '.js'))
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  outfile: js,
  target: 'chrome130',
  logLevel: 'error',
  define: {
    __REF__: JSON.stringify(pathToFileURL(path.resolve('resources/reference/clawd-ref.png')).href),
    __ARGS__: JSON.stringify(extra),
  },
})
const electron = path.resolve('node_modules/electron/dist/electron.exe')
const r = spawnSync(electron, [path.resolve('tools/sheet-main.cjs'), js, path.resolve(out), w, h], { stdio: 'inherit' })
process.exit(r.status ?? 1)
