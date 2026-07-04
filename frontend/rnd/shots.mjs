import { chromium } from 'playwright'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const OUT = process.argv[2] || '.'
const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1360, height: 850 } })
const p = await ctx.newPage()

await p.goto(`${APP}/signin`, { waitUntil: 'networkidle' })
await p.screenshot({ path: `${OUT}/signin.png` })

await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])
const p2 = await ctx.newPage()
await p2.goto(`${APP}/dashboard`, { waitUntil: 'networkidle' })
await p2.screenshot({ path: `${OUT}/dashboard.png` })

await p2.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p2.waitForFunction(() => !!window.__ex?.api, null, { timeout: 30000 })
await p2.waitForTimeout(1500)
await p2.screenshot({ path: `${OUT}/whiteboard.png` })
await b.close()
console.log('shots saved')
