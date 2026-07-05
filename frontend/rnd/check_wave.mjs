// Enable voice tutor with a FAKE mic device and verify the waveform canvas
// is present and actually animating (pixel content changes over time).
import { chromium } from 'playwright'
import fs from 'fs'
const API = 'http://localhost:8000/api', APP = 'http://localhost:5173'
const OUT = process.argv[2] || 'rnd/out/wave'
const r = await fetch(`${API}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rnd@test.com', password: 'testpass12345' }) })
const { access, refresh } = await r.json()
const b = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
})
const ctx = await b.newContext({ viewport: { width: 1360, height: 850 }, permissions: ['microphone'] })
await ctx.addInitScript(([a, rf]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', rf) }, [access, refresh])
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))
await p.goto(`${APP}/whiteboard`, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.__ex?.api, null, { timeout: 30000 })
await p.click('button:has-text("Voice tutor")')
await p.waitForSelector('canvas.ex-voice-wave', { timeout: 15000 })
console.log('waveform canvas mounted: true')

const snap = () => p.evaluate(() => document.querySelector('canvas.ex-voice-wave').toDataURL())
const s1 = await snap()
await p.waitForTimeout(600)
const s2 = await snap()
await p.waitForTimeout(600)
const s3 = await snap()
console.log('waveform animating (frames differ):', s1 !== s2 || s2 !== s3)
const strip = await p.locator('.ex-voice-strip')
fs.writeFileSync(`${OUT}.png`, await strip.screenshot())
console.log('"Listening" text gone:', (await p.locator('.ex-voice-strip:has-text("Listening")').count()) === 0)
console.log('page errors:', errs.length ? errs : 'none')
await b.close()
