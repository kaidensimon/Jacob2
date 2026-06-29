// Render LaTeX math to a PNG image (data URL) using MathJax's SVG output.
//
// Excalidraw's hand-drawn font can't draw real math (∫, √, fractions, matrices),
// so the agent emits `math` elements carrying LaTeX and we render them here, then
// drop them on the canvas as image elements. MathJax SVG output embeds every
// glyph as a vector <path>, so the result is self-contained (no web-font needed)
// and rasterizes cleanly. MathJax is Apache-2.0 (free for commercial use).
//
// We use the prebuilt `tex-svg-full` component bundle rather than the `js/` ES
// modules: the raw modules keep runtime `require()` calls (for lazy font/extension
// loading) that throw "require is not defined" in the browser. The bundle is
// self-contained and exposes `MathJax.tex2svg(...)`.

interface MathJaxGlobal {
  startup: { promise: Promise<void> }
  tex2svg: (latex: string, options?: { display?: boolean }) => HTMLElement
}

declare global {
  interface Window {
    MathJax?: any
  }
}

let loadPromise: Promise<MathJaxGlobal> | null = null

function loadMathJax(): Promise<MathJaxGlobal> {
  if (!loadPromise) {
    loadPromise = (async () => {
      if (!window.MathJax) {
        // Config must exist BEFORE the bundle runs its startup.
        window.MathJax = {
          startup: { typeset: false },
          svg: { fontCache: 'local' },
        }
      }
      const { default: url } = await import('mathjax-full/es5/tex-svg-full.js?url')
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.src = url
        s.async = true
        s.onload = () => resolve()
        s.onerror = () => reject(new Error('Failed to load MathJax'))
        document.head.appendChild(s)
      })
      await window.MathJax.startup.promise
      return window.MathJax as MathJaxGlobal
    })()
  }
  return loadPromise
}

export interface RenderedMath {
  dataUrl: string // image/png data URL
  width: number // logical px (place the canvas image at this size)
  height: number
}

// Strip common wrappers so the agent can be a bit sloppy: "$$ x $$", "\[ x \]",
// "$x$", or a leading "latex:" — all reduce to the bare TeX body.
function normalizeLatex(input: string): string {
  let s = input.trim()
  s = s.replace(/^latex\s*:/i, '').trim()
  if (s.startsWith('$$') && s.endsWith('$$')) s = s.slice(2, -2)
  else if (s.startsWith('\\[') && s.endsWith('\\]')) s = s.slice(2, -2)
  else if (s.startsWith('\\(') && s.endsWith('\\)')) s = s.slice(2, -2)
  else if (s.startsWith('$') && s.endsWith('$')) s = s.slice(1, -1)
  return s.trim()
}

/**
 * Render a LaTeX string to a PNG data URL plus its logical pixel size.
 * `fontSize` is the visual em size on the canvas; `scale` oversamples the raster
 * so the math stays crisp when the user zooms in.
 */
export async function renderLatexToImage(
  latex: string,
  opts: { color?: string; fontSize?: number; scale?: number } = {}
): Promise<RenderedMath> {
  const color = opts.color ?? '#1e1e1e'
  const fontSize = opts.fontSize ?? 20
  const scale = opts.scale ?? 3

  const MathJax = await loadMathJax()
  const container = MathJax.tex2svg(normalizeLatex(latex) || '\\,', { display: true })
  const svgEl = container.querySelector('svg') as SVGSVGElement | null
  if (!svgEl) throw new Error('MathJax produced no SVG')

  // Measure at the target font size by laying it out off-screen.
  const wrapper = document.createElement('div')
  wrapper.style.cssText =
    `position:absolute;left:-99999px;top:0;visibility:hidden;` +
    `font-size:${fontSize}px;color:${color};line-height:0`
  wrapper.appendChild(svgEl)
  document.body.appendChild(wrapper)
  const rect = svgEl.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  // Pin explicit pixel size + color so the standalone SVG rasterizes identically.
  svgEl.setAttribute('width', String(width))
  svgEl.setAttribute('height', String(height))
  svgEl.style.color = color // MathJax glyph paths use fill="currentColor"
  const svgXml = new XMLSerializer().serializeToString(svgEl)
  document.body.removeChild(wrapper)

  const svgUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgXml)))
  const img = new Image()
  img.width = width
  img.height = height
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Failed to rasterize math SVG'))
    img.src = svgUrl
  })

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width * scale))
  canvas.height = Math.max(1, Math.ceil(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2D canvas context')
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, width, height)

  return { dataUrl: canvas.toDataURL('image/png'), width, height }
}
