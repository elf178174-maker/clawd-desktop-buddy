// Compiles native/ClawdNative.cs with the C# compiler that ships with Windows (.NET Framework 4.x).
// Output: native/bin/clawd-native.exe. No SDK install needed.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

if (process.platform !== 'win32') {
  console.log('build-native: skipped (Windows only)')
  process.exit(0)
}
const fw = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')
const csc = path.join(fw, 'csc.exe')
if (!fs.existsSync(csc)) {
  console.error('build-native: csc.exe not found at', csc)
  process.exit(1)
}
const src = path.resolve('native/ClawdNative.cs')
const out = path.resolve('native/bin/clawd-native.exe')
fs.mkdirSync(path.dirname(out), { recursive: true })
if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(src).mtimeMs && !process.argv.includes('--force')) {
  console.log('build-native: up to date')
  process.exit(0)
}
const wpf = path.join(fw, 'WPF')
const refs = ['System.Web.Extensions.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', path.join(wpf, 'UIAutomationClient.dll'), path.join(wpf, 'UIAutomationTypes.dll'), path.join(wpf, 'WindowsBase.dll')]
const args = ['/nologo', '/optimize+', '/target:exe', '/platform:x64', `/out:${out}`, ...refs.map((r) => `/reference:${r}`), src]
try {
  const stdout = execFileSync(csc, args, { encoding: 'utf8' })
  if (stdout.trim()) console.log(stdout.trim())
  console.log('build-native: wrote', out)
} catch (err) {
  console.error(String(err.stdout || err.message))
  process.exit(1)
}
