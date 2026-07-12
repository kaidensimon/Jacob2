import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AgentShape } from './types'

// We keep skeletons loosely typed to avoid fragile subpath type juggling;
// convertToExcalidrawElements validates them at runtime.
type Skeleton = Record<string, any>

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

const DEFAULT_W = 160
const DEFAULT_H = 80

// Excalidraw bakes each text element's width in at CREATION time by measuring
// the glyphs. If the hand-drawn face ("Excalifont") hasn't loaded yet, it
// measures with a narrow fallback and stores a width ~20% too small — then the
// real, wider glyphs overflow and get CLIPPED. Every render path must wait for
// the font so text is measured against what it will actually render with.
// Memoized: the fetch happens once, callers just await the settled promise.
let _fontsReady: Promise<void> | null = null
export function ensureCanvasFonts(): Promise<void> {
  if (_fontsReady) return _fontsReady
  _fontsReady = (async () => {
    const fonts: any = typeof document !== 'undefined' ? (document as any).fonts : undefined
    if (!fonts?.load) return
    // Retry: the Excalifont FontFace is registered by Excalidraw asynchronously,
    // so on a cold start load() can fire before it exists. Poll briefly until
    // the face is actually loaded (or give up after ~3s and let it render).
    for (let i = 0; i < 30; i++) {
      try {
        await Promise.all([fonts.load('20px Excalifont'), fonts.load('36px Excalifont')])
      } catch { /* face not registered yet */ }
      if (fonts.check('20px Excalifont')) return
      await new Promise((r) => setTimeout(r, 100))
    }
  })()
  return _fontsReady
}

/**
 * Excalidraw's hand-drawn font is missing glyphs for a few math symbols, which
 * render as garbage (∫→"°", √→"Ã", ≠→"-", ∞→"°"). Everything else — ∂ ∇ ∑ ∏ ∮
 * ≤ ≥ ± × · ∈ ∪ ∩, Greek, ² ³, → — renders fine, so we only patch these four,
 * swapping each for a substitute that DOES render hand-drawn. This runs only on
 * text bound for the CANVAS; the chat message (normal DOM font) is left intact.
 */
function fixCanvasGlyphs(text: string): string {
  return text
    // Model sometimes double-escapes Greek/symbols in a label, e.g. literal
    // "ρ" instead of ρ. Decode those escape sequences back to the character.
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/∫/g, 'ſ') // ∫ single integral → ſ (long-s; looks like an integral)
    .replace(/√\s*\(/g, 'sqrt(') // √( … ) → sqrt( … )
    .replace(/√\s*([A-Za-z0-9]+)/g, 'sqrt($1)') // √x / √162 → sqrt(x) / sqrt(162)
    .replace(/√/g, 'sqrt') // any stray √ → sqrt
    .replace(/≠/g, '≢') // ≠ (drops its slash) → ≢ (renders, reads "not equal")
    .replace(/∞/g, 'inf') // ∞ → inf (no hand-drawn glyph)
}

function agentBounds(shape: AgentShape): Bounds {
  return {
    x: shape.x ?? 0,
    y: shape.y ?? 0,
    width: shape.width ?? DEFAULT_W,
    height: shape.height ?? DEFAULT_H,
  }
}

