// Deterministically draw a "region between two curves" figure for region-of-
// integration / change-of-order problems. The agent is bad at laying this out by
// hand (it crams curves, strips, a stray polygon, and labels on top of each
// other), so the client computes the whole figure — bounding curves, the shaded
// region, axes, and ONE vertical + ONE horizontal representative strip — all
// correctly placed. The agent then only writes the integrals/labels around it.

let mathPromise: Promise<any> | null = null
async function loadMath() {
  if (!mathPromise) mathPromise = import('mathjs')
  const m = await mathPromise
  return (m as any).default ?? m
}

type Pt = [number, number]
type Box = { x: number; y: number; w: number; h: number }

export interface RegionDrawable {
  type: 'line' | 'rectangle' | 'arrow' | 'text'
  points?: Pt[] // canvas coords (line/arrow); for text, points[0] is the top-left
  rect?: { x: number; y: number; w: number; h: number } // canvas coords (rectangle)
  text?: string // for type 'text'
  fontSize?: number
  stroke: string
  fill?: string
  fillStyle?: 'solid' | 'hachure' | 'cross-hatch'
  closed?: boolean
}

// "x^2" -> "x²" etc. for a compact text label.
function pretty(expr: string): string {
  return expr.replace(/\^2/g, '²').replace(/\^3/g, '³').replace(/\*/g, '')
}

export interface RegionPlot {
  drawables: RegionDrawable[] // back-to-front
  origin: { x: number; y: number } // canvas coords of (0,0)
  // canvas coords of useful anchor points the agent can label near
  anchors: {
    lowerCurve: Pt
    upperCurve: Pt
    vStrip: Pt
    hStrip: Pt
    xAxisTip: Pt
    yAxisTip: Pt
  }
}

function compile(math: any, expr: string): ((x: number) => number) | null {
  const rhs = expr.replace(/^\s*(y|f\s*\([^)]*\))\s*=\s*/i, '').trim()
  let c: any
  try {
    c = math.parse(rhs).compile()
  } catch {
    return null
  }
  return (x: number) => {
    try {
      const v = c.evaluate({ x })
      return typeof v === 'number' && isFinite(v) ? v : NaN
    } catch {
      return NaN
    }
  }
}

/**
 * Build the region figure. `lower`/`upper` are the bounding curves y=f(x);
 * the region is xmin<=x<=xmax, lower(x)<=y<=upper(x).
 */
