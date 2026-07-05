// Lesson-path probe without audio: plan a section via the HTTP endpoint, render
// its shapes through the REAL converter, run the detector, export a PNG.
import { chromium } from 'playwright'
import fs from 'fs'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const TOPIC = process.argv[2] || 'how text embeddings work'
const TITLE = process.argv[3] || 'Meaning as Distance'
const GOAL = process.argv[4] || 'Show an embedding space with a pet/animal cluster, a vehicle cluster, and a far-away outlier, so the viewer understands near = similar meaning.'
const OUT = process.argv[5] || 'rnd/out/section'

const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()

console.log('planning section…')
const sec = await fetch(`${API}/lesson/section/`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
  body: JSON.stringify({ topic: TOPIC, section: { id: 's1', title: TITLE, goal: GOAL }, priorSections: [] }),
})
const plan = await sec.json()
const shapes = plan.shapes || []
console.log(`planned ${shapes.length} shapes, ${plan.beats?.length ?? 0} beats`)

const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1360, height: 850 } })
await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])
const p = await ctx.newPage()
p.on('console', (m) => { if (m.type() === 'error') console.log('PAGE:', m.text().slice(0, 300)) })
await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__ex?.api && !!window.__ex.renderRaw, null, { timeout: 30000 })
// math shapes need rasterization — skip them here (renderRaw has no math pipeline);
// their boxes are small and the detector treats them separately anyway.
const drawable = shapes.filter((s) => s.type !== 'math')
fs.writeFileSync(`${OUT}.plan.json`, JSON.stringify(plan, null, 1))
const rendered = await p.evaluate((sh) => window.__ex.renderRaw(sh), drawable)
console.log(`rendered ${rendered}/${drawable.length} drawable shapes`)
if (rendered === 0) {
  console.log('RENDER FAILED — conversion threw. Plan dumped to', `${OUT}.plan.json`)
}
await p.waitForTimeout(400)
const issues = await p.evaluate(async () => (await window.__ex.issues()).map((i) => i.desc))
console.log(`detector issues: ${issues.length}`)
for (const d of issues) console.log('  -', d)
const png = await p.evaluate(() => window.__ex.exportScene())
if (png) fs.writeFileSync(`${OUT}.png`, Buffer.from(png.split(',')[1], 'base64'))
console.log('png:', `${OUT}.png`)
await b.close()
