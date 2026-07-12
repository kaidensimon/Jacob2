// Diagnose text clipping: is the hand-drawn font loaded when text is measured?
// Render text IMMEDIATELY on a fresh page, capture the width Excalidraw bakes
// in, then force the font to load and re-render the SAME text. If the widths
// differ, measurement-before-font-load is the root cause.
import { chromium } from 'playwright'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext()
await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])
const p = await ctx.newPage()
await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__ex?.api && !!window.__ex.renderRaw, null, { timeout: 30000 })

const TXT = [{ id: 't', type: 'text', x: 100, y: 100, text: 'What Is a Binary Tree', fontSize: 36 }]

// Render as fast as possible (font likely not yet loaded)
const immediate = await p.evaluate(async (sh) => {
  const fontsBefore = document.fonts ? document.fonts.check('36px Excalifont') : 'no-api'
  await window.__ex.renderRaw(sh)
  const el = window.__ex.api.getSceneElements().find((e) => e.id === 't')
  return { excalifontLoaded: fontsBefore, width: Math.round(el.width) }
}, TXT)
console.log('immediate render: Excalifont loaded =', immediate.excalifontLoaded, '| baked width =', immediate.width)

// Force the font to load, then re-render identical text
const afterLoad = await p.evaluate(async (sh) => {
  await document.fonts.load('36px Excalifont')
  await document.fonts.ready
  window.__ex.api.updateScene({ elements: [] })
  await window.__ex.renderRaw(sh)
  const el = window.__ex.api.getSceneElements().find((e) => e.id === 't')
  return { excalifontLoaded: document.fonts.check('36px Excalifont'), width: Math.round(el.width) }
}, TXT)
console.log('after font load:  Excalifont loaded =', afterLoad.excalifontLoaded, '| baked width =', afterLoad.width)

const delta = afterLoad.width - immediate.width
console.log(`\nwidth delta: ${delta}px  (${Math.round(100 * delta / immediate.width)}% wider once font loads)`)
console.log('ROOT CAUSE CONFIRMED (font-not-loaded-at-measure):', delta > 5)
await b.close()
