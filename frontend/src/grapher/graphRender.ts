// Render a 2D/3D plot OFFSCREEN with Plotly and return a PNG data URL. The
// whiteboard agent uses this as a "graph it correctly, then trace it" tool: it
// asks for a reference plot of an equation/surface, we render the real thing,
// and feed the image back so it draws the shape with accurate proportions and
// orientation instead of free-handing it.

let plotlyPromise: Promise<any> | null = null
let mathPromise: Promise<any> | null = null
async function loadLibs() {
  if (!plotlyPromise) plotlyPromise = import('plotly.js-dist-min')
  if (!mathPromise) mathPromise = import('mathjs')
  const [pl, math] = await Promise.all([plotlyPromise, mathPromise])
  return { Plotly: (pl as any).default ?? pl, math }
}

const COLORS = ['#2d70b3', '#388c46', '#c74440', '#6042a6', '#e07b39', '#1f6f6f', '#000000']
const POINT_RE = /^\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?:,\s*(-?[\d.]+)\s*)?\)$/
const LHS_RE_3D = /^\s*(z|f\s*\([^)]*\))\s*=\s*/i
const LHS_RE_2D = /^\s*(y|f\s*\([^)]*\))\s*=\s*/i

function buildTraces(mode: '2d' | '3d', expressions: string[], math: any): any[] {
  const traces: any[] = []
  expressions.forEach((raw, idx) => {
    const color = COLORS[idx % COLORS.length]
    const t = (raw ?? '').trim()
    if (!t) return

    const pt = t.match(POINT_RE)
    if (pt) {
      if (mode === '3d') {
        traces.push({
          type: 'scatter3d', mode: 'markers',
          x: [+pt[1]], y: [+pt[2]], z: [+(pt[3] ?? 0)],
          marker: { color, size: 5 }, name: t,
        })
      } else {
        traces.push({
          type: 'scatter', mode: 'markers',
          x: [+pt[1]], y: [+pt[2]], marker: { color, size: 9 }, name: t,
        })
      }
      return
    }

    const rhs = t.replace(mode === '3d' ? LHS_RE_3D : LHS_RE_2D, '')
    if (rhs.includes('=')) return // not a z=f(x,y) / y=f(x) we can plot
    let compiled: any
    try {
      compiled = math.parse(rhs).compile()
    } catch {
      return
    }
    const num = (scope: any) => {
      try {
        const v = compiled.evaluate(scope)
        return typeof v === 'number' && isFinite(v) ? v : NaN
      } catch {
        return NaN
      }
    }

    if (mode === '3d') {
      const N = 55, lo = -6, hi = 6
      const xs: number[] = [], ys: number[] = []
      for (let i = 0; i < N; i++) {
        xs.push(lo + ((hi - lo) * i) / (N - 1))
        ys.push(lo + ((hi - lo) * i) / (N - 1))
      }
      const zs: number[][] = []
      let hasFinite = false
      for (let j = 0; j < N; j++) {
        const rowz: number[] = []
        for (let i = 0; i < N; i++) {
          const v = num({ x: xs[i], y: ys[j] })
          if (Number.isFinite(v)) hasFinite = true
          rowz.push(v)
        }
        zs.push(rowz)
      }
      if (!hasFinite) return // all-NaN surface crashes Plotly's WebGL renderer
      traces.push({
        type: 'surface', x: xs, y: ys, z: zs,
        showscale: false, opacity: 0.92,
        colorscale: [[0, color], [1, color]], name: t,
      })
    } else {
      const N = 600, lo = -12, hi = 12
      const xs: number[] = [], yv: number[] = []
      for (let i = 0; i < N; i++) {
        const xv = lo + ((hi - lo) * i) / (N - 1)
        xs.push(xv)
        yv.push(num({ x: xv }))
      }
      traces.push({
        type: 'scatter', mode: 'lines', x: xs, y: yv,
        line: { color, width: 2.5 }, name: t,
      })
    }
  })
  return traces
}

