// R&D harness: drives the whiteboard agent through Playwright, exports each
// finished scene to PNG, runs the real overlap detector, and dumps the chat
// reasoning trace. Usage: node rnd/harness.mjs <label> "<prompt>"
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, 'out')
mkdirSync(OUT, { recursive: true })

const APP = 'http://localhost:5173'
const API = 'http://localhost:8000/api'
const CREDS = { email: 'rnd@test.com', password: 'testpass12345' }

const PER_PROMPT_TIMEOUT_MS = 9 * 60 * 1000

async function login() {
  const res = await fetch(`${API}/auth/login/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(CREDS),
  })
  if (!res.ok) throw new Error(`login failed ${res.status}`)
  return res.json()
}

async function waitForBridge(page) {
  await page.waitForFunction(() => (window).__ex && (window).__ex.api, null, { timeout: 30000 })
}

async function runPrompt(page, label, prompt) {
  const t0 = Date.now()
  console.log(`\n=== [${label}] "${prompt}" ===`)
  await page.evaluate(() => (window).__ex.reset())
  await page.waitForTimeout(700)

  // Fire the send (don't await inside evaluate — poll isGenerating instead so a
  // hang can't wedge the harness).
  await page.evaluate((p) => { (window).__ex.send(p) }, prompt)

  // Wait for generation to start, then to finish (stay false for a few polls).
  let started = false
  let falseStreak = 0
  while (Date.now() - t0 < PER_PROMPT_TIMEOUT_MS) {
    await page.waitForTimeout(1500)
    const gen = await page.evaluate(() => !!(window).__ex.isGenerating)
    if (gen) { started = true; falseStreak = 0 }
    else { falseStreak++ }
    if (started && falseStreak >= 4) break // ~6s idle => done (incl. review passes)
    if (!started && (Date.now() - t0) > 45000) break // never started (routing/other)
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0)

  const [dataUrl, issues, chat] = await page.evaluate(async () => {
    const ex = (window).__ex
    return [await ex.exportScene(), await ex.issues(), ex.chat]
  })

  if (dataUrl) {
    const b64 = dataUrl.split(',')[1]
    writeFileSync(join(OUT, `${label}.png`), Buffer.from(b64, 'base64'))
  }
  writeFileSync(join(OUT, `${label}.json`), JSON.stringify({ label, prompt, elapsed, issues, chat }, null, 2))

  const kinds = {}
  for (const c of chat || []) kinds[c.kind] = (kinds[c.kind] || 0) + 1
  console.log(`  done in ${elapsed}s | chat items:`, JSON.stringify(kinds))
  console.log(`  residual issues (${(issues || []).length}):`)
  for (const i of (issues || []).slice(0, 12)) console.log('   -', i.desc)
  const thinks = (chat || []).filter((c) => c.kind === 'think').map((c) => c.text)
  console.log(`  think trace (${thinks.length}):`)
  for (const t of thinks) console.log('     •', t.slice(0, 160))
  const msg = (chat || []).filter((c) => c.kind === 'message').slice(-1)[0]
  if (msg) console.log('  final message:', msg.text.slice(0, 240))
  return { label, elapsed, issues: (issues || []).length }
}

async function main() {
  const args = process.argv.slice(2)
  // Pairs of (label, prompt) from argv, else a default battery.
  let battery
  if (args.length >= 2) {
    battery = [[args[0], args.slice(1).join(' ')]]
  } else {
    battery = [
      ['02_org_chart', 'Draw an org chart: a CEO at top, with a CTO and CFO reporting to the CEO, and each of the CTO and CFO having two team members reporting to them. Use boxes and connecting lines.'],
      ['03_neural_net', 'Draw a neural network diagram: an input layer with 3 nodes, two hidden layers with 4 nodes each, and an output layer with 2 nodes. Draw each node as a circle and connect every node in a layer to every node in the next layer.'],
      ['04_water_cycle', 'Draw a clear labeled diagram of the water cycle: evaporation from the ocean, condensation into clouds, precipitation as rain, and runoff back to the ocean, arranged as a cycle with labeled arrows.'],
      ['05_web_arch', 'Draw a system architecture diagram of a web application: a client/browser, a load balancer, three application servers, a database, and a Redis cache. Connect them with labeled arrows showing the request flow.'],
    ]
  }

  const { access, refresh } = await login()
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(([a, r]) => {
    localStorage.setItem('access_token', a)
    localStorage.setItem('refresh_token', r)
  }, [access, refresh])
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)))
  await page.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
  await waitForBridge(page)
  console.log('bridge ready')

  const summary = []
  for (const [label, prompt] of battery) {
    try {
      summary.push(await runPrompt(page, label, prompt))
    } catch (e) {
      console.log(`  [${label}] ERROR`, String(e).slice(0, 300))
      summary.push({ label, error: String(e).slice(0, 200) })
    }
  }
  console.log('\n===== SUMMARY =====')
  for (const s of summary) console.log(JSON.stringify(s))
  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
