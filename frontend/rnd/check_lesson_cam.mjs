import { chromium } from 'playwright'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()
const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] })
const ctx = await b.newContext({ viewport: { width: 1360, height: 850 } })
await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])
const p = await ctx.newPage()
await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__ex?.api, null, { timeout: 30000 })
await p.evaluate(() => window.__ex.reset())

// 1. chat draw -> creates "Jacob's view" widget
await p.evaluate(() => { window.__ex.send('draw two boxes labeled A and B connected by an arrow') })
await p.waitForFunction(() => !window.__ex.isGenerating && window.__ex.api.getSceneElements().length > 0, null, { timeout: 120000 })
const widgetBefore = await p.locator('button:has-text("view")').count()
console.log('widget visible before lesson:', widgetBefore > 0)

// scroll the camera far away so the zoom-to-lesson move is provable
await p.evaluate(() => window.__ex.api.updateScene({ appState: { scrollX: 99999, scrollY: 99999 } }))

// 2. start a lesson
await p.evaluate(() => window.__ex.teach('what a fraction is'))
await p.waitForFunction(
  () => window.__ex.api.getSceneElements().some((e) => e.opacity === 0 || e.opacity < 100),
  null, { timeout: 120000 }
)
await p.waitForTimeout(1200) // let the camera animation land

const camOk = await p.evaluate(() => {
  const a = window.__ex.api.getAppState()
  const zoom = a.zoom?.value ?? 1
  const view = { x: -a.scrollX, y: -a.scrollY, w: a.width / zoom, h: a.height / zoom }
  const lessonEls = window.__ex.api.getSceneElements()
  // lesson shapes live near origin; check that at least one is inside the viewport
  return lessonEls.some((e) =>
    e.x < view.x + view.w && e.x + e.width > view.x && e.y < view.y + view.h && e.y + e.height > view.y
  )
})
console.log('camera moved onto the lesson board:', camOk)

const widgetDuring = await p.locator('button:has-text("view")').count()
console.log("'Jacob's view' hidden during lesson:", widgetDuring === 0)
await b.close()
