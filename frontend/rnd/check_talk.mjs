import { chromium } from 'playwright'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const OUT = process.argv[2] || '.'
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

await p.waitForSelector('.jacob-talking img', { timeout: 60000 })
console.log('talking sprite mounted: true')

// sample the frame src while the first beats play
const seen = new Set()
let shot = false
for (let i = 0; i < 120; i++) {
  const src = await p.evaluate(() => document.querySelector('.jacob-talking img')?.getAttribute('src'))
  if (src) seen.add(src)
  if (!shot && src && src.includes('jacob-talk')) {
    await p.screenshot({ path: `${OUT}/talking.png` })
    shot = true
  }
  await p.waitForTimeout(250)
  if (seen.size >= 5 && shot) break
}
console.log('distinct frames seen:', [...seen].sort().join(', '))
console.log('mouth animated:', [...seen].filter(s => s.includes('jacob-talk')).length >= 3)
console.log('page errors:', errs.length ? errs : 'none')
await b.close()