function centerOf(b: Bounds): { x: number; y: number } {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

// The point on box `b`'s border along the ray from its center toward `toward`,
// pushed out by `gap`. Used to clip a connector to a shape's edge so it runs in
// the empty space between shapes instead of stabbing through their interiors and
// centered labels. (Rectangle border; a good-enough approximation for ellipse /
// diamond, which the gap absorbs.)
function edgePoint(
  b: Bounds,
  toward: { x: number; y: number },
  gap: number
): { x: number; y: number } {
  const c = centerOf(b)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (dx === 0 && dy === 0) return c
  const hw = b.width / 2
  const hh = b.height / 2
  // Scale the direction so it lands exactly on the rectangle border.
  const s = Math.min(
    dx !== 0 ? hw / Math.abs(dx) : Infinity,
    dy !== 0 ? hh / Math.abs(dy) : Infinity
  )
  const len = Math.hypot(dx, dy)
  return { x: c.x + dx * s + (dx / len) * gap, y: c.y + dy * s + (dy / len) * gap }
}

// Measure a label's widest line in px using the canvas 2D API (browser only).
let _measureCtx: CanvasRenderingContext2D | null = null
function measureTextWidth(text: string, fontSize: number): number {
  if (typeof document === 'undefined') return text.length * fontSize * 0.55
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d')
  if (!_measureCtx) return text.length * fontSize * 0.55
  _measureCtx.font = `${fontSize}px Excalifont, Virgil, "Segoe UI", sans-serif`
  let w = 0
  for (const line of String(text).split('\n')) w = Math.max(w, _measureCtx.measureText(line).width)
  return w * 1.08 // small fudge for the hand-drawn font's wider glyphs
}

// Ensure a labelled container is big enough that a short label sits on ONE line
// instead of wrapping mid-word or getting clipped (the model routinely makes
// boxes too narrow). Only ever ENLARGES; long labels are still allowed to wrap.
function fitLabelledContainer(
  type: 'rectangle' | 'ellipse' | 'diamond',
  text: string,
  width: number,
  height: number
): { width: number; height: number } {
  const label = text.trim()
  if (!label) return { width, height }
  const fontSize = 20 // Excalidraw MEDIUM — the default bound-text size
  const words = label.split(/\s+/)
  const longestWord = words.reduce((m, w) => Math.max(m, measureTextWidth(w, fontSize)), 0)
  const full = measureTextWidth(label, fontSize)
  const PAD = 26
  // Fraction of the container's box Excalidraw actually WRAPS bound text at:
  // diamond ≈ width/2, ellipse ≈ width/√2, rectangle ≈ width - padding.
  // Undershooting these made short labels wrap to 2 lines and spill out of the
  // shape's slanted/curved edges. Slightly conservative for safety margin.
  const frac = type === 'diamond' ? 0.48 : type === 'ellipse' ? 0.68 : 0.9
  // Fit the whole label on one line if it's short; otherwise at least the
  // longest single word (so no word breaks across lines).
  const target = (label.length <= 24 ? full : longestWord) + PAD
  const minW = Math.ceil(target / frac)
  const finalW = Math.max(width, minW)
  // Excalidraw auto-grows a container whose bound text wraps — predict the
  // wrapped height NOW so the skeleton matches what actually renders (a box
  // that silently grows at render time eats the gap below it).
  const lines = Math.max(1, Math.ceil(full / Math.max(1, finalW * frac - PAD)))
  const minH = Math.ceil((lines * fontSize * 1.4 + PAD) / (type === 'rectangle' ? 1 : 0.7))
  return { width: finalW, height: Math.max(height, minH) }
}

// ── arrow routing: avoid stabbing shapes the arrow doesn't connect ───────────
function ccw(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax)
}
function segSeg(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number
) {
  return (
    ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) &&
    ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy)
  )
}
// Does segment a-b pass through box `o` (shrunk a bit so edge-grazing is fine)?
function segHitsBox(ax: number, ay: number, bx: number, by: number, o: Bounds): boolean {
  const sx = o.x + o.width * 0.12
  const sy = o.y + o.height * 0.12
  const sw = o.width * 0.76
  const sh = o.height * 0.76
  const inside = (x: number, y: number) => x >= sx && x <= sx + sw && y >= sy && y <= sy + sh
  if (inside(ax, ay) || inside(bx, by)) return false // touches it — structural, not a stab
  const x2 = sx + sw
  const y2 = sy + sh
  return (
    segSeg(ax, ay, bx, by, sx, sy, x2, sy) ||
    segSeg(ax, ay, bx, by, x2, sy, x2, y2) ||
    segSeg(ax, ay, bx, by, x2, y2, sx, y2) ||
    segSeg(ax, ay, bx, by, sx, y2, sx, sy)
  )
}

// Point at fraction `t` of a polyline's arc length, plus the local normal —
// used to slide an arrow label along its arrow hunting for clear space.
function pathPointAt(
  path: { x: number; y: number }[],
  t: number
): { x: number; y: number; nx: number; ny: number } {
  const lens: number[] = []
  let total = 0
  for (let i = 0; i + 1 < path.length; i++) {
    const l = Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y)
    lens.push(l)
    total += l
  }
  let d = t * total
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i] || i === lens.length - 1) {
      const r = lens[i] ? d / lens[i] : 0
      const p = path[i]
      const q = path[i + 1]
      const len = lens[i] || 1
      const dx = q.x - p.x
      const dy = q.y - p.y
      return { x: p.x + dx * r, y: p.y + dy * r, nx: -dy / len, ny: dx / len }
    }
    d -= lens[i]
  }
  return { x: path[0].x, y: path[0].y, nx: 0, ny: -1 }
}

