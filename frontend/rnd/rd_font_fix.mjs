// Prove the font-load gate fixes clipping on a COLD start. The Excalifont
// woff2 is delayed ~1.5s over the network to force the "font not loaded yet"
// condition, then:
//  1. an UNGATED measurement is shown to be too narrow (the bug)
//  2. the GATED renderRaw waits for the font and bakes the CORRECT width
import { chromium } from 'playwright'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext()
await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])

// Delay every font file so the hand-drawn face is guaranteed NOT loaded early.
await ctx.route(/\.woff2?(\?.*)?$/i, async (route) => {
  await new Promise((res) => setTimeout(res, 1500))
  await route.continue()
})

const p = await ctx.newPage()
await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__ex?.api && !!window.__ex.renderRaw, null, { timeout: 30000 })

const TXT = [{ id: 't', type: 'text', x: 100, y: 100, text: 'What Is a Binary Tree', fontSize: 36 }]
const CLIP_LABEL = [{ id: 'box', type: 'rectangle', x: 100, y: 250, width: 120, height: 70,
                     text: 'Binary tree rule: each node has at most two children' }]

// Font should NOT be loaded this early (request is being delayed).
const early = await p.evaluate(() => document.fonts.check('20px Excalifont'))
console.log('font loaded early (should be false):', early)

// UNGATED: import convert and measure without awaiting the gate — reproduces bug.
const ungated = await p.evaluate(async (sh) => {
  const m = await import('/src/excalidraw-agent/convert.ts')
  const map = new Map(sh.map((s) => [s.id, s]))
  const els = m.shapesToElements(map, new Map())
  return Math.round(els.find((e) => e.id === 't').width)
}, TXT)

// GATED: the production path (renderRaw awaits ensureCanvasFonts).
const gated = await p.evaluate((sh) => window.__ex.renderRaw(sh).then(() => {
  return Math.round(window.__ex.api.getSceneElements().find((e) => e.id === 't').width)
}), TXT)

console.log(`ungated (buggy) width: ${ungated}`)
console.log(`gated   (fixed) width: ${gated}`)
console.log('gate waited for font & fixed the width:', gated > ungated + 30)

// And the bound-label case: after the gate, the container must be wide enough
// that the label fits (label width <= container width).
const labelFits = await p.evaluate((sh) => window.__ex.renderRaw(sh).then(() => {
  const els = window.__ex.api.getSceneElements()
  const box = els.find((e) => e.id === 'box')
  const label = els.find((e) => e.type === 'text' && e.containerId === 'box')
  return label.width <= box.width + 2
}), CLIP_LABEL)
console.log('bound label fits its container after gate:', labelFits)
await b.close()
