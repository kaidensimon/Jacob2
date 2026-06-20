// Deterministic "canvas linter" — finds the things that actually make a diagram
// unreadable: TEXT and ARROWS overlapping other content. It deliberately does
// NOT flag shapes nested inside other shapes (that's usually intentional —
// Venn diagrams, a boundary curve on a surface, containment, etc.).

interface TextItem {
  id: string
  label?: string
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
  containerId?: string
}

interface ShapeItem {
  id: string
  label?: string
  x: number
  y: number
  w: number
  h: number
}

interface Seg {
  id: string
  label?: string
  ax: number
  ay: number
  bx: number
  by: number
  boundIds: Set<string>
}

interface ImgItem {
  id: string
  x: number
  y: number
  w: number
  h: number
}

const SHAPE_TYPES = new Set(['rectangle', 'ellipse', 'diamond'])
const TEXT_PAD = 10 // text needs breathing room

function rectsOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number
) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by
}

function overlapArea(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number
) {
  const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx))
  const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by))
  return ix * iy
}

// ── segment / box geometry ────────────────────────────────────────────────────
function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const l2 = (ax - bx) ** 2 + (ay - by) ** 2
  if (l2 === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)))
}
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
function segIntersectsBox(
  ax: number, ay: number, bx: number, by: number,
  box: { x: number; y: number; w: number; h: number }
) {
  const inside = (x: number, y: number) =>
    x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h
  if (inside(ax, ay) || inside(bx, by)) return true
  const x2 = box.x + box.w
  const y2 = box.y + box.h
  return (
    segSeg(ax, ay, bx, by, box.x, box.y, x2, box.y) ||
    segSeg(ax, ay, bx, by, x2, box.y, x2, y2) ||
    segSeg(ax, ay, bx, by, x2, y2, box.x, y2) ||
    segSeg(ax, ay, bx, by, box.x, y2, box.x, box.y)
  )
}

function textBoxesOverlap(a: TextItem, b: TextItem) {
  return (
    a.x - TEXT_PAD < b.x + b.w + TEXT_PAD &&
    a.x + a.w + TEXT_PAD > b.x - TEXT_PAD &&
    a.y - TEXT_PAD < b.y + b.h + TEXT_PAD &&
    a.y + a.h + TEXT_PAD > b.y - TEXT_PAD
  )
}

const short = (s?: string) => (s ? s.replace(/\s+/g, ' ').slice(0, 28) : '')
const nmeText = (t: TextItem) => (t.label ? `"${short(t.label)}"` : `text ${t.id}`)
const nmeShape = (s: ShapeItem) => (s.label ? `${s.id} ("${short(s.label)}")` : s.id)

/**
 * Returns descriptions of the overlaps that hurt readability:
 *  - text overlapping other text (including bound labels)
 *  - text sitting on top of an arrow/line
 *  - an arrow/line passing through a shape it doesn't connect
 *  - text or a shape sitting on top of a pasted image
 * Nested/overlapping shapes are intentionally NOT reported.
 */
export function detectOverlaps(elements: readonly any[]): string[] {
  const texts: TextItem[] = []
  const shapes: ShapeItem[] = []
  const segs: Seg[] = []
  const images: ImgItem[] = []

  for (const e of elements) {
    if (e.isDeleted) continue
    if (e.type === 'image') {
      images.push({ id: e.id, x: e.x, y: e.y, w: Math.max(1, e.width), h: Math.max(1, e.height) })
    } else if (e.type === 'text') {
      texts.push({
        id: e.id,
        label: typeof e.text === 'string' ? e.text : undefined,
        x: e.x,
        y: e.y,
        w: Math.max(1, e.width),
        h: Math.max(1, e.height),
        cx: e.x + e.width / 2,
        cy: e.y + e.height / 2,
        containerId: e.containerId || undefined,
      })
    } else if (SHAPE_TYPES.has(e.type)) {
      shapes.push({
        id: e.id,
        label: typeof e.text === 'string' && e.text ? e.text : undefined,
        x: e.x,
        y: e.y,
        w: e.width,
        h: e.height,
      })
    } else if ((e.type === 'arrow' || e.type === 'line') && Array.isArray(e.points) && e.points.length >= 2) {
      const p0 = e.points[0]
      const pn = e.points[e.points.length - 1]
      const boundIds = new Set<string>()
      if (e.startBinding?.elementId) boundIds.add(e.startBinding.elementId)
      if (e.endBinding?.elementId) boundIds.add(e.endBinding.elementId)
      segs.push({
        id: e.id,
        label: typeof e.text === 'string' && e.text ? e.text : undefined,
        ax: e.x + p0[0],
        ay: e.y + p0[1],
        bx: e.x + pn[0],
        by: e.y + pn[1],
        boundIds,
      })
    }
  }

  const found: { rank: number; desc: string }[] = []

  // 1. Text vs text (labels colliding) — the most jarring problem.
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]
      const b = texts[j]
      if (a.containerId && a.containerId === b.containerId) continue // same container
      if (textBoxesOverlap(a, b)) {
        found.push({ rank: 1000, desc: `${nmeText(a)} overlaps ${nmeText(b)}` })
      }
    }
  }

  // 2. Text sitting on an arrow/line (not that line's own label).
  for (const t of texts) {
    for (const s of segs) {
      if (t.containerId === s.id) continue // it's the arrow's own label
      const d = pointSegDist(t.cx, t.cy, s.ax, s.ay, s.bx, s.by)
      if (d < t.h / 2 + 8) {
        found.push({ rank: 900, desc: `${nmeText(t)} is sitting on top of arrow/line ${s.id}` })
      }
    }
  }

  // 3. Arrow/line passing through a shape it does not connect.
  for (const s of segs) {
    for (const sh of shapes) {
      if (s.boundIds.has(sh.id)) continue // it connects this shape — fine
      if (sh.w < 2 || sh.h < 2) continue
      // shrink the shape a touch so an arrow just grazing an edge isn't flagged
      const box = { x: sh.x + sh.w * 0.1, y: sh.y + sh.h * 0.1, w: sh.w * 0.8, h: sh.h * 0.8 }
      if (segIntersectsBox(s.ax, s.ay, s.bx, s.by, box)) {
        found.push({ rank: 800, desc: `arrow/line ${s.id} passes through ${nmeShape(sh)}` })
      }
    }
  }

  // 4. Content sitting on top of a pasted image. Images are user content that
  //    shouldn't be covered — flag text/shapes overlapping them so the agent
  //    moves ITS OWN content clear of your images.
  for (const img of images) {
    const imgArea = img.w * img.h
    // text on image (with padding — text needs to clear the image)
    for (const t of texts) {
      if (rectsOverlap(t.x - TEXT_PAD, t.y - TEXT_PAD, t.w + 2 * TEXT_PAD, t.h + 2 * TEXT_PAD, img.x, img.y, img.w, img.h)) {
        found.push({ rank: 950, desc: `${nmeText(t)} is on top of image ${img.id}` })
      }
    }
    // a shape meaningfully covering the image
    for (const sh of shapes) {
      const area = overlapArea(sh.x, sh.y, sh.w, sh.h, img.x, img.y, img.w, img.h)
      if (area > 0 && area / Math.min(Math.max(1, sh.w * sh.h), imgArea) >= 0.15) {
        found.push({ rank: 850, desc: `${nmeShape(sh)} overlaps image ${img.id}` })
      }
    }
  }

  found.sort((a, b) => b.rank - a.rank)
  return found.slice(0, 30).map((f) => f.desc)
}
