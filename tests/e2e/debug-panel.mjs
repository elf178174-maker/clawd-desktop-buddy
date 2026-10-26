import { launch, sleep } from './harness.mjs'
const { main, page, close } = await launch()
try {
  await sleep(3000)
  await main(() => globalThis.__clawd.summon())
  const panel = await page('panel')
  const logs = []
  panel.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
  panel.on('pageerror', (e) => logs.push(`pageerror: ${e.stack}`))
  await panel.waitForSelector('.composer textarea')
  await panel.fill('.composer textarea', 'What is 17 times 23? Reply with just the number.')
  await panel.keyboard.press('Enter')
  await sleep(8000)
  console.log('html msgs:', await panel.evaluate(() => [...document.querySelectorAll('.msg')].map((e) => e.className + ' :: ' + e.textContent.slice(0, 80))))
  console.log('notice:', await panel.evaluate(() => document.querySelector('.notice')?.textContent))
  console.log(logs.join('\n'))
} finally {
  await close()
}