/**
 * Sample a 2D function y=f(x) and map it to ACCURATE canvas points inside `box`
 * (absolute scene coords), with the y-axis flipped for the screen (larger y =
 * higher up). Returns the polyline points + where the (0,0) origin lands, so the
 * agent can draw axes through it. This is how 2D graphs get drawn correctly
 * (deterministically) instead of being eyeballed by the model.
 */
export async function sampleCurvePoints(
  expression: string,
  box: { x: number; y: number; w: number; h: number }
): Promise<{ points: [number, number][]; origin: { x: number; y: number } } | null> {
  const { math } = await loadLibs()
  const rhs = expression.replace(LHS_RE_2D, '').trim()
  if (rhs.includes('=')) return null
  let compiled: any
  try {
    compiled = math.parse(rhs).compile()
  } catch {
    return null
  }
  const xmin = -4, xmax = 4, N = 49
  const xs: number[] = [], ys: number[] = []
  let ymin = Infinity, ymax = -Infinity
  for (let i = 0; i < N; i++) {
    const xv = xmin + ((xmax - xmin) * i) / (N - 1)
    let yv: number
    try {
      const v = compiled.evaluate({ x: xv })
      yv = typeof v === 'number' && isFinite(v) ? v : NaN
    } catch {
      yv = NaN
    }
    xs.push(xv)
    ys.push(yv)
    if (Number.isFinite(yv)) {
      ymin = Math.min(ymin, yv)
      ymax = Math.max(ymax, yv)
    }
  }
  if (!isFinite(ymin) || !isFinite(ymax)) return null
  if (ymax - ymin < 1e-6) {
    ymin -= 1
    ymax += 1
  }
  const pad = (ymax - ymin) * 0.08
  ymin -= pad
  ymax += pad

  const sx = (xv: number) => box.x + ((xv - xmin) / (xmax - xmin)) * box.w
  // Flip Y: larger value -> smaller screen Y (higher on canvas).
  const sy = (yv: number) => box.y + box.h - ((yv - ymin) / (ymax - ymin)) * box.h

  const points: [number, number][] = []
  for (let i = 0; i < N; i++) {
    if (Number.isFinite(ys[i])) points.push([sx(xs[i]), sy(ys[i])])
  }
  if (points.length < 2) return null

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  const origin = {
    x: clamp(sx(0), box.x, box.x + box.w),
    y: clamp(sy(0), box.y, box.y + box.h),
  }
  return { points, origin }
}

/** Render the expressions to a PNG data URL via an offscreen Plotly plot. */
export async function renderGraphToImage(
  mode: '2d' | '3d',
  expressions: string[],
  opts: { width?: number; height?: number } = {}
): Promise<string> {
  const { Plotly, math } = await loadLibs()
  const width = opts.width ?? 720
  const height = opts.height ?? 560
  const traces = buildTraces(mode, expressions, math)
  if (traces.length === 0) throw new Error('Nothing plottable in those expressions')

  const div = document.createElement('div')
  div.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;height:${height}px;`
  document.body.appendChild(div)

  const layout =
    mode === '3d'
      ? {
          width, height, margin: { l: 0, r: 0, t: 0, b: 0 },
          scene: {
            xaxis: { title: 'x' }, yaxis: { title: 'y' }, zaxis: { title: 'z' },
            camera: { eye: { x: 1.6, y: 1.6, z: 1.05 } },
            aspectmode: 'cube',
          },
          showlegend: false,
        }
      : {
          width, height, margin: { l: 42, r: 14, t: 14, b: 34 },
          xaxis: { zeroline: true, range: [-10, 10] },
          yaxis: { zeroline: true, scaleanchor: 'x' },
          showlegend: false,
        }

  try {
    await Plotly.newPlot(div, traces, layout, { staticPlot: true, displaylogo: false })
    await new Promise((r) => setTimeout(r, 180)) // let WebGL settle
    return (await Plotly.toImage(div, { format: 'png', width, height })) as string
  } finally {
    try {
      Plotly.purge(div)
    } catch {
      // ignore
    }
    div.remove()
  }
}
