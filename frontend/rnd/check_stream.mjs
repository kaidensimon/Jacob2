import { chromium } from 'playwright'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
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
await p.evaluate(() => { window.__ex.send('draw a simple 4-box flowchart about baking bread') })

// sample canvas element count while generating
const counts = []
for (let i = 0; i < 400; i++) {
  const n = await p.evaluate(() => window.__ex.api.getSceneElements().filter((e) => !e.isDeleted).length)
  const busy = await p.evaluate(() => window.__ex.isGenerating)
  if (counts.length === 0 || counts[counts.length - 1] !== n) counts.push(n)
  if (!busy && n > 0 && i > 10) break
  await p.waitForTimeout(150)
}
console.log('element count over time:', counts.join(' -> '))
console.log('incremental drawing:', counts.length >= 4)
await b.close()
