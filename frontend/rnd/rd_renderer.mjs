// Deterministic renderer test: feed the converter a WORST-CASE shape order
// containing every reported failure class, then verify the safeguards.
import { chromium } from 'playwright'
import fs from 'fs'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const OUT = process.argv[2] || 'rnd/out/renderer'

// Failure bait, in the worst possible emission order:
const SHAPES = [
  // contents FIRST, giant filled cluster LAST (old z-order: cluster covers them)
  { id: 'cat', type: 'ellipse', x: 120, y: 220, width: 90, height: 54, text: 'cat', backgroundColor: '#a5d8ff' },
  { id: 'dog', type: 'ellipse', x: 240, y: 240, width: 90, height: 54, text: 'dog', backgroundColor: '#a5d8ff' },
  { id: 'kitten', type: 'ellipse', x: 175, y: 310, width: 100, height: 54, text: 'kitten', backgroundColor: '#a5d8ff' },
  { id: 'cluster', type: 'ellipse', x: 70, y: 160, width: 320, height: 250, text: 'pet cluster', backgroundColor: '#d0ebff' },
  // giant labeled region (old behavior: label centered onto contents)
  { id: 'space', type: 'rectangle', x: 30, y: 90, width: 820, height: 470, text: 'embedding space' },
  // standalone text CROSSING a box border (clips)
  { id: 'box1', type: 'rectangle', x: 560, y: 200, width: 170, height: 80, backgroundColor: '#ffec99' },
  { id: 'clip', type: 'text', x: 650, y: 228, text: 'this text spills out of the box', fontSize: 16 },
  // a shape sitting on top of a free label (banana case)
  { id: 'note', type: 'text', x: 590, y: 430, text: 'far = less related', fontSize: 16 },
  { id: 'banana', type: 'ellipse', x: 640, y: 415, width: 120, height: 60, text: 'banana', backgroundColor: '#ffe066' },
  // arrow bound between shapes (must still bind after re-ordering)
  { id: 'a1', type: 'arrow', fromId: 'cat', toId: 'dog' },
]

const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1360, height: 850 } })
await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])
const p = await ctx.newPage()
await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__ex?.api && !!window.__ex.renderRaw, null, { timeout: 30000 })
const n = await p.evaluate((shapes) => window.__ex.renderRaw(shapes), SHAPES)
await p.waitForTimeout(400)

const res = await p.evaluate(async () => {
  const els = window.__ex.api.getSceneElements().filter((e) => !e.isDeleted)
  const zi = (id) => els.findIndex((e) => e.id === id)
  const el = (id) => els.find((e) => e.id === id)
  const spaceLabel = els.find((e) => e.type === 'text' && e.containerId === 'space')
  const space = el('space')
  const issues = await window.__ex.issues()
  return {
    zOrderFixed: zi('space') < zi('cluster') && zi('cluster') < zi('cat') && zi('cluster') < zi('kitten'),
    arrowBound: !!(el('a1')?.startBinding && el('a1')?.endBinding),
    regionLabelAtTop: spaceLabel && space ? spaceLabel.y - space.y < space.height * 0.25 : false,
    issueDescs: issues.map((i) => i.desc),
  }
})
console.log('elements rendered:', n)
console.log('z-order (region < cluster < contents):', res.zOrderFixed)
console.log('arrow still bound after re-order:', res.arrowBound)
console.log('big-region label rendered as top header:', res.regionLabelAtTop)
const wantClip = res.issueDescs.some((d) => d.includes('spills out') && d.includes('crosses the border'))
const wantBanana = res.issueDescs.some((d) => d.includes('far = less related') && d.includes('crosses the border'))
console.log('detector flags text-out-of-box:', wantClip)
console.log('detector flags shape-over-label:', wantBanana)
console.log('all issues:')
for (const d of res.issueDescs) console.log('  -', d)
const png = await p.evaluate(() => window.__ex.exportScene())
if (png) fs.writeFileSync(`${OUT}.png`, Buffer.from(png.split(',')[1], 'base64'))
await b.close()
