// The side-buddy panel: quick actions from context, a result card, tweaks, and history. No browser
// extension here: Clawd reads the thread with his hidden page fetcher, which is served the local
// fixture (nothing goes to Reddit).
import fs from 'node:fs'
import path from 'node:path'
import { check, done, launch, ROOT, SHOTS, sleep } from './harness.mjs'

const fixture = fs.readFileSync(path.join(ROOT, 'tests', 'e2e', 'fixtures', 'reddit-thread.html'), 'utf8')

const { main, page, close } = await launch()
try {
  await sleep(2500)
  await main(({ session, net }, html) => {
    session.fromPartition('clawd-fetch').protocol.handle('https', (req) =>
      new URL(req.url).hostname.endsWith('reddit.com') ? new Response(html, { headers: { 'content-type': 'text/html' } }) : net.fetch(req, { bypassCustomProtocolHandlers: true }),
    )
  }, fixture)
  // Simulate being summoned over a browser page with a comment draft (as the extension reports it).
  const ctx = { capturedAt: Date.now(), app: 'Arc', title: 'Should I learn Rust or Go first? : r/learnprogramming', url: 'https://www.reddit.com/r/learnprogramming/comments/zq9t3x/should_i_learn_rust_or_go_first/', draft: 'i think go is easier to start with honestly, rust has a really steep learning curve and you will spend weeks fighting the borrow checker before building anything usefull' }
  await main((_e, c) => {
    void globalThis.__clawd.brain.call('summonContext', c)
    globalThis.__clawd.companion.summon()
    globalThis.__clawd.panel.show(true, { context: c })
  }, ctx)
  const panel = await page('panel')
  await panel.waitForSelector('.askbar textarea')
  await sleep(700)
  const actions = await panel.evaluate(() => [...document.querySelectorAll('.action')].map((b) => b.textContent))
  check('Reddit thread with a draft offers "Refine my comment" first', actions[0] === 'Refine my comment', JSON.stringify(actions))
  await panel.screenshot({ path: path.join(SHOTS, 'buddy-reddit.png') })

  // Refine without the extension: the draft from the summon context is enough.
  await panel.click('.action.primary')
  await panel.waitForFunction(() => document.querySelector('.result .answer .md')?.textContent.trim().length > 20, null, { timeout: 180000 })
  await sleep(400)
  const answer = await panel.evaluate(() => document.querySelector('.result .answer .md').textContent.trim())
  const buttons = await panel.evaluate(() => [...document.querySelectorAll('.answer-actions .btn')].map((b) => b.textContent.trim()))
  const firstPara = answer
  const note = await panel.evaluate(() => document.querySelector('.result-note')?.textContent ?? '')
  console.log('   note:', note)
  check('Refined comment comes back as plain text', !/^(sure|here|okay|the browser)/i.test(answer) && !/extension/i.test(firstPara) && /rust/i.test(firstPara) && /\bgo\b/i.test(firstPara) && /borrow checker/i.test(firstPara), answer.slice(0, 220))
  check('Offers to put it back in the comment box', buttons.includes('Put in comment box'), JSON.stringify(buttons))
  check('Spelling and capitalisation fixed, voice kept', !/usefull/.test(answer) && /\bI think\b/.test(answer) && /\bGo\b/.test(answer) && /honestly/i.test(answer))
  await panel.screenshot({ path: path.join(SHOTS, 'buddy-refined.png') })

  // One-tap tweak continues the same thread.
  await panel.click('.tweaks .chip:first-child')
  await panel.waitForFunction((prev) => {
    const t = document.querySelector('.result .answer .md')?.textContent.trim()
    return t && t !== prev && document.querySelector('.result-request')?.textContent === 'Refine my comment · Shorter'
  }, answer, { timeout: 180000 })
  const shorter = await panel.evaluate(() => document.querySelector('.result .answer .md').textContent.trim())
  check('"Shorter" tweak shortens the same comment, titled by what was done', shorter.length < answer.length && /rust/i.test(shorter), `${answer.length} -> ${shorter.length} chars`)
  await panel.screenshot({ path: path.join(SHOTS, 'buddy-shorter.png') })

  // Edit, then Done editing: the edit is kept and is what gets applied.
  await panel.click('.answer-actions button:has-text("Edit")')
  await panel.fill('.answer textarea', shorter + ' Just my two cents.')
  await panel.click('.answer-actions button:has-text("Done editing")')
  const shown = await panel.evaluate(() => document.querySelector('.result .answer .md').textContent.trim())
  const tag = await panel.evaluate(() => document.querySelector('.edited-tag')?.textContent ?? '')
  check('Edits survive "Done editing" and can be reverted', shown.endsWith('Just my two cents.') && /Edited/.test(tag) && /Revert/.test(tag), tag)

  // The other actions stay under the result; a summary is not a rewrite of the comment.
  const more = await panel.evaluate(() => [...document.querySelectorAll('.actions.secondary .action')].map((b) => b.textContent))
  check('Quick actions stay available under the result', more.includes('Summarize the thread'), JSON.stringify(more))
  await panel.click('.actions.secondary .action:has-text("Summarize the thread")')
  await panel.waitForFunction(() => document.querySelector('.result-request')?.textContent === 'Summarize the thread' && document.querySelector('.result .answer .md')?.textContent.trim().length > 40, null, { timeout: 180000 })
  const sumButtons = await panel.evaluate(() => [...document.querySelectorAll('.answer-actions .btn')].map((b) => b.textContent.trim()))
  const summary = await panel.evaluate(() => document.querySelector('.result .answer .md').textContent.trim())
  check('A summary offers Copy, never "Put in comment box"', !sumButtons.includes('Put in comment box') && sumButtons.includes('Copy') && !sumButtons.includes('Edit'), JSON.stringify(sumButtons))
  check('The summary covers the thread', /go/i.test(summary) && /rust/i.test(summary), summary.slice(0, 160))
  await panel.screenshot({ path: path.join(SHOTS, 'buddy-summary.png') })

  // History
  await panel.click('button[title="History"]')
  await panel.waitForSelector('.task-row')
  const rows = await panel.evaluate(() => document.querySelectorAll('.task-row').length)
  check('History lists all three tasks', rows >= 3, `${rows} rows`)
} finally {
  await close()
}
done()
