// Sibling-overlap detector class: partial box-box overlap flagged;
// Venn ellipses and clean containment must NOT be flagged.
import { chromium } from 'playwright'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const SHAPES = [
  // partial overlap between two rectangles → FLAG
  { id: 'boxA', type: 'rectangle', x: 100, y: 100, width: 160, height: 80, text: 'step 1' },
  { id: 'boxB', type: 'rectangle', x: 200, y: 140, width: 160, height: 80, text: 'step 2' },
  // Venn: two ellipses deliberately overlapping → NO flag
  { id: 'vennA', type: 'ellipse', x: 450, y: 100, width: 200, height: 140, text: '' },
  { id: 'vennB', type: 'ellipse', x: 560, y: 100, width: 200, height: 140, text: '' },
  // containment: small fully inside big → NO flag
  { id: 'region', type: 'rectangle', x: 100, y: 330, width: 300, height: 200 },
  { id: 'inner', type: 'rectangle', x: 160, y: 400, width: 120, height: 60, text: 'inside' },
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
await p.evaluate((sh) => window.__ex.renderRaw(sh), SHAPES)
await p.waitForTimeout(300)
const issues = await p.evaluate(async () => (await window.__ex.issues()).map((i) => i.desc))
const flags = issues.filter((d) => d.includes('partially overlap'))
console.log('box-box partial overlap flagged:', flags.some((d) => d.includes('boxA') && d.includes('boxB')))
console.log('venn ellipses NOT flagged:', !flags.some((d) => d.includes('vennA')))
console.log('containment NOT flagged:', !flags.some((d) => d.includes('region') || d.includes('inner')))
console.log('all partial-overlap flags:', flags.length ? flags : '(none)')
await b.close()
