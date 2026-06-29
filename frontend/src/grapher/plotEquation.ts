// General 2D equation plotter. Turns ANY 2D equation into accurate canvas
// polylines the agent can draw, so it's not limited to y = f(x). It handles:
//   - explicit functions:   y = sin(x),  x^2,  e^x
//   - implicit relations:   x^2 + y^2 = 25,  x^2/9 + y^2/4 = 1,  x^2 - y^2 = 1
//   - vertical lines:        x = 3
//   - polar curves:          r = 1 + cos(theta),  r = cos(3 theta)
// Implicit curves are found with marching squares (the zero-contour of
// F(x,y)=LHS-RHS), which naturally captures circles, multiple branches, etc.
// Everything is mapped into a target box with the screen y-axis flipped.

let mathPromise: Promise<any> | null = null
async function loadMath() {
  if (!mathPromise) mathPromise = import('mathjs')
  const m = await mathPromise
  return (m as any).default ?? m
}

type Pt = [number, number]
type Box = { x: number; y: number; w: number; h: number }

export interface PlottedEquation {
  polylines: Pt[][] // canvas-space, already y-flipped and mapped into the box
  origin: { x: number; y: number } // canvas coords of (0,0)
}

interface MathPlot {
  polylines: Pt[][] // math-space
  window: { xmin: number; xmax: number; ymin: number; ymax: number }
  equalAspect: boolean
}

function normalize(eq: string): string {
  return eq
    .trim()
    .replace(/θ/g, 'theta')
    .replace(/π/g, 'pi')
    .replace(/[—–−]/g, '-')
    .replace(/·/g, '*') // · -> *
}

type Classified =
  | { type: 'explicit'; expr: string }
  | { type: 'polar'; expr: string }
  | { type: 'implicit'; lhs: string; rhs: string }

function classify(raw: string): Classified {
  const s = normalize(raw)
  if (/^r\s*=/i.test(s)) return { type: 'polar', expr: s.replace(/^r\s*=/i, '').trim() }
  const eqIdx = s.indexOf('=')
  if (eqIdx === -1) {
    if (/\btheta\b/.test(s) && !/\bx\b|\by\b/.test(s)) return { type: 'polar', expr: s }
    return { type: 'explicit', expr: s } // bare expression -> y = s
  }
  const lhs = s.slice(0, eqIdx).trim()
  const rhs = s.slice(eqIdx + 1).trim()
  if (/^(y|f\s*\([^)]*\))$/i.test(lhs) && !/\by\b/.test(rhs)) {
    return { type: 'explicit', expr: rhs }
  }
  return { type: 'implicit', lhs, rhs }
}

const WIN = 10 // default half-window for implicit/polar plots

// ── Explicit y = f(x): sample, breaking the polyline at gaps/asymptotes ────────
function plotExplicit(math: any, expr: string): MathPlot | null {
  let f: any
  try {
    f = math.parse(expr).compile()
  } catch {
    return null
  }
  const xmin = -WIN, xmax = WIN, N = 600
  const polylines: Pt[][] = []
  let cur: Pt[] = []
  let prevY: number | null = null
  let ylo = Infinity, yhi = -Infinity
  const flush = () => {
    if (cur.length >= 2) polylines.push(cur)
    cur = []
  }
  for (let i = 0; i < N; i++) {
    const x = xmin + ((xmax - xmin) * i) / (N - 1)
    let y: number
    try {
      const v = f.evaluate({ x })
      y = typeof v === 'number' && isFinite(v) ? v : NaN
    } catch {
      y = NaN
    }
    if (!Number.isFinite(y) || Math.abs(y) > 1e4) {
      flush()
      prevY = null
      continue
    }
    // Break at a likely asymptote (big jump between adjacent samples).
    if (prevY !== null && Math.abs(y - prevY) > 60) flush()
    cur.push([x, y])
    prevY = y
    ylo = Math.min(ylo, y)
    yhi = Math.max(yhi, y)
  }
  flush()
  if (polylines.length === 0 || !isFinite(ylo)) return null
  if (yhi - ylo < 1e-6) {
    ylo -= 1
    yhi += 1
  }
  const pad = (yhi - ylo) * 0.08
  return {
    polylines,
    window: { xmin, xmax, ymin: ylo - pad, ymax: yhi + pad },
    equalAspect: false,
  }
}