function rectsHit(a: Bounds, b: Bounds, pad = 6): boolean {
  return (
    a.x - pad < b.x + b.width && a.x + a.width + pad > b.x &&
    a.y - pad < b.y + b.height && a.y + a.height + pad > b.y
  )
}

/**
 * Route an arrow from `a` to `b`. If the straight line stabs any obstacle
 * (a shape it doesn't connect), return an ELBOW path that arcs above or below
 * the obstacles instead — e.g. a long-range arrow across a row of boxes hops
 * over the row rather than striking through it. O(obstacles) per arrow.
 */
function routeArrow(
  a: { x: number; y: number },
  b: { x: number; y: number },
  fromB: Bounds | undefined,
  toB: Bounds | undefined,
  obstacles: Bounds[]
): { x: number; y: number }[] {
  const hit = obstacles.filter((o) => segHitsBox(a.x, a.y, b.x, b.y, o))
  if (hit.length === 0) return [a, b]
  const CLR = 30
  // Detour axis depends on the arrow's orientation: a mostly-HORIZONTAL arrow
  // hops over/under the obstacles; a mostly-VERTICAL one (stacked boxes) must
  // hop LEFT/RIGHT instead — an up/down detour would collapse back onto the
  // same line it's trying to escape.
  if (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) {
    const fromTop = fromB ? fromB.y : a.y
    const toTop = toB ? toB.y : b.y
    const fromBot = fromB ? fromB.y + fromB.height : a.y
    const toBot = toB ? toB.y + toB.height : b.y
    const topY = Math.min(...hit.map((o) => o.y), fromTop, toTop) - CLR
    const botY = Math.max(...hit.map((o) => o.y + o.height), fromBot, toBot) + CLR
    const midY = (a.y + b.y) / 2
    const cy = Math.abs(midY - topY) <= Math.abs(botY - midY) ? topY : botY
    const a2 = fromB ? edgePoint(fromB, { x: centerOf(fromB).x, y: cy }, 6) : a
    const b2 = toB ? edgePoint(toB, { x: centerOf(toB).x, y: cy }, 6) : b
    return [a2, { x: a2.x, y: cy }, { x: b2.x, y: cy }, b2]
  }
  const fromL = fromB ? fromB.x : a.x
  const toL = toB ? toB.x : b.x
  const fromR = fromB ? fromB.x + fromB.width : a.x
  const toR = toB ? toB.x + toB.width : b.x
  const leftX = Math.min(...hit.map((o) => o.x), fromL, toL) - CLR
  const rightX = Math.max(...hit.map((o) => o.x + o.width), fromR, toR) + CLR
  const midX = (a.x + b.x) / 2
  const cx = Math.abs(midX - leftX) <= Math.abs(rightX - midX) ? leftX : rightX
  const a2 = fromB ? edgePoint(fromB, { x: cx, y: centerOf(fromB).y }, 6) : a
  const b2 = toB ? edgePoint(toB, { x: cx, y: centerOf(toB).y }, 6) : b
  return [a2, { x: cx, y: a2.y }, { x: cx, y: b2.y }, b2]
}

// Big "region" containers (clusters, spaces, zones) hold other shapes, so their
// label must act as a HEADER at the top — Excalidraw's default centered label
// would land exactly where the contents are.
const REGION_MIN_H = 150

// Deterministic z-order, independent of the order the model emitted shapes:
// closed shapes big→small (a container can never cover its contents), then
// images (math), then connectors, then standalone text always on top.
const Z_GROUP: Record<string, number> = {
  rectangle: 0, ellipse: 0, diamond: 0,
  image: 1,
  line: 2, arrow: 2,
  text: 3,
}

function depthSort(skeletons: Skeleton[]): Skeleton[] {
  return skeletons
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ga = Z_GROUP[a.s.type] ?? 1
      const gb = Z_GROUP[b.s.type] ?? 1
      if (ga !== gb) return ga - gb
      if (ga === 0) {
        const areaA = (a.s.width ?? 0) * (a.s.height ?? 0)
        const areaB = (b.s.width ?? 0) * (b.s.height ?? 0)
        if (areaA !== areaB) return areaB - areaA // bigger drawn first = behind
      }
      return a.i - b.i // stable within a group
    })
    .map((x) => x.s)
}

