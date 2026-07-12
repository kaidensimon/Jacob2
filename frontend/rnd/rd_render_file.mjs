// Render a shapes JSON file through the real converter; write issues + PNG.
import { chromium } from 'playwright'
import fs from 'fs'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const FILE = process.argv[2]
const OUT = process.argv[3] || 'rnd/out/render'
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const shapes = (data.shapes || data).filter((s) => s.type !== 'math')

const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext()
await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])
const p = await ctx.newPage()
await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__ex?.api && !!window.__ex.renderRaw, null, { timeout: 30000 })
const n = await p.evaluate((sh) => window.__ex.renderRaw(sh), shapes)
await p.waitForTimeout(400)
const issues = await p.evaluate(async () => (await window.__ex.issues()).map((i) => i.desc))
console.log(`rendered ${n} elements, issues: ${issues.length}`)
for (const d of issues) console.log('  -', d)
fs.writeFileSync(`${OUT}.issues.json`, JSON.stringify(issues, null, 1))
const png = await p.evaluate(() => window.__ex.exportScene())
if (png) fs.writeFileSync(`${OUT}.png`, Buffer.from(png.split(',')[1], 'base64'))
await b.close()
