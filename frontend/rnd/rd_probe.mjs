import { chromium } from 'playwright'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext()
await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])
const p = await ctx.newPage()
await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__ex?.renderRaw, null, { timeout: 30000 })
const out = await p.evaluate(async () => {
  const log = []
  try {
    const mod = await import('/src/excalidraw-agent/convert.ts')
    log.push('module keys: ' + Object.keys(mod).join(','))
    const map = new Map([['r1', { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 }]])
    const skels = mod.buildSkeletons(map, new Map())
    log.push('skeletons: ' + JSON.stringify(skels))
    const els = mod.shapesToElements(map, new Map())
    log.push('elements: ' + els.length)
    if (els.length) log.push('el0: ' + JSON.stringify({ id: els[0].id, type: els[0].type }))
  } catch (e) {
    log.push('THREW: ' + (e && e.stack ? e.stack.slice(0, 400) : String(e)))
  }
  return log
})
for (const l of out) console.log(l)
await b.close()
