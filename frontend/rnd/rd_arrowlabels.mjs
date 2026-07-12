// Arrow-label placement engine test — both screenshot scenarios:
// A) 4 labeled arrows converging on one box (labels used to pile up)
// B) a label whose arrow midpoint lands inside a box (used to get sliced)
import { chromium } from 'playwright'
import fs from 'fs'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const OUT = process.argv[2] || 'rnd/out/arrowlabels'
const SHAPES = [
  // A: fan-in
  { id: 'profile', type: 'rectangle', x: 60, y: 220, width: 200, height: 120, text: 'Dating profile' },
  { id: 's1', type: 'rectangle', x: 560, y: 80, width: 170, height: 60, text: 'Income / career' },
  { id: 's2', type: 'rectangle', x: 560, y: 200, width: 170, height: 60, text: 'Attractiveness' },
  { id: 's3', type: 'rectangle', x: 560, y: 320, width: 170, height: 60, text: 'Lifestyle' },
  { id: 's4', type: 'rectangle', x: 560, y: 440, width: 170, height: 60, text: 'Ambition' },
  { id: 'a1', type: 'arrow', fromId: 's1', toId: 'profile', text: 'job title' },
  { id: 'a2', type: 'arrow', fromId: 's2', toId: 'profile', text: 'photos' },
  { id: 'a3', type: 'arrow', fromId: 's3', toId: 'profile', text: 'travel / hobbies' },
  { id: 'a4', type: 'arrow', fromId: 's4', toId: 'profile', text: 'drive' },
  // B: vertical arrow whose midpoint is inside a box parked on its path…
  { id: 'top', type: 'rectangle', x: 900, y: 80, width: 190, height: 70, text: 'Not a universal law' },
  { id: 'bottom', type: 'rectangle', x: 900, y: 500, width: 190, height: 70, text: 'The takeaway' },
  { id: 'blocker', type: 'rectangle', x: 890, y: 270, width: 210, height: 90, text: 'Not a trait of one gender' },
  { id: 'vb', type: 'arrow', fromId: 'top', toId: 'bottom', text: 'Nuance lives in the middle' },
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
await p.evaluate((sh) => window.__ex.renderRaw(sh), SHAPES)
await p.waitForTimeout(300)
const res = await p.evaluate(async () => {
  const els = window.__ex.api.getSceneElements()
  const labels = els.filter((e) => e.type === 'text' && (e.containerId || e.customData?.labelOf))
  const arrowLabelTexts = ['job title', 'photos', 'travel / hobbies', 'drive', 'Nuance lives in the middle']
  const present = arrowLabelTexts.filter((t) => els.some((e) => e.type === 'text' && (e.text || '').includes(t.slice(0, 8))))
  const relocated = els.filter((e) => e.customData?.labelOf).length
  const issues = (await window.__ex.issues()).map((i) => i.desc)
  return { total: labels.length, present: present.length, relocated, issues }
})
console.log(`all 5 arrow labels visible: ${res.present === 5} | relocated to clear space: ${res.relocated}`)
const bad = res.issues.filter((d) => d.includes('overlaps') || d.includes('crosses') || d.includes('spills') || d.includes('sitting on top'))
console.log('label-collision issues:', bad.length === 0 ? 'NONE' : bad)
console.log('all issues:', res.issues.length ? res.issues : '(none)')
const png = await p.evaluate(() => window.__ex.exportScene())
if (png) fs.writeFileSync(`${OUT}.png`, Buffer.from(png.split(',')[1], 'base64'))
await b.close()
