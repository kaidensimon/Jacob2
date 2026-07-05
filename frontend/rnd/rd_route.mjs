// Reproduce the "arrow stabs through a token row" blip and verify elbow routing.
import { chromium } from 'playwright'
import fs from 'fs'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const OUT = process.argv[2] || 'rnd/out/route'
const SHAPES = [
  { id: 'row', type: 'rectangle', x: 20, y: 240, width: 700, height: 180, text: 'A transformer treats a sentence as tokens' },
  { id: 't1', type: 'rectangle', x: 60, y: 330, width: 90, height: 50, text: 'The' },
  { id: 't2', type: 'rectangle', x: 175, y: 330, width: 90, height: 50, text: 'boat' },
  { id: 't3', type: 'rectangle', x: 290, y: 330, width: 110, height: 50, text: 'reached' },
  { id: 't4', type: 'rectangle', x: 425, y: 330, width: 90, height: 50, text: 'the' },
  { id: 't5', type: 'rectangle', x: 540, y: 330, width: 90, height: 50, text: 'bank' },
  { id: 'attn', type: 'arrow', fromId: 't2', toId: 't5', text: '' },
  { id: 'near', type: 'arrow', fromId: 't1', toId: 't2' }, // adjacent: should stay straight
  // RAW-GEOMETRY arrow (no fromId/toId) that would strike through the whole row
  { id: 'rawpierce', type: 'arrow', x: 40, y: 355, width: 640, height: 0 },
  // a plain line must NOT be rerouted (axes cross things on purpose)
  { id: 'axis', type: 'line', x: 30, y: 250, width: 680, height: 0 },
]
const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext()
await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])
const p = await ctx.newPage()
await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__ex?.api && !!window.__ex.renderRaw, null, { timeout: 30000 })
const n = await p.evaluate((sh) => window.__ex.renderRaw(sh), SHAPES)
await p.waitForTimeout(400)
const res = await p.evaluate(async () => {
  const els = window.__ex.api.getSceneElements()
  const pts = (id) => els.find((e) => e.id === id)?.points?.length
  const issues = (await window.__ex.issues()).map((i) => i.desc)
  return { attnPts: pts('attn'), nearPts: pts('near'), rawPts: pts('rawpierce'), axisPts: pts('axis'), issues }
})
console.log('rendered:', n)
console.log('long-range bound arrow points (expect 4 = elbow):', res.attnPts)
console.log('adjacent arrow points (expect 2 = straight):', res.nearPts)
console.log('RAW unbound piercer points (expect 4 = elbow):', res.rawPts)
console.log('plain line points (expect 2 = untouched):', res.axisPts)
console.log('passes-through issues:', res.issues.filter((d) => d.includes('passes through')).length)
console.log('all issues:', res.issues.length ? res.issues : '(none)')
const png = await p.evaluate(() => window.__ex.exportScene())
if (png) fs.writeFileSync(`${OUT}.png`, Buffer.from(png.split(',')[1], 'base64'))
await b.close()
