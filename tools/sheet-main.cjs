// Offscreen Electron renderer for contact sheets: loads a bundled page, waits for it to report
// "done" in document.title, and saves a PNG capture. Driven by tools/sheet.mjs.
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const [pageJs, outPng, w, h] = process.argv.slice(-4)
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: Number(w),
    height: Number(h),
    show: false,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  })
  win.webContents.setFrameRate(30)
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}</style><body><script src="${pathToFileURL(pageJs).href}"></script>`
  const tmp = path.join(path.dirname(pageJs), 'sheet.html')
  fs.writeFileSync(tmp, html)
  await win.loadFile(tmp)
  const t0 = Date.now()
  while (!win.webContents.getTitle().startsWith('done') && !win.webContents.getTitle().startsWith('error') && Date.now() - t0 < 30000) {
    await new Promise((r) => setTimeout(r, 100))
  }
  const title = win.webContents.getTitle()
  if (!title.startsWith('done')) {
    console.error('sheet failed:', title)
    app.exit(1)
    return
  }
  // Pages export their own canvas (window.__png) so sheets are not limited by the window size.
  const dataUrl = await win.webContents.executeJavaScript('window.__png || null')
  if (dataUrl) {
    fs.writeFileSync(outPng, Buffer.from(dataUrl.split(',')[1], 'base64'))
    console.log('wrote', outPng)
  } else {
    await new Promise((r) => setTimeout(r, 300))
    const img = await win.webContents.capturePage()
    fs.writeFileSync(outPng, img.toPNG())
    console.log('wrote', outPng, JSON.stringify(img.getSize()))
  }
  app.exit(0)
})