export async function plotRegion(
  lower: string,
  upper: string,
  xmin: number,
  xmax: number,
  box: Box
): Promise<RegionPlot | null> {
  const math = await loadMath()
  const lo = compile(math, lower)
  const hi = compile(math, upper)
  if (!lo || !hi || !(xmax > xmin)) return null

  const N = 160
  const xs: number[] = []
  const loY: number[] = []
  const hiY: number[] = []
  let yLo = Infinity, yHi = -Infinity
  for (let i = 0; i < N; i++) {
    const x = xmin + ((xmax - xmin) * i) / (N - 1)
    const a = lo(x), b = hi(x)
    xs.push(x)
    loY.push(a)
    hiY.push(b)
    if (Number.isFinite(a)) yLo = Math.min(yLo, a)
    if (Number.isFinite(b)) yHi = Math.max(yHi, b)
  }
  if (!isFinite(yLo) || !isFinite(yHi)) return null

  // Window: the region, padded, and always including y=0 so the origin shows.
  const padX = (xmax - xmin) * 0.18
  const padY = (yHi - yLo) * 0.18 || 1
  const win = {
    xmin: xmin - padX,
    xmax: xmax + padX,
    ymin: Math.min(0, yLo) - padY,
    ymax: yHi + padY,
  }
  const wW = win.xmax - win.xmin || 1
  const wH = win.ymax - win.ymin || 1
  const sx = (x: number) => box.x + ((x - win.xmin) / wW) * box.w
  const sy = (y: number) => box.y + box.h - ((y - win.ymin) / wH) * box.h // flip

  const drawables: RegionDrawable[] = []

  // 1. Shaded region polygon: lower curve forward, upper curve back, closed.
  const regionPts: Pt[] = []
  for (let i = 0; i < N; i++) if (Number.isFinite(loY[i])) regionPts.push([sx(xs[i]), sy(loY[i])])
  for (let i = N - 1; i >= 0; i--) if (Number.isFinite(hiY[i])) regionPts.push([sx(xs[i]), sy(hiY[i])])
  if (regionPts.length >= 3) {
    regionPts.push(regionPts[0])
    drawables.push({
      type: 'line',
      points: regionPts,
      stroke: '#74c0fc',
      fill: '#a5d8ff',
      fillStyle: 'hachure',
      closed: true,
    })
  }

  // 2. Axes (arrows) through the origin, spanning the window.
  drawables.push({ type: 'arrow', points: [[sx(win.xmin), sy(0)], [sx(win.xmax), sy(0)]], stroke: '#1e1e1e' })
  drawables.push({ type: 'arrow', points: [[sx(0), sy(win.ymin)], [sx(0), sy(win.ymax)]], stroke: '#1e1e1e' })

  // 3. The two bounding curves.
  const lowerPts: Pt[] = []
  const upperPts: Pt[] = []
  for (let i = 0; i < N; i++) {
    if (Number.isFinite(loY[i])) lowerPts.push([sx(xs[i]), sy(loY[i])])
    if (Number.isFinite(hiY[i])) upperPts.push([sx(xs[i]), sy(hiY[i])])
  }
  if (lowerPts.length >= 2) drawables.push({ type: 'line', points: lowerPts, stroke: '#1971c2' })
  if (upperPts.length >= 2) drawables.push({ type: 'line', points: upperPts, stroke: '#2f9e44' })

  // 4. Vertical strip (dy dx): thin rect at a sample x, from lower to upper.
  const xv = xmin + (xmax - xmin) * 0.32
  const sw = (xmax - xmin) * 0.045
  const yvTop = hi(xv), yvBot = lo(xv)
  if (Number.isFinite(yvTop) && Number.isFinite(yvBot)) {
    const top = sy(Math.max(yvTop, yvBot))
    const bot = sy(Math.min(yvTop, yvBot))
    drawables.push({
      type: 'rectangle',
      rect: { x: sx(xv) - (sx(xv + sw) - sx(xv)), y: top, w: 2 * (sx(xv + sw) - sx(xv)), h: bot - top },
      stroke: '#e8590c',
      fill: '#ffd8a8',
      fillStyle: 'solid',
    })
  }

  // 5. Horizontal strip (dx dy): thin rect at a sample y, spanning the region.
  const yh = yLo + (yHi - yLo) * 0.62
  let xa = Infinity, xb = -Infinity
  for (let i = 0; i < N; i++) {
    if (Number.isFinite(loY[i]) && Number.isFinite(hiY[i]) && loY[i] <= yh && yh <= hiY[i]) {
      xa = Math.min(xa, xs[i])
      xb = Math.max(xb, xs[i])
    }
  }
  let hStripAnchor: Pt = [sx((xmin + xmax) / 2), sy(yh)]
  if (isFinite(xa) && xb > xa) {
    const sh = (yHi - yLo) * 0.035
    const yTop = sy(yh + sh)
    drawables.push({
      type: 'rectangle',
      rect: { x: sx(xa), y: yTop, w: sx(xb) - sx(xa), h: sy(yh - sh) - yTop },
      stroke: '#2f9e44',
      fill: '#b2f2bb',
      fillStyle: 'solid',
    })
    hStripAnchor = [sx(xb), sy(yh)]
  }

  // 6. Labels — placed by the client in CLEAR space (off the figure), so the
  // agent never has to (and never puts text on the region).
  const label = (text: string, x: number, y: number, color = '#1e1e1e') =>
    drawables.push({ type: 'text', text, points: [[x, y]], fontSize: 16, stroke: color })
  // upper curve: above the line, left side
  label(`y = ${pretty(upper)}`, sx(win.xmin) + 6, sy(hi(xmin)) - 26, '#2f9e44')
  // lower curve: just BELOW the right arm (outside the region)
  const xl = xmin + (xmax - xmin) * 0.8
  if (Number.isFinite(lo(xl))) label(`y = ${pretty(lower)}`, sx(xl) + 8, sy(lo(xl)) + 8, '#1971c2')
  // axes
  label('x', sx(win.xmax) - 2, sy(0) + 8)
  label('y', sx(0) - 20, sy(win.ymax) + 2)
  // strips
  if (Number.isFinite(yvBot)) label('dy dx', sx(xv) - 18, sy(Math.min(yvTop, yvBot)) + 12, '#e8590c')
  if (isFinite(xa) && xb > xa) label('dx dy', sx(xb) + 8, sy(yh) - 8, '#2f9e44')

  return {
    drawables,
    origin: { x: sx(0), y: sy(0) },
    anchors: {
      // Anchor the two curve labels at separated x (and different y) so they
      // don't collide where the curves meet.
      lowerCurve: [sx(xmin + (xmax - xmin) * 0.74), sy(lo(xmin + (xmax - xmin) * 0.74))],
      upperCurve: [sx(xmin + (xmax - xmin) * 0.26), sy(hi(xmin + (xmax - xmin) * 0.26))],
      vStrip: [sx(xv), sy(Math.min(yvTop, yvBot)) + 8],
      hStrip: hStripAnchor,
      xAxisTip: [sx(win.xmax), sy(0)],
      yAxisTip: [sx(0), sy(win.ymax)],
    },
  }
}
