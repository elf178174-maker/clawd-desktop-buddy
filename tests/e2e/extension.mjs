// Browser extension end to end: real Chromium with the unpacked extension, paired with a running
// Clawd. Reddit is served from a local fixture via request interception (the URL is the real
// www.reddit.com, but nothing goes to Reddit). Covers page reading, the draft in a shadow-DOM
// composer, the full "Refine my comment" flow, and writing the result back without posting.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { check, done, launch, ROOT, sleep } from './harness.mjs'

const URL = 'https://www.reddit.com/r/learnprogramming/comments/zq9t3x/should_i_learn_rust_or_go_first/'
const fixture = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'fixtures', 'reddit-thread.html'), 'utf8')
const draft = 'i think go is easier to start with honestly, rust has a really steep learning curve and you will spend weeks fighting the borrow checker before building anything usefull'

const clawd = await launch()
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-chromium-'))
const ext = path.join(ROOT, 'resources', 'extension')
const options = { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] }
// On some Windows setups Chrome for Testing will not start from Playwright's AppData cache
// ("side-by-side configuration is incorrect"); a copy in the project's .cache folder does.
const local = path.join(ROOT, '.cache', 'chromium-' + path.basename(path.dirname(path.dirname(chromium.executablePath()))).split('-').pop(), 'chrome.exe')
let browser
try {
  browser = await chromium.launchPersistentContext(profile, fs.existsSync(local) ? { ...options, executablePath: local } : options)
} catch (err) {
  if (!/spawn UNKNOWN/.test(String(err))) throw err
  fs.cpSync(path.dirname(chromium.executablePath()), path.dirname(local), { recursive: true })
  console.log(`   (Chromium copied to ${path.dirname(local)})`)
  browser = await chromium.launchPersistentContext(profile, { ...options, executablePath: local })
}
try {
  const sw = browser.serviceWorkers()[0] ?? (await browser.waitForEvent('serviceworker', { timeout: 15000 }))
  check('Extension service worker starts', !!sw)
  const pairing = await clawd.main(() => {
    const b = globalThis.__clawd.bridge
    return `${b.port}:${b.token}`
  })
  await sw.evaluate((p) => chrome.storage.local.set({ pairing: p }).then(() => connect()), pairing)
  let connected = false
  for (let i = 0; i < 30 && !connected; i++) {
    await sleep(200)
    connected = await clawd.main(() => globalThis.__clawd.browser.connected)
  }
  check('Extension pairs and connects to Clawd', connected)

  await browser.route('https://www.reddit.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }))
  const page = await browser.newPage()
  await page.goto(URL)
  await page.bringToFront()
  await sleep(500)

  const tabs = await clawd.main(() => globalThis.__clawd.browser.listTabs())
  check('Lists browser tabs', tabs.some((t) => t.url === URL), `${tabs.length} tab(s)`)
  const pageContent = await clawd.main(() => globalThis.__clawd.browser.getPage(null, 20000, false))
  check('Reads the Reddit thread: post and nested comments', /TITLE: Should I learn Rust or Go first\?/.test(pageContent.text) && /u\/gopher_gal/.test(pageContent.text) && /u\/ferris_fan/.test(pageContent.text) && /5 hours a week/.test(pageContent.text), `${pageContent.text.length} chars`)
  check('Leaves out page chrome and ads', !/Promoted|Shopify|Log In/.test(pageContent.text))

  // Type a draft into the shadow-DOM composer.
  await page.locator('comment-composer').locator('[contenteditable]').click()
  await page.keyboard.type(draft)
  const got = await clawd.main(() => globalThis.__clawd.browser.getDraft())
  check('Reads the draft from the focused comment box', got.found && got.text === draft, got.kind)

  // Full flow: summon context as captureSummon builds it, then the quick action.
  const ctx = { capturedAt: Date.now(), app: 'Chromium', title: await page.title(), url: URL, draft: got.text }
  await clawd.main((_e, c) => {
    void globalThis.__clawd.brain.call('summonContext', c)
    globalThis.__clawd.panel.show(true, { context: c })
  }, ctx)
  const panel = await clawd.page('panel')
  await panel.waitForSelector('.action.primary')
  await panel.click('.action.primary')
  await panel.waitForFunction(() => document.querySelector('.result .answer .md')?.textContent.trim().length > 20, null, { timeout: 180000 })
  const refined = await panel.evaluate(() => document.querySelector('.result .answer .md').textContent.trim())
  const steps = await clawd.main(async () => {
    const list = await globalThis.__clawd.brain.call('tasks.list')
    const t = await globalThis.__clawd.brain.call('tasks.get', list[0].id)
    return t.steps.map((s) => s.tool).filter(Boolean)
  })
  check('Refines the comment in context', /\bI think\b/.test(refined) && /\bGo\b/.test(refined) && !/usefull/.test(refined), refined.slice(0, 200))
  check('Read the thread through the extension', steps.includes('browser_get_page'), JSON.stringify(steps))

  // Put it back into the comment box (never posts).
  await panel.click('text=Put in comment box')
  await sleep(800)
  const boxText = await page.locator('comment-composer').locator('[contenteditable]').innerText()
  const posted = await page.evaluate(() => !!window.__posted)
  check('Puts the refined comment into the box', boxText.trim() === refined.trim(), boxText.slice(0, 80))
  check('Did not post anything', !posted)
} finally {
  await browser.close().catch(() => {})
  fs.rmSync(profile, { recursive: true, force: true })
  await clawd.close()
}
done()