// ── Polar r = f(theta) ─────────────────────────────────────────────────────────
function plotPolar(math: any, expr: string): MathPlot | null {
  let f: any
  try {
    f = math.parse(expr).compile()
  } catch {
    return null
  }
  const N = 1440
  const polylines: Pt[][] = []
  let cur: Pt[] = []
  let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity
  for (let i = 0; i < N; i++) {
    const theta = (2 * Math.PI * i) / (N - 1)
    let r: number
    try {
      const v = f.evaluate({ theta })
      r = typeof v === 'number' && isFinite(v) ? v : NaN
    } catch {
      r = NaN
    }
    if (!Number.isFinite(r) || Math.abs(r) > 1e4) {
      if (cur.length >= 2) polylines.push(cur)
      cur = []
      continue
    }
    const x = r * Math.cos(theta)
    const y = r * Math.sin(theta)
    cur.push([x, y])
    xlo = Math.min(xlo, x); xhi = Math.max(xhi, x)
    ylo = Math.min(ylo, y); yhi = Math.max(yhi, y)
  }
  if (cur.length >= 2) polylines.push(cur)
  if (polylines.length === 0 || !isFinite(xlo)) return null
  const padX = (xhi - xlo) * 0.08 || 1
  const padY = (yhi - ylo) * 0.08 || 1
  return {
    polylines,
    window: { xmin: xlo - padX, xmax: xhi + padX, ymin: ylo - padY, ymax: yhi + padY },
    equalAspect: true,
  }
}

// ── Implicit F(x,y) = 0 via marching squares ──────────────────────────────────
function plotImplicit(math: any, lhs: string, rhs: string): MathPlot | null {
  let fl: any, fr: any
  try {
    fl = math.parse(lhs).compile()
    fr = math.parse(rhs).compile()
  } catch {
    return null
  }
  const F = (x: number, y: number): number => {
    try {
      const a = fl.evaluate({ x, y })
      const b = fr.evaluate({ x, y })
      if (typeof a !== 'number' || typeof b !== 'number') return NaN
      return a - b
    } catch {
      return NaN
    }
  }
  const win = { xmin: -WIN, xmax: WIN, ymin: -WIN, ymax: WIN }
  const M = 160
  const dx = (win.xmax - win.xmin) / M
  const dy = (win.ymax - win.ymin) / M
  // Sample F on the grid.
  const val: number[][] = []
  for (let j = 0; j <= M; j++) {
    const row: number[] = []
    const y = win.ymin + j * dy
    for (let i = 0; i <= M; i++) row.push(F(win.xmin + i * dx, y))
    val.push(row)
  }
  const HUGE = 1e6
  const interp = (xa: number, ya: number, fa: number, xb: number, yb: number, fb: number): Pt => {
    const t = fa / (fa - fb)
    return [xa + t * (xb - xa), ya + t * (yb - ya)]
  }
  const segs: [Pt, Pt][] = []
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      const x0 = win.xmin + i * dx, x1 = x0 + dx
      const y0 = win.ymin + j * dy, y1 = y0 + dy
      const f00 = val[j][i], f10 = val[j][i + 1], f11 = val[j + 1][i + 1], f01 = val[j + 1][i]
      if (
        !Number.isFinite(f00) || !Number.isFinite(f10) ||
        !Number.isFinite(f11) || !Number.isFinite(f01) ||
        Math.abs(f00) > HUGE || Math.abs(f10) > HUGE ||
        Math.abs(f11) > HUGE || Math.abs(f01) > HUGE
      ) {
        continue // undefined / asymptotic cell
      }
      let idx = 0
      if (f00 > 0) idx |= 1
      if (f10 > 0) idx |= 2
      if (f11 > 0) idx |= 4
      if (f01 > 0) idx |= 8
      if (idx === 0 || idx === 15) continue
      const a = () => interp(x0, y0, f00, x1, y0, f10) // bottom
      const b = () => interp(x1, y0, f10, x1, y1, f11) // right
      const c = () => interp(x1, y1, f11, x0, y1, f01) // top
      const d = () => interp(x0, y1, f01, x0, y0, f00) // left
      switch (idx) {
        case 1: case 14: segs.push([a(), d()]); break
        case 2: case 13: segs.push([a(), b()]); break
        case 3: case 12: segs.push([b(), d()]); break
        case 4: case 11: segs.push([b(), c()]); break
        case 6: case 9: segs.push([a(), c()]); break
        case 7: case 8: segs.push([c(), d()]); break
        case 5: segs.push([a(), d()]); segs.push([b(), c()]); break // saddle
        case 10: segs.push([a(), b()]); segs.push([c(), d()]); break // saddle
      }
    }
  }
  if (segs.length === 0) return null
  return { polylines: stitch(segs), window: win, equalAspect: true }
}

