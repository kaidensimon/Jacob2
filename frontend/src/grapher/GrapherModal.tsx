import { useCallback, useEffect, useRef, useState } from 'react'
import './grapher.css'

// Lazy-load the heavy libs (both MIT / Apache-2.0, free for commercial use) so
// they stay out of the main bundle.
let plotlyPromise: Promise<any> | null = null
let mathPromise: Promise<any> | null = null
async function loadLibs() {
  if (!plotlyPromise) plotlyPromise = import('plotly.js-dist-min')
  if (!mathPromise) mathPromise = import('mathjs')
  const [pl, math] = await Promise.all([plotlyPromise, mathPromise])
  return { Plotly: (pl as any).default ?? pl, math }
}

const COLORS = ['#2d70b3', '#388c46', '#c74440', '#6042a6', '#e07b39', '#1f6f6f', '#000000']

interface Row {
  id: number
  text: string
}

const POINT_RE = /^\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?:,\s*(-?[\d.]+)\s*)?\)$/
// Strip only the dependent-variable prefix: "z =" / "f(...) =" in 3D, "y =" / "f(...) =" in 2D.
const LHS_RE_3D = /^\s*(z|f\s*\([^)]*\))\s*=\s*/i
const LHS_RE_2D = /^\s*(y|f\s*\([^)]*\))\s*=\s*/i

interface Props {
  mode: '2d' | '3d'
  initialExpressions?: string[]
  onClose: () => void
}

export function GrapherModal({ mode, initialExpressions, onClose }: Props) {
  const plotRef = useRef<HTMLDivElement>(null)
  const libsRef = useRef<any>(null)
  const nextId = useRef(0)

  const [rows, setRows] = useState<Row[]>(() => {
    const seed =
      initialExpressions && initialExpressions.length
        ? initialExpressions
        : [mode === '3d' ? 'z = x^2 + y^2' : 'y = sin(x)']
    return seed.map((text) => ({ id: nextId.current++, text }))
  })
  const [errors, setErrors] = useState<Record<number, string>>({})

  const replot = useCallback(() => {
    const libs = libsRef.current
    if (!libs || !plotRef.current) return
    const { Plotly, math } = libs
    const traces: any[] = []
    const errs: Record<number, string> = {}

    rows.forEach((row, idx) => {
      const color = COLORS[idx % COLORS.length]
      const t = row.text.trim()
      if (!t) return

      // A literal point: (a, b) or (a, b, c)
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
            x: [+pt[1]], y: [+pt[2]],
            marker: { color, size: 9 }, name: t,
          })
        }
        return
      }

      // A function: strip the dependent-variable prefix and compile the RHS.
      const rhs = t.replace(mode === '3d' ? LHS_RE_3D : LHS_RE_2D, '')
      if (rhs.includes('=')) {
        // e.g. "x = 0" in 3D — not a z=f(x,y) surface we can plot.
        errs[row.id] = mode === '3d' ? 'Use z = f(x, y)' : 'Use y = f(x)'
        return
      }
      let compiled: any
      try {
        compiled = math.parse(rhs).compile()
      } catch {
        errs[row.id] = 'Invalid expression'
        return
      }

      const num = (scope: any) => {
        let v: any
        try {
          v = compiled.evaluate(scope)
        } catch {
          return NaN
        }
        return typeof v === 'number' && isFinite(v) ? v : NaN
      }

      try {
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
          // An all-NaN surface (e.g. you typed "z" before "=", or referenced an
          // undefined variable) crashes Plotly's WebGL renderer — skip it.
          if (!hasFinite) {
            errs[row.id] = 'No real values to plot'
            return
          }
          traces.push({
            type: 'surface', x: xs, y: ys, z: zs,
            showscale: false, opacity: 0.9,
            colorscale: [[0, color], [1, color]],
            name: t,
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
      } catch {
        errs[row.id] = 'Could not plot'
      }
    })

    const layout =
      mode === '3d'
        ? {
            margin: { l: 0, r: 0, t: 0, b: 0 },
            scene: { xaxis: { title: 'x' }, yaxis: { title: 'y' }, zaxis: { title: 'z' } },
            showlegend: false,
          }
        : {
            margin: { l: 36, r: 12, t: 12, b: 30 },
            xaxis: { zeroline: true, range: [-10, 10] },
            yaxis: { zeroline: true, scaleanchor: 'x' },
            showlegend: false,
          }

    try {
      Plotly.react(plotRef.current, traces, layout, {
        responsive: true,
        displaylogo: false,
        scrollZoom: true,
      })
    } catch {
      // ignore plotting errors — never let a bad expression crash the app
    }

    // Click on the plot to drop a point.
    const el = plotRef.current as any
    if (!el._clickBound && typeof el.on === 'function') {
      el._clickBound = true
      el.on('plotly_click', (e: any) => {
        const p = e?.points?.[0]
        if (!p) return
        const text =
          mode === '3d' && p.z !== undefined
            ? `(${round(p.x)}, ${round(p.y)}, ${round(p.z)})`
            : `(${round(p.x)}, ${round(p.y)})`
        setRows((prev) => [...prev, { id: nextId.current++, text }])
      })
    }

    setErrors(errs)
  }, [rows, mode])

  useEffect(() => {
    let cancelled = false
    loadLibs().then((libs) => {
      if (cancelled) return
      libsRef.current = libs
      replot()
    })
    return () => {
      cancelled = true
      const libs = libsRef.current
      if (libs && plotRef.current) libs.Plotly.purge(plotRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    replot()
  }, [replot])

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const setText = (id: number, text: string) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, text } : r)))
  const remove = (id: number) => setRows((prev) => prev.filter((r) => r.id !== id))
  const add = () => setRows((prev) => [...prev, { id: nextId.current++, text: '' }])

  return (
    <div className="grapher-overlay">
      <div className="grapher-head">
        <span className="grapher-title">
          {mode === '3d' ? '3D Grapher' : '2D Grapher'}
        </span>
        <span className="grapher-hint">
          Type equations like {mode === '3d' ? '“z = x^2 - y^2”, “sqrt(4-x^2-y^2)”' : '“y = sin(x)”, “x^2”'} or a point like {mode === '3d' ? '“(1, 0, 2)”' : '“(1, 2)”'}. Click the graph to drop a point.
        </span>
        <button className="grapher-close" onClick={onClose}>
          ✕ Close
        </button>
      </div>
      <div className="grapher-body">
        <div className="grapher-list">
          {rows.map((r, i) => (
            <div className="grapher-row" key={r.id}>
              <span className="grapher-dot" style={{ background: COLORS[i % COLORS.length] }} />
              <input
                className={`grapher-input ${errors[r.id] ? 'grapher-input-error' : ''}`}
                value={r.text}
                onChange={(e) => setText(r.id, e.target.value)}
                placeholder={mode === '3d' ? 'z = …' : 'y = …'}
                spellCheck={false}
              />
              <button className="grapher-remove" onClick={() => remove(r.id)} title="Remove">
                ✕
              </button>
            </div>
          ))}
          <button className="grapher-add" onClick={add}>
            + Add expression
          </button>
        </div>
        <div className="grapher-plot" ref={plotRef} />
      </div>
    </div>
  )
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
