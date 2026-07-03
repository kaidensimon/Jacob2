import { chromium } from 'playwright'
const API='http://localhost:8000/api', APP='http://localhost:5173'
const r=await fetch(`${API}/auth/login/`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'rnd@test.com',password:'testpass12345'})})
const {access,refresh}=await r.json()
const b=await chromium.launch({headless:true})
const ctx=await b.newContext()
await ctx.addInitScript(([a,rf])=>{localStorage.setItem('access_token',a);localStorage.setItem('refresh_token',rf)},[access,refresh])
const p=await ctx.newPage(); const errs=[]
p.on('pageerror',e=>errs.push(String(e).slice(0,160)))
await p.goto(`${APP}/whiteboard`,{waitUntil:'domcontentloaded'})
await p.waitForFunction(()=>!!window.__ex?.api,null,{timeout:30000})
const toggle=await p.locator('button:has-text("Voice tutor")').count()
console.log('Voice-tutor toggle present:', toggle>=1)
console.log('page errors:', errs.length?errs:'none')
await b.close()
