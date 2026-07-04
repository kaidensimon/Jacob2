import { chromium } from 'playwright'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const OUT = process.argv[2] || '.'
const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1360, height: 850 } })
await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(String(e).slice(0, 160)))
await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__ex?.api, null, { timeout: 30000 })
await p.evaluate(() => window.__ex.reset())
await p.evaluate(() => { window.__ex.send('draw a simple 3-box flowchart about making coffee') })

// wait for the sprite to appear (agentView set + generating)
try {
  await p.waitForSelector('.jacob-sprite', { timeout: 30000 })
  console.log('sprite appeared: true')
  await p.waitForTimeout(1200) // let the walk-in finish, mid-scribble
  await p.screenshot({ path: `${OUT}/sprite_drawing.png` })
} catch {
  console.log('sprite appeared: FALSE')
}

// wait for generation to end -> sprite should walk off and unmount
await p.waitForFunction(() => !window.__ex.isGenerating, null, { timeout: 120000 })
await p.waitForTimeout(900)
const gone = await p.locator('.jacob-sprite').count()
console.log('sprite gone after generation:', gone === 0)
await p.screenshot({ path: `${OUT}/sprite_done.png` })
console.log('page errors:', errs.length ? errs : 'none')
await b.close()
