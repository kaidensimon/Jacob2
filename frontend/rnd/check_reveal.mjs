import { chromium } from 'playwright'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()
const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] })
const ctx = await b.newContext({ viewport: { width: 1360, height: 850 } })
await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(String(e).slice(0, 160)))
await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__ex?.api, null, { timeout: 30000 })
await p.evaluate(() => window.__ex.teach('what a fraction is'))

// wait until lesson shapes exist
await p.waitForFunction(() => window.__ex.api.getSceneElements().length > 3, null, { timeout: 90000 })

// sample opacities fast for ~25s
let sawIntermediate = false
let staggered = false
const timeline = []
const t0 = Date.now()
for (let i = 0; i < 500; i++) {
  const ops = await p.evaluate(() =>
    window.__ex.api.getSceneElements().map((e) => e.opacity)
  )
  const mid = ops.filter((o) => o > 0 && o < 100).length
  const vis = ops.filter((o) => o === 100).length
  if (mid > 0) sawIntermediate = true
  timeline.push({ t: Date.now() - t0, vis, mid })
  await p.waitForTimeout(50)
  if (timeline.length > 3 && sawIntermediate && vis > 4) break
}
// staggered = the count of fully-visible shapes grew in more than 2 distinct steps
const steps = new Set(timeline.map((x) => x.vis))
staggered = steps.size >= 4

console.log('saw fade-in (intermediate opacities):', sawIntermediate)
console.log('visible-count grew in steps:', staggered, `(${[...steps].slice(0, 12).join(' -> ')})`)
console.log('page errors:', errs.length ? errs : 'none')
await b.close()
