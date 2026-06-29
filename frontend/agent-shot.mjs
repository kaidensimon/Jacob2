// Headless screenshot harness for the Excalidraw AI agent.
//   node agent-shot.mjs "your prompt" [out.png]
// Logs in, opens the whiteboard, runs the prompt, waits for the agent to finish,
// zooms to fit, and saves a PNG of the rendered canvas + prints the final message.
import { chromium } from 'playwright'

const PROMPT = process.argv[2] || 'visualize stokes theorem in 3d'
const OUT = process.argv[3] || 'agent-output.png'
const EMAIL = 'test@example.com'
const PASSWORD = 'testpass123'
const BASE = 'http://localhost:5173'

const log = (...a) => console.log('[shot]', ...a)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('console', (m) => {
  const t = m.text()
  if (/error|exception/i.test(t)) console.log('  [browser]', t)
})

try {
  // 1. Sign in
  log('signing in…')
  await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' })
  await page.fill('#email', EMAIL)
  await page.fill('#password', PASSWORD)
  await page.click('button[type=submit]')

  // 2. Dashboard → Start New Session
  await page.waitForURL('**/dashboard', { timeout: 15000 })
  log('on dashboard, starting session…')
  await page.click('text=Start New Session')

  // 3. Whiteboard chat input
  await page.waitForSelector('.ex-chat-input textarea', { timeout: 20000 })
  await page.waitForTimeout(1500) // let Excalidraw mount + API attach
  log(`prompting: "${PROMPT}"`)
  await page.fill('.ex-chat-input textarea', PROMPT)
  await page.click('.ex-chat-send')

  // 4. Wait for the orchestrator/agent to respond.
  await page.waitForSelector('.ex-chat-stop', { timeout: 25000 })
  log('working…')
  let started = Date.now()
  await page.waitForSelector('.ex-chat-stop', { state: 'detached', timeout: 300000 })
  log(`first response in ${Math.round((Date.now() - started) / 1000)}s`)

  // If the orchestrator asked whiteboard-vs-video, answer "whiteboard".
  const lastMsg = (await page.locator('.ex-row-message').allInnerTexts()).pop() || ''
  if (/whiteboard/i.test(lastMsg) && /video|anim/i.test(lastMsg)) {
    log('orchestrator asked medium → answering "whiteboard"')
    await page.fill('.ex-chat-input textarea', 'whiteboard')
    await page.click('.ex-chat-send')
    await page.waitForSelector('.ex-chat-stop', { timeout: 25000 })
    started = Date.now()
    await page.waitForSelector('.ex-chat-stop', { state: 'detached', timeout: 300000 })
    log(`agent drew in ${Math.round((Date.now() - started) / 1000)}s`)
  }

  // 5. Deselect everything (so the properties panel closes), zoom to fit, shoot.
  await page.waitForTimeout(1200)
  await page.keyboard.press('Escape')
  // click an empty corner to focus the canvas, then clear any selection
  await page.locator('.ex-canvas').click({ position: { x: 30, y: 30 } })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+1') // Excalidraw: zoom to fit
  await page.waitForTimeout(1500)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.locator('.ex-canvas').screenshot({ path: OUT })
  log(`saved screenshot → ${OUT}`)

  // 6. Print the agent's final explanatory message
  const msgs = await page.locator('.ex-row-message').allInnerTexts()
  log('final message:', msgs.length ? msgs[msgs.length - 1] : '(none)')
  const errs = await page.locator('.ex-row-error').allInnerTexts()
  if (errs.length) log('ERRORS in chat:', errs.join(' | '))
} catch (err) {
  console.error('[shot] FAILED:', err.message)
  await page.screenshot({ path: 'agent-shot-failure.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
