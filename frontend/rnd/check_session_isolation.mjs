// Two accounts, one browser: A draws (autosave), B must open a BLANK board,
// A must still get their own board back.
import { chromium } from 'playwright'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'

async function makeUser(tag) {
  const email = `iso_${tag}_${Date.now()}@test.com`
  await fetch(`${API}/auth/register/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'testpass12345', full_name: `Iso ${tag}` }) })
  const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'testpass12345' }) })
  return await r.json()
}

const A = await makeUser('a')
const B = await makeUser('b')
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext()
const p = await ctx.newPage()

const loginAs = async (tokens) => {
  await p.goto(`${APP}/signin`, { waitUntil: 'domcontentloaded' })
  await p.evaluate(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [tokens.access, tokens.refresh])
  await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => !!window.__ex?.api, null, { timeout: 30000 })
}

// A draws something → autosave fires
await loginAs(A)
await p.evaluate(() => window.__ex.renderRaw([{ id: 'secretA', type: 'rectangle', x: 100, y: 100, width: 200, height: 100, text: 'user A private stuff' }]))
await p.waitForTimeout(1200) // > autosave debounce
const aCount = await p.evaluate(() => window.__ex.api.getSceneElements().length)
console.log('A drew elements:', aCount > 0)

// B logs in on the same browser → must see an EMPTY board
await loginAs(B)
const bScene = await p.evaluate(() => window.__ex.api.getSceneElements().map((e) => e.id))
console.log('B sees a blank board:', bScene.length === 0, bScene.length ? `LEAKED: ${bScene}` : '')

// back to A → their board must still be there
await loginAs(A)
const aBack = await p.evaluate(() => window.__ex.api.getSceneElements().some((e) => e.id === 'secretA'))
console.log("A's own board restored:", aBack)
await b.close()
