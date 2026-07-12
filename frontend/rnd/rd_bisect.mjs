// Bisect: why does renderRaw return 0 for the dumped plan?
import { chromium } from 'playwright'
import fs from 'fs'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const plan = JSON.parse(fs.readFileSync('rnd/out/section.plan.json', 'utf8'))
const shapes = plan.shapes.filter((s) => s.type !== 'math')

const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext()
await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])
const p = await ctx.newPage()
p.on('console', (m) => console.log(`PAGE[${m.type()}]:`, m.text().slice(0, 240)))
p.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 240)))
await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__ex?.renderRaw, null, { timeout: 30000 })

console.log('1 simple rect:', await p.evaluate(() => window.__ex.renderRaw([{ id: 'r1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 }])))
// cumulative bisect: add one shape at a time
for (let k = 1; k <= shapes.length; k++) {
  const n = await p.evaluate((sh) => window.__ex.renderRaw(sh), shapes.slice(0, k))
  console.log(`first ${k} shapes (${shapes[k - 1].type} ${shapes[k - 1].id}) -> rendered ${n}`)
  if (n === 0 && k > 0) break
}
await b.close()
