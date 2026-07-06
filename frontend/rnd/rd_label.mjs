// Bound-label root-cause checks:
// A) diamond with the exact screenshot label must render ONE line, no spill
// B) a bound label overlapped by a foreign box must be FLAGGED (new class)
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
await p.waitForFunction(() => !!window.__ex?.api && !!window.__ex.renderRaw, null, { timeout: 30000 })

// A: the screenshot's diamond, planned too small on purpose
await p.evaluate((sh) => window.__ex.renderRaw(sh), [
  { id: 'market', type: 'diamond', x: 300, y: 200, width: 220, height: 90, text: 'Dating + marriage market' },
  { id: 'result', type: 'rectangle', x: 1400, y: 200, width: 220, height: 120, text: 'Pairing patterns' },
])
await p.waitForTimeout(250)
const a = await p.evaluate(async () => {
  const els = window.__ex.api.getSceneElements()
  const d = els.find((e) => e.id === 'market')
  const label = els.find((e) => e.type === 'text' && e.containerId === 'market')
  return {
    dw: Math.round(d.width),
    oneLine: !(label.text || '').includes('\n'),
    labelInside: label.x >= d.x && label.x + label.width <= d.x + d.width,
    issues: (await window.__ex.issues()).map((i) => i.desc),
  }
})
console.log('A: diamond widened to', a.dw, '| label one line:', a.oneLine, '| label inside container:', a.labelInside)
console.log('A: issues:', a.issues.length ? a.issues : '(none)')

// B: a foreign box parked on top of a region's top-aligned label. The board
// contains a region (nested box) so the overlap-relief pass is skipped and
// the DETECTION class must catch the spill instead.
await p.evaluate((sh) => window.__ex.renderRaw(sh), [
  { id: 'region', type: 'rectangle', x: 100, y: 100, width: 460, height: 240, text: 'The whole system pipeline' },
  { id: 'member', type: 'rectangle', x: 140, y: 220, width: 120, height: 60, text: 'stage' },
  { id: 'intruder', type: 'rectangle', x: 240, y: 90, width: 140, height: 60, backgroundColor: '#ffec99' },
])
await p.waitForTimeout(250)
const bIssues = await p.evaluate(async () => (await window.__ex.issues()).map((i) => i.desc))
console.log('B: spill flag fired:', bIssues.some((d) => d.includes('spills onto')))
console.log('B: issues:', bIssues)
await b.close()
