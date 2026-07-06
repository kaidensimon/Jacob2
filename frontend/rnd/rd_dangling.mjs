// A board with a defect NO deterministic class covers: an arrow pointing into
// empty space. Detector must say 0; render the PNG for the vision critic.
import { chromium } from 'playwright'
import fs from 'fs'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const OUT = process.argv[2] || 'rnd/out/dangling'
const SHAPES = [
  { id: 'a', type: 'rectangle', x: 100, y: 150, width: 180, height: 80, text: 'Input data' },
  { id: 'b', type: 'rectangle', x: 420, y: 150, width: 180, height: 80, text: 'Model' },
  { id: 'ab', type: 'arrow', fromId: 'a', toId: 'b' },
  // dangling arrow into nothing — visually "unfinished"
  { id: 'oops', type: 'arrow', x: 620, y: 190, width: 220, height: 130 },
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
console.log('deterministic detector issues:', issues.length)
const png = await p.evaluate(() => window.__ex.exportScene())
fs.writeFileSync(`${OUT}.png`, Buffer.from(png.split(',')[1], 'base64'))
console.log('png written')
await b.close()