// Stitch marching-squares segments into connected polylines.
function stitch(segs: [Pt, Pt][]): Pt[][] {
  const key = (p: Pt) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`
  const adj = new Map<string, { seg: number; other: Pt }[]>()
  segs.forEach(([p, q], i) => {
    for (const [from, to] of [[p, q], [q, p]] as [Pt, Pt][]) {
      const k = key(from)
      if (!adj.has(k)) adj.set(k, [])
      adj.get(k)!.push({ seg: i, other: to })
    }
  })
  const used = new Array(segs.length).fill(false)
  const polylines: Pt[][] = []
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = true
    const line: Pt[] = [segs[i][0], segs[i][1]]
    // extend forward from the tail
    let grew = true
    while (grew) {
      grew = false
      const tail = line[line.length - 1]
      for (const cand of adj.get(key(tail)) || []) {
        if (used[cand.seg]) continue
        used[cand.seg] = true
        line.push(cand.other)
        grew = true
        break
      }
    }
    // extend backward from the head
    grew = true
    while (grew) {
      grew = false
      const head = line[0]
      for (const cand of adj.get(key(head)) || []) {
        if (used[cand.seg]) continue
        used[cand.seg] = true
        line.unshift(cand.other)
        grew = true
        break
      }
    }
    if (line.length >= 2) polylines.push(line)
  }
  return polylines
}

type Window = { xmin: number; xmax: number; ymin: number; ymax: number }

// A canvas-space mapper for a window (flip Y for the screen).
function makeMapper(window: Window, box: Box, equalAspect: boolean) {
  const { xmin, xmax, ymin, ymax } = window
  const wW = xmax - xmin || 1
  const wH = ymax - ymin || 1
  if (equalAspect) {
    const scale = Math.min(box.w / wW, box.h / wH)
    const cxS = (xmin + xmax) / 2, cyS = (ymin + ymax) / 2
    const cxB = box.x + box.w / 2, cyB = box.y + box.h / 2
    return { sx: (x: number) => cxB + (x - cxS) * scale, sy: (y: number) => cyB - (y - cyS) * scale }
  }
  return {
    sx: (x: number) => box.x + ((x - xmin) / wW) * box.w,
    sy: (y: number) => box.y + box.h - ((y - ymin) / wH) * box.h,
  }
}

function unionWindows(ws: Window[]): Window {
  return {
    xmin: Math.min(...ws.map((w) => w.xmin)),
    xmax: Math.max(...ws.map((w) => w.xmax)),
    ymin: Math.min(...ws.map((w) => w.ymin)),
    ymax: Math.max(...ws.map((w) => w.ymax)),
  }
}

function computeMathPlot(math: any, equation: string): MathPlot | null {
  const cls = classify(equation)
  if (cls.type === 'explicit') return plotExplicit(math, cls.expr)
  if (cls.type === 'polar') return plotPolar(math, cls.expr)
  return plotImplicit(math, cls.lhs, cls.rhs)
}

/** Plot ANY 2D equation into the box. Returns one polyline per curve branch. */
export async function plotEquation(equation: string, box: Box): Promise<PlottedEquation | null> {
  const math = await loadMath()
  const mp = computeMathPlot(math, equation)
  if (!mp || mp.polylines.length === 0) return null
  const { sx, sy } = makeMapper(mp.window, box, mp.equalAspect)
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  return {
    polylines: mp.polylines.map((pl) => pl.map(([x, y]) => [sx(x), sy(y)] as Pt)),
    origin: { x: clamp(sx(0), box.x, box.x + box.w), y: clamp(sy(0), box.y, box.y + box.h) },
  }
}

export interface PlottedGraph {
  // curves[i] corresponds to expressions[i]; anchor is a point ON the curve
  // (canvas coords) the agent can point a label-arrow at.
  curves: { polylines: Pt[][]; anchor: Pt }[]
  origin: { x: number; y: number }
  xAxis: [Pt, Pt] // canvas: left -> right
  yAxis: [Pt, Pt] // canvas: bottom -> top
}

/**
 * Plot one or more equations as a COMPLETE graph (curves + axes) in one shared
 * coordinate system. The client draws all of this; the agent only labels.
 */
export async function plotGraph(expressions: string[], box: Box): Promise<PlottedGraph | null> {
  const math = await loadMath()
  const mps: MathPlot[] = []
  const idxOf: number[] = []
  expressions.forEach((eq, i) => {
    const mp = computeMathPlot(math, eq)
    if (mp && mp.polylines.length) {
      mps.push(mp)
      idxOf.push(i)
    }
  })
  if (mps.length === 0) return null
  const window = unionWindows(mps.map((m) => m.window))
  const equalAspect = mps.some((m) => m.equalAspect)
  const { sx, sy } = makeMapper(window, box, equalAspect)

  const curves = mps.map((mp) => {
    const polylines = mp.polylines.map((pl) => pl.map(([x, y]) => [sx(x), sy(y)] as Pt))
    const longest = polylines.reduce((a, b) => (b.length > a.length ? b : a))
    const anchor = longest[Math.min(longest.length - 1, Math.floor(longest.length * 0.6))]
    return { polylines, anchor }
  })

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  const ox = clamp(sx(0), box.x, box.x + box.w)
  const oy = clamp(sy(0), box.y, box.y + box.h)
  return {
    curves,
    origin: { x: ox, y: oy },
    xAxis: [[box.x, oy], [box.x + box.w, oy]],
    yAxis: [[ox, box.y + box.h], [ox, box.y]],
  }
}
