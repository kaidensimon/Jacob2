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
  labelOf?: string // relocated arrow label — belongs to this arrow
}

interface ShapeItem {
  id: string
  type: string
  label?: string
  x: number
  y: number
  w: number
  h: number
}

interface Seg {
  id: string
  label?: string
  pts: [number, number][] // absolute polyline (arrows may be elbow-routed)
  ax: number // first point (kept for endpoint checks)
  ay: number
  bx: number // last point
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
const TEXT_PAD = 14 // text needs breathing room (also catches cramped labels)

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

type Box = { x: number; y: number; w: number; h: number }

// A detected readability problem. The detector reports WHAT is wrong and, for a
// move, which element is actionable + where it currently sits — but it does NOT
// decide WHERE to move it. Choosing the destination is the agent's job.
// Coordinates are absolute scene coords (the caller converts to relative).
export interface DetectedIssue {
  rank: number
  desc: string
  moveId?: string // the element that can be moved to resolve this (by id)
  moveBox?: Box // its current bounds (a fact, not a suggested destination)
  resizeId?: string // a container whose label overflows it (agent picks the size)
}

/**
 * Returns the overlaps that hurt readability, each identifying WHAT is wrong (and
 * which element is actionable) — but NOT a computed fix location:
 *  - text overlapping other text (including bound labels)
 *  - text sitting on top of an arrow/line
 *  - an arrow/line passing through a shape it doesn't connect
 *  - text or a shape sitting on top of a pasted image
 * Nested/overlapping shapes are intentionally NOT reported.
 */
export function detectIssues(elements: readonly any[]): DetectedIssue[] {
  const texts: TextItem[] = []
  const shapes: ShapeItem[] = []
  const segs: Seg[] = []
  const images: ImgItem[] = []

  for (const e of elements) {
    if (e.isDeleted) continue
    if (e.type === 'image') {
      const isMath = String((e as any).fileId ?? '').startsWith('math-')
      if (isMath) {
        // The agent's own typeset-math image. Treat it like a text block so
        // collisions with other equations/labels are caught — but DON'T add it to
        // the "protected image" list, so a header above or a background box
        // behind it stays allowed.
        const latex = (e as any).customData?.latex
        texts.push({
          id: e.id,
          label: typeof latex === 'string' && latex ? `equation ${short(latex)}` : 'an equation',
          x: e.x,
          y: e.y,
          w: Math.max(1, e.width),
          h: Math.max(1, e.height),
          cx: e.x + e.width / 2,
          cy: e.y + e.height / 2,
        })
      } else {
        images.push({ id: e.id, x: e.x, y: e.y, w: Math.max(1, e.width), h: Math.max(1, e.height) })
      }
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
        labelOf: (e as any).customData?.labelOf || undefined,
      })
    } else if (SHAPE_TYPES.has(e.type)) {
      shapes.push({
        id: e.id,
        type: e.type,
        label: typeof e.text === 'string' && e.text ? e.text : undefined,
        x: e.x,
        y: e.y,
        w: e.width,
        h: e.height,
      })
    } else if ((e.type === 'arrow' || e.type === 'line') && Array.isArray(e.points) && e.points.length >= 2) {
      const pts = e.points.map((p: number[]) => [e.x + p[0], e.y + p[1]] as [number, number])
      const boundIds = new Set<string>()
      if (e.startBinding?.elementId) boundIds.add(e.startBinding.elementId)
      if (e.endBinding?.elementId) boundIds.add(e.endBinding.elementId)
      segs.push({
        id: e.id,
        label: typeof e.text === 'string' && e.text ? e.text : undefined,
        pts,
        ax: pts[0][0],
        ay: pts[0][1],
        bx: pts[pts.length - 1][0],
        by: pts[pts.length - 1][1],
        boundIds,
      })
    }
  }

  const found: DetectedIssue[] = []

  // Names for texts that are actually ARROW labels — the fixer can't move a
  // bound label directly, so tell it which arrow owns the text.
  const segIds = new Set(segs.map((s) => s.id))
  const nme = (t: TextItem) =>
    t.containerId && segIds.has(t.containerId)
      ? `${nmeText(t)} (the label of arrow ${t.containerId})`
      : nmeText(t)

  const shapeBoxById = new Map<string, Box>()
  for (const s of shapes) shapeBoxById.set(s.id, { x: s.x, y: s.y, w: s.w, h: s.h })
  // The agent can only move things it owns by id. A bound LABEL isn't its own
  // agent-shape — moving its CONTAINER is what relocates it — so resolve a text
  // to the id/box the agent can actually act on.
  const movable = (t: TextItem): { id: string; box: Box } => {
    if (t.containerId && shapeBoxById.has(t.containerId)) {
      return { id: t.containerId, box: shapeBoxById.get(t.containerId)! }
    }
    return { id: t.id, box: { x: t.x, y: t.y, w: t.w, h: t.h } }
  }

  // 1. Text vs text (labels colliding) — the most jarring problem.
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]
      const b = texts[j]
      if (a.containerId && a.containerId === b.containerId) continue // same container
      // A standalone text near a CONTAINER's bound label: the container border
      // sits between them visually, so padding-only proximity isn't a clump.
      // Only flag if the standalone text actually touches the container box.
      const bound =
        a.containerId && shapeBoxById.has(a.containerId) ? a :
        b.containerId && shapeBoxById.has(b.containerId) ? b : null
      if (bound) {
        const other = bound === a ? b : a
        if (!other.containerId) {
          const box = shapeBoxById.get(bound.containerId!)!
          if (!rectsOverlap(other.x, other.y, other.w, other.h, box.x, box.y, box.w, box.h)) continue
        }
      }
      if (textBoxesOverlap(a, b)) {
        // Move the more free-floating of the two (prefer a standalone label over
        // one bound inside a container).
        const pick = a.containerId && !b.containerId ? b : a
        const m = movable(pick)
        found.push({
          rank: 1000,
          desc: `${nme(a)} overlaps ${nme(b)}`,
          moveId: m.id,
          moveBox: m.box,
        })
      }
    }
  }

  // 2. Text sitting on an arrow/line (not that line's own label).
  for (const t of texts) {
    for (const s of segs) {
      if (t.containerId === s.id || t.labelOf === s.id) continue // the arrow's own label
      let d = Infinity
      for (let k = 0; k + 1 < s.pts.length; k++) {
        d = Math.min(d, pointSegDist(t.cx, t.cy, s.pts[k][0], s.pts[k][1], s.pts[k + 1][0], s.pts[k + 1][1]))
      }
      if (d < t.h / 2 + 8) {
        const m = movable(t)
        found.push({
          rank: 900,
          desc: `${nme(t)} is sitting on top of arrow/line ${s.id}`,
          moveId: m.id,
          moveBox: m.box,
        })
      }
    }
  }

  // 3. Arrow/line passing through a shape it does not connect. (No move
  //    suggestion — the right fix is usually to re-route/shorten the arrow.)
  for (const s of segs) {
    for (const sh of shapes) {
      if (s.boundIds.has(sh.id)) continue // it connects this shape — fine
      if (sh.w < 2 || sh.h < 2) continue
      // An arrow with an endpoint INSIDE a shape isn't stabbing it — it either
      // connects something within the container or enters/exits it, both
      // structural. True stabbing = both endpoints outside, segment through it.
      const inside = (x: number, y: number) =>
        x >= sh.x && x <= sh.x + sh.w && y >= sh.y && y <= sh.y + sh.h
      if (inside(s.ax, s.ay) || inside(s.bx, s.by)) continue
      // shrink the shape a touch so an arrow just grazing an edge isn't flagged
      const box = { x: sh.x + sh.w * 0.1, y: sh.y + sh.h * 0.1, w: sh.w * 0.8, h: sh.h * 0.8 }
      // trace the REAL polyline (elbow-routed arrows are not straight chords)
      let hits = false
      for (let k = 0; k + 1 < s.pts.length && !hits; k++) {
        hits = segIntersectsBox(s.pts[k][0], s.pts[k][1], s.pts[k + 1][0], s.pts[k + 1][1], box)
      }
      if (hits) {
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
        const m = movable(t)
        found.push({
          rank: 950,
          desc: `${nmeText(t)} is on top of image ${img.id}`,
          moveId: m.id,
          moveBox: m.box,
        })
      }
    }
    // a shape meaningfully covering the image
    for (const sh of shapes) {
      const area = overlapArea(sh.x, sh.y, sh.w, sh.h, img.x, img.y, img.w, img.h)
      if (area > 0 && area / Math.min(Math.max(1, sh.w * sh.h), imgArea) >= 0.15) {
        const box = shapeBoxById.get(sh.id)
        found.push({
          rank: 850,
          desc: `${nmeShape(sh)} overlaps image ${img.id}`,
          moveId: sh.id,
          moveBox: box,
        })
      }
    }
  }

  // 5. Two closed shapes PARTIALLY overlapping — neither contains the other,
  //    so it's a collision, not nesting. Almost always sloppy layout.
  //    Ellipse-ellipse pairs are exempt: Venn diagrams overlap on purpose.
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i]
      const b = shapes[j]
      if (a.type === 'ellipse' && b.type === 'ellipse') continue
      const area = overlapArea(a.x, a.y, a.w, a.h, b.x, b.y, b.w, b.h)
      if (area === 0) continue
      const smaller = a.w * a.h <= b.w * b.h ? a : b
      const bigger = smaller === a ? b : a
      const P = 6 // tolerance: "basically inside" counts as containment
      const contained =
        smaller.x >= bigger.x - P && smaller.y >= bigger.y - P &&
        smaller.x + smaller.w <= bigger.x + bigger.w + P &&
        smaller.y + smaller.h <= bigger.y + bigger.h + P
      if (contained) continue
      if (area / Math.max(1, smaller.w * smaller.h) > 0.08) {
        found.push({
          rank: 850,
          desc: `${nmeShape(a)} and ${nmeShape(b)} partially overlap — collision, not nesting`,
          moveId: smaller.id,
          moveBox: { x: smaller.x, y: smaller.y, w: smaller.w, h: smaller.h },
        })
      }
    }
  }

  // 6. Standalone text (incl. equations) CROSSING a shape's border — half in,
  //    half out, so the stroke slices through the words, or the text spills out
  //    of the box it was meant to sit in, or a shape sits on top of a label.
  //    Text FULLY INSIDE a shape (a caption within a region) is intentional.
  for (const t of texts) {
    if (t.containerId) continue // bound labels are the container's problem
    const tArea = Math.max(1, t.w * t.h)
    for (const sh of shapes) {
      const area = overlapArea(t.x, t.y, t.w, t.h, sh.x, sh.y, sh.w, sh.h)
      if (area <= tArea * 0.08) continue // barely grazing — ignore
      const P = 6
      const fullyInside =
        t.x >= sh.x + P && t.y >= sh.y + P &&
        t.x + t.w <= sh.x + sh.w - P && t.y + t.h <= sh.y + sh.h - P
      if (fullyInside) continue
      found.push({
        rank: 750,
        desc: `${nmeText(t)} crosses the border of ${nmeShape(sh)} — it gets clipped/covered`,
        moveId: t.id,
        moveBox: { x: t.x, y: t.y, w: t.w, h: t.h },
      })
    }
  }

  // 7. A container's BOUND LABEL colliding with a DIFFERENT shape — e.g. a
  //    diamond's label spilling past its slanted edges into a neighbouring box.
  //    (The border-crossing check above skips bound labels, so without this the
  //    spill is invisible and the cleanup loop honestly reports "clean".)
  for (const t of texts) {
    if (!t.containerId) continue
    const isShapeLabel = shapeBoxById.has(t.containerId)
    const isArrowLabel = segIds.has(t.containerId)
    if (!isShapeLabel && !isArrowLabel) continue
    const tArea = Math.max(1, t.w * t.h)
    for (const sh of shapes) {
      if (sh.id === t.containerId) continue // its own container
      const area = overlapArea(t.x, t.y, t.w, t.h, sh.x, sh.y, sh.w, sh.h)
      if (area <= tArea * 0.08) continue
      const P = 6
      const fullyInside =
        t.x >= sh.x + P && t.y >= sh.y + P &&
        t.x + t.w <= sh.x + sh.w - P && t.y + t.h <= sh.y + sh.h - P
      if (fullyInside) continue // nested container's label inside a region — fine
      found.push({
        rank: 780,
        desc:
          `the label ${nmeText(t)} of ${isArrowLabel ? 'arrow ' : ''}${t.containerId} ` +
          `spills onto ${nmeShape(sh)} — move them apart or shorten the label`,
        moveId: t.containerId,
        ...(isShapeLabel ? { moveBox: shapeBoxById.get(t.containerId) } : {}),
      })
    }
  }

  // 8. A bound label that doesn't fit its container — text cut off / overflowing.
  //    Excalidraw wraps bound text to the container width, so a label whose
  //    measured box is WIDER than its container has an unwrappable token spilling
  //    out (or the box was made far too small). We report the mismatch (with the
  //    measured sizes as facts); the agent decides how much to resize.
  for (const t of texts) {
    if (!t.containerId) continue
    const box = shapeBoxById.get(t.containerId)
    if (!box) continue
    const fitsW = t.w <= box.w
    const fitsH = t.h <= box.h + 2
    if (!fitsW || !fitsH) {
      found.push({
        rank: 700,
        desc:
          `${nmeText(t)} does not fit inside its container ${t.containerId} ` +
          `(label ≈ ${Math.round(t.w)}×${Math.round(t.h)}, box ${Math.round(box.w)}×${Math.round(box.h)}) ` +
          `— the text is cut off/overflowing`,
        resizeId: t.containerId,
      })
    }
  }

  found.sort((a, b) => b.rank - a.rank)
  return found.slice(0, 30)
}

/** Backward-compatible string list of the same issues (used for counts/logs). */
export function detectOverlaps(elements: readonly any[]): string[] {
  return detectIssues(elements).map((i) => i.desc)
}