function commonStyle(shape: AgentShape): Skeleton {
  const s: Skeleton = {}
  if (shape.strokeColor) s.strokeColor = shape.strokeColor
  if (shape.backgroundColor) s.backgroundColor = shape.backgroundColor
  if (shape.fillStyle) s.fillStyle = shape.fillStyle
  return s
}

/**
 * Build Excalidraw element skeletons from the agent's shapes.
 *
 * Arrows can reference either:
 *  - another agent shape (in `shapes`) → bound by skeleton id (Excalidraw routes it)
 *  - a pre-existing canvas shape (in `externalBounds`) → connected by computed
 *    geometry (visually points at it, no live re-routing)
 */
export function buildSkeletons(
  shapes: Map<string, AgentShape>,
  externalBounds: Map<string, Bounds>
): Skeleton[] {
  // ── effective bounds: what each shape will ACTUALLY occupy when rendered ──
  // (fitted container sizes with wrapped labels, measured text) — every later
  // step (arrows, obstacles, labels, occupancy) works from these, so planner
  // dims and rendered dims can't drift apart.
  const CLOSED = new Set(['rectangle', 'ellipse', 'diamond'])
  const eff = new Map<string, Bounds>()
  const fittedDims = new Map<string, { width: number; height: number }>()
  for (const s of shapes.values()) {
    if (!s.id || !s.type) continue
    if (CLOSED.has(s.type)) {
      const f = s.text
        ? fitLabelledContainer(s.type as any, fixCanvasGlyphs(s.text), s.width ?? DEFAULT_W, s.height ?? DEFAULT_H)
        : { width: s.width ?? DEFAULT_W, height: s.height ?? DEFAULT_H }
      fittedDims.set(s.id, f)
      eff.set(s.id, { x: s.x ?? 0, y: s.y ?? 0, width: f.width, height: f.height })
    } else if (s.type === 'text') {
      const fs = s.fontSize ?? 20
      const tlines = String(s.text ?? '').split('\n').length
      eff.set(s.id, {
        x: s.x ?? 0, y: s.y ?? 0,
        width: measureTextWidth(s.text ?? '', fs),
        height: tlines * fs * 1.3,
      })
    } else if (s.type === 'math') {
      eff.set(s.id, agentBounds(s))
    }
  }

  // ── vertical overlap relief ───────────────────────────────────────────────
  // Auto-grown boxes eat the gaps the planner left below them, crushing arrow
  // corridors to nothing. Restore breathing room by INSERTING vertical space
  // (everything below the squeezed line shifts down together — layout shape is
  // preserved). Skipped when the board uses region containers, whose nesting
  // an insert would break.
  const closed = [...shapes.values()].filter((s) => s.id && CLOSED.has(s.type ?? ''))
  const containsBox = (a: Bounds, b: Bounds) =>
    b.x >= a.x - 4 && b.y >= a.y - 4 &&
    b.x + b.width <= a.x + a.width + 4 && b.y + b.height <= a.y + a.height + 4
  const hasRegions = closed.some((a) =>
    closed.some((b) => a.id !== b.id && containsBox(eff.get(a.id!)!, eff.get(b.id!)!))
  )
  if (!hasRegions && closed.length > 1) {
    // Enough room for an arrow AND its midpoint label between stacked boxes.
    const MIN_GAP = 46
    const order = closed
      .map((s) => eff.get(s.id!)!)
      .sort((p, q) => p.y - q.y)
    const placed: Bounds[] = []
    for (const box of order) {
      let needTop = -Infinity
      for (const p of placed) {
        const xOverlap = Math.min(box.x + box.width, p.x + p.width) - Math.max(box.x, p.x)
        if (xOverlap > 0.3 * Math.min(box.width, p.width)) {
          needTop = Math.max(needTop, p.y + p.height + MIN_GAP)
        }
      }
      const shift = needTop - box.y
      if (shift > 0) {
        // insert space: every not-yet-placed element at/below this line moves
        const line = box.y - 0.5
        for (const e of eff.values()) {
          if (e !== box && placed.includes(e)) continue
          if (e.y >= line) e.y += shift
        }
      }
      placed.push(box)
    }
  }

  const boundsOf = (id?: string): Bounds | undefined => {
    if (!id) return undefined
    const b = eff.get(id)
    if (b) return b
    // connectors (lines) aren't in eff — arrows may still bind to them
    const s = shapes.get(id)
    if (s) return agentBounds(s)
    return externalBounds.get(id)
  }

  // Solid shapes an arrow must not stab: everything except itself and the two
  // shapes it connects. (Endpoint-inside cases are exempted by segHitsBox.)
  const obstaclesFor = (arrow: AgentShape): Bounds[] => {
    const out: Bounds[] = []
    for (const other of shapes.values()) {
      if (other.id === arrow.id || other.id === arrow.fromId || other.id === arrow.toId) continue
      if (CLOSED.has(other.type ?? '') || other.type === 'math') {
        const b = other.id ? eff.get(other.id) : undefined
        if (b) out.push(b)
      }
    }
    return out
  }

  const skeletons: Skeleton[] = []
  const occupied: Bounds[] = [] // space solid shapes/text take up (labels dodge it)
  const placedLabels: Bounds[] = [] // arrow-label rects committed so far

  // Pass 1: solid shapes and text — connectors wait so their labels can dodge
  // everything already on the board.
  for (const shape of shapes.values()) {
    if (!shape.id || !shape.type) continue
    if (shape.type === 'arrow' || shape.type === 'line') continue

    switch (shape.type) {
      case 'rectangle':
      case 'ellipse':
      case 'diamond': {
        const box = eff.get(shape.id)!
        const fitted = fittedDims.get(shape.id)!
        skeletons.push({
          type: shape.type,
          id: shape.id,
          x: box.x,
          y: box.y,
          width: fitted.width,
          height: fitted.height,
          ...(shape.text
            ? {
                label: {
                  text: fixCanvasGlyphs(shape.text),
                  // Region-sized containers get a top header, not a centered
                  // label buried under their contents.
                  ...(fitted.height >= REGION_MIN_H ? { verticalAlign: 'top' } : {}),
                },
              }
            : {}),
          ...commonStyle(shape),
        })
        occupied.push(box)
        break
      }

      case 'text': {
        const tb = eff.get(shape.id)!
        skeletons.push({
          type: 'text',
          id: shape.id,
          x: tb.x,
          y: tb.y,
          text: fixCanvasGlyphs(shape.text ?? ''),
          ...(shape.fontSize ? { fontSize: shape.fontSize } : {}),
          ...(shape.strokeColor ? { strokeColor: shape.strokeColor } : {}),
        })
        occupied.push(tb)
        break
      }

      case 'math': {
        // Only renderable once the client has rasterized the LaTeX to a file.
        if (!shape.fileId) break
        const mb = eff.get(shape.id)!
        skeletons.push({
          type: 'image',
          id: shape.id,
          x: mb.x,
          y: mb.y,
          width: shape.width ?? DEFAULT_W,
          height: shape.height ?? DEFAULT_H,
          fileId: shape.fileId,
          status: 'saved',
          // Carry the LaTeX so the agent can read its own equations on review.
          customData: { latex: shape.latex ?? shape.text ?? '' },
        })
        occupied.push(mb)
        break
      }
    }
  }

  // Arrows sharing the SAME shape pair (e.g. SYN / SYN-ACK / ACK between one
  // client and one server) would collapse onto one identical line — count them
  // so parallel arrows fan out into separate lanes instead of overprinting.
  const pairKey = (s: AgentShape) =>
    s.type === 'arrow' && s.fromId && s.toId ? [s.fromId, s.toId].sort().join('|') : ''
  const pairCount = new Map<string, number>()
  const pairSeen = new Map<string, number>()
  for (const s of shapes.values()) {
    const k = pairKey(s)
    if (k) pairCount.set(k, (pairCount.get(k) ?? 0) + 1)
  }

  // Pass 2: connectors — routed around obstacles, labels placed in clear space.
  for (const shape of shapes.values()) {
    if (!shape.id || !shape.type) continue
    if (shape.type === 'arrow' || shape.type === 'line') {
        const sk: Skeleton = {
          type: shape.type,
          id: shape.id,
          ...commonStyle(shape),
        }

        const fromB = boundsOf(shape.fromId)
        const toB = boundsOf(shape.toId)

        if (shape.type === 'arrow' && (fromB || toB)) {
          // Clip each bound endpoint to its shape's border (+gap) so the arrow
          // runs edge-to-edge through the EMPTY space between shapes, never
          // through their interiors or centered labels. A bound endpoint uses the
          // OTHER endpoint's center as its aim; an unbound endpoint stays at the
          // resolved center.
          const GAP = 6
          const ca = fromB ? centerOf(fromB) : centerOf(toB!)
          const cb = toB ? centerOf(toB) : centerOf(fromB!)
          let a = fromB ? edgePoint(fromB, cb, GAP) : ca
          let b = toB ? edgePoint(toB, ca, GAP) : cb
          // Parallel arrows between the same two shapes get translated into
          // distinct lanes (perpendicular offsets), so SYN / SYN-ACK / ACK
          // between one client and one server don't overprint into one line.
          const k = pairKey(shape)
          const n = k ? pairCount.get(k) ?? 1 : 1
          if (n > 1 && fromB && toB) {
            const idx = pairSeen.get(k) ?? 0
            pairSeen.set(k, idx + 1)
            const dx = cb.x - ca.x
            const dy = cb.y - ca.y
            const len = Math.hypot(dx, dy) || 1
            // don't slide endpoints past the shapes' facing edges
            const extent = (bb: Bounds) =>
              Math.abs(dx) >= Math.abs(dy) ? bb.height : bb.width
            const lim = Math.max(14, Math.min(extent(fromB), extent(toB)) / 2 - 6)
            const off = Math.max(-lim, Math.min(lim, (idx - (n - 1) / 2) * 54))
            const px = (-dy / len) * off
            const py = (dx / len) * off
            a = { x: a.x + px, y: a.y + py }
            b = { x: b.x + px, y: b.y + py }
          }
          // Everything solid this arrow does NOT connect is an obstacle; if the
          // straight line stabs one, hop over/under it with an elbow path.
          const path = routeArrow(a, b, fromB, toB, obstaclesFor(shape))
          const p0 = path[0]
          sk.x = p0.x
          sk.y = p0.y
          sk.points = path.map((p) => [p.x - p0.x, p.y - p0.y])
          // Excalidraw can only BIND arrows to closed shapes / text — binding to
          // a line or arrow throws and nukes the whole batch. For non-bindable
          // targets we keep the computed geometry (the arrow still points at
          // them) but don't create a live binding.
          const bindable = (id?: string): boolean => {
            const s = id ? shapes.get(id) : undefined
            return (
              !!s &&
              (s.type === 'rectangle' || s.type === 'ellipse' || s.type === 'diamond' || s.type === 'text')
            )
          }
          if (bindable(shape.fromId)) sk.start = { id: shape.fromId }
          if (bindable(shape.toId)) sk.end = { id: shape.toId }
        } else {
          sk.x = shape.x ?? 0
          sk.y = shape.y ?? 0
          if (shape.points && shape.points.length >= 2) {
            sk.points = shape.points
          } else {
            const w = shape.width ?? 100
            const h = shape.height ?? 0
            sk.points = [
              [0, 0],
              [w, h],
            ]
          }
          // Raw-geometry ARROWS (no resolvable fromId/toId) used to bypass all
          // stab protection — a straight one can strike through half a row of
          // boxes. Give simple 2-point arrows the same obstacle avoidance.
          // Plain `line`s are left alone (axes/dividers cross things on purpose).
          if (shape.type === 'arrow' && sk.points.length === 2) {
            const a = { x: sk.x + sk.points[0][0], y: sk.y + sk.points[0][1] }
            const b = { x: sk.x + sk.points[1][0], y: sk.y + sk.points[1][1] }
            const path = routeArrow(a, b, undefined, undefined, obstaclesFor(shape))
            if (path.length > 2) {
              sk.x = path[0].x
              sk.y = path[0].y
              sk.points = path.map((p) => [p.x - path[0].x, p.y - path[0].y])
            }
          }
        }

        // Arrow label: keep Excalidraw's native midpoint label ONLY when that
        // spot is provably clear. Otherwise place the text as a standalone
        // element at the first collision-free position along the arrow —
        // converging arrows can no longer pile labels on each other or have
        // them sliced by shapes they happen to cross.
        if (shape.type === 'arrow' && shape.text) {
          const text = fixCanvasGlyphs(shape.text)
          const FS = 16
          const w = measureTextWidth(text, FS)
          const h = FS * 1.4
          const pathAbs = (sk.points as number[][]).map((p) => ({ x: sk.x + p[0], y: sk.y + p[1] }))
          const rectAt = (cx: number, cy: number): Bounds => ({
            x: cx - w / 2, y: cy - h / 2, width: w, height: h,
          })
          const isClear = (r: Bounds) =>
            !occupied.some((o) => rectsHit(r, o)) && !placedLabels.some((o) => rectsHit(r, o, 4))
          const mid = pathPointAt(pathAbs, 0.5)
          const midRect = rectAt(mid.x, mid.y)
          // Excalidraw WRAPS a bound label to the arrow's width — on a short
          // arrow that turns one line into a tall word-stack that overflows
          // its corridor. Short arrows always get a standalone label instead.
          let pathLen = 0
          for (let i = 0; i + 1 < pathAbs.length; i++) {
            pathLen += Math.hypot(pathAbs[i + 1].x - pathAbs[i].x, pathAbs[i + 1].y - pathAbs[i].y)
          }
          const canBind = pathLen >= w + 24
          if (canBind && isClear(midRect)) {
            sk.label = { text, fontSize: FS }
            placedLabels.push(midRect)
          } else {
            let placed = false
            for (const tp of [0.5, 0.35, 0.65, 0.25, 0.75]) {
              const p = pathPointAt(pathAbs, tp)
              for (const off of [26, -26, 40, -40, w / 2 + 14, -(w / 2 + 14)]) {
                const r = rectAt(p.x + p.nx * off, p.y + p.ny * off)
                if (isClear(r)) {
                  skeletons.push({
                    type: 'text',
                    id: `${shape.id}-lbl`,
                    x: r.x,
                    y: r.y,
                    text,
                    fontSize: FS,
                    ...(shape.strokeColor ? { strokeColor: shape.strokeColor } : {}),
                    // Lets the reveal logic fade this label in with its arrow.
                    customData: { labelOf: shape.id },
                  })
                  placedLabels.push(r)
                  placed = true
                  break
                }
              }
              if (placed) break
            }
            if (!placed) {
              // Everywhere is crowded. Long arrows fall back to the native
              // bound label; short arrows still get standalone text (bound
              // would wrap into a word-stack) — the detector takes it from here.
              if (canBind) {
                sk.label = { text, fontSize: FS }
              } else {
                skeletons.push({
                  type: 'text', id: `${shape.id}-lbl`, x: midRect.x, y: midRect.y, text,
                  fontSize: FS,
                  ...(shape.strokeColor ? { strokeColor: shape.strokeColor } : {}),
                  customData: { labelOf: shape.id },
                })
                placedLabels.push(midRect)
              }
            }
          }
        }
        skeletons.push(sk)
    }
  }

  return skeletons
}

/**
 * Convert agent shapes into real Excalidraw elements, keeping our stable ids.
 * Returns [] if conversion fails (e.g. a partial/invalid skeleton).
 */
export function shapesToElements(
  shapes: Map<string, AgentShape>,
  externalBounds: Map<string, Bounds>
): ExcalidrawElement[] {
  const skeletons = depthSort(buildSkeletons(shapes, externalBounds))
  if (skeletons.length === 0) return []
  try {
    return convertToExcalidrawElements(skeletons as any, {
      regenerateIds: false,
    }) as ExcalidrawElement[]
  } catch (err) {
    // Never fail silently — a swallowed throw here renders an entire batch as
    // NOTHING, which is far worse than a messy drawing.
    console.error('shapesToElements: conversion threw, retrying without bindings', err)
    // Degrade gracefully: drop live arrow bindings (the usual thrower) and
    // retry, so at worst arrows lose re-routing, not the whole scene.
    try {
      const stripped = skeletons.map((s) => {
        const { start, end, ...rest } = s
        return rest
      })
      return convertToExcalidrawElements(stripped as any, {
        regenerateIds: false,
      }) as ExcalidrawElement[]
    } catch (err2) {
      console.error('shapesToElements: retry failed too', err2)
      return []
    }
  }
}
