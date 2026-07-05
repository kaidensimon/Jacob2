// R&D probe: run one chat-agent drawing, dump z-order + detector issues + PNG.
import { chromium } from 'playwright'
import fs from 'fs'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const PROMPT = process.argv[2]
const OUT = process.argv[3] || 'rnd/out/case'
const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1360, height: 850 } })
await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])
const p = await ctx.newPage()
await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__ex?.api, null, { timeout: 30000 })
await p.evaluate(() => window.__ex.reset())
await p.evaluate((t) => { window.__ex.send(t) }, PROMPT)
await p.waitForTimeout(3000)
await p.waitForFunction(() => !window.__ex.isGenerating, null, { timeout: 240000 })
await p.waitForTimeout(800)

const dump = await p.evaluate(async () => {
  const els = window.__ex.api.getSceneElements().filter((e) => !e.isDeleted)
  const zorder = els.map((e, i) => ({
    z: i, id: e.id, type: e.type, x: Math.round(e.x), y: Math.round(e.y),
    w: Math.round(e.width), h: Math.round(e.height),
    bg: e.backgroundColor, text: e.text || undefined, containerId: e.containerId || undefined,
  }))
  const issues = await window.__ex.issues()
  return { zorder, issues: issues.map((i) => i.desc) }
})
fs.writeFileSync(`${OUT}.json`, JSON.stringify(dump, null, 1))
const png = await p.evaluate(() => window.__ex.exportScene())
if (png) fs.writeFileSync(`${OUT}.png`, Buffer.from(png.split(',')[1], 'base64'))
console.log(`elements: ${dump.zorder.length}, detector issues: ${dump.issues.length}`)
for (const d of dump.issues) console.log('  -', d)
await b.close()
