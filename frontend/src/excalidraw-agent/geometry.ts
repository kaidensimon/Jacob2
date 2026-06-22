// Geometry helpers ported from tldraw's agent architecture, adapted to Excalidraw.
//  - viewport bounds + a request "origin" so coordinates are sent to the model
//    relative to the viewport (small, consistent numbers it reasons about well)
//  - peripheral clustering of off-screen shapes (their greedy algorithm)
//  - deterministic layout math for align / distribute / stack actions

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Vec {
  x: number
  y: number
}

// ── Box utilities ─────────────────────────────────────────────────────────────

export function boxContains(a: Box, b: Box): boolean {
  return (
    a.x <= b.x &&
    a.y <= b.y &&
    a.x + a.w >= b.x + b.w &&
    a.y + a.h >= b.y + b.h
  )
}

export function boxUnion(a: Box, b: Box): Box {
  const minX = Math.min(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxX = Math.max(a.x + a.w, b.x + b.w)
  const maxY = Math.max(a.y + a.h, b.y + b.h)
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function boxExpandBy(a: Box, p: number): Box {
  return { x: a.x - p, y: a.y - p, w: a.w + 2 * p, h: a.h + 2 * p }
}

export function boxIntersects(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  )
}

export function roundBox(b: Box): Box {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    w: Math.round(b.w),
    h: Math.round(b.h),
  }
}

/** The union bounding box of a set of boxes, or null if empty. */
export function contentBounds(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null
  let r = boxes[0]
  for (let i = 1; i < boxes.length; i++) r = boxUnion(r, boxes[i])
  return r
}

// ── Viewport ─────────────────────────────────────────────────────────────────

/**
 * The visible region of the canvas in scene coordinates, derived from
 * Excalidraw's scroll/zoom state. This is the agent's "viewport".
 */
export function getViewportBounds(appState: any): Box {
  const zoom = appState.zoom?.value ?? 1
  const width = appState.width ?? window.innerWidth
  const height = appState.height ?? window.innerHeight
  return {
    x: -appState.scrollX,
    y: -appState.scrollY,
    w: width / zoom,
    h: height / zoom,
  }
}

// ── Peripheral clustering (ported from tldraw) ────────────────────────────────

export interface PeripheralCluster {
  bounds: Box
  count: number
}

/**
 * Group off-screen shapes into clusters by proximity, so the model knows what
 * exists outside its viewport without being flooded with detail. Direct port of
 * tldraw's convertTldrawShapesToPeripheralShapes greedy algorithm.
 */
export function clusterShapes(
  boxes: Box[],
  { padding = 75 }: { padding?: number } = {}
): PeripheralCluster[] {
  if (boxes.length === 0) return []

  const groups: { bounds: Box; count: number }[] = []
  const expanded = boxes.map((b) => boxExpandBy(b, padding))

  for (let i = 0; i < expanded.length; i++) {
    const bounds = expanded[i]
    if (i === 0) {
      groups.push({ bounds, count: 1 })
      continue
    }
    let didLand = false
    for (const group of groups) {
      if (boxContains(group.bounds, bounds) || boxIntersects(group.bounds, bounds)) {
        group.bounds = boxUnion(group.bounds, bounds)
        group.count++
        didLand = true
        break
      }
    }
    if (!didLand) groups.push({ bounds, count: 1 })
  }

  return groups.map((g) => ({ bounds: boxExpandBy(g.bounds, -padding), count: g.count }))
}

// ── Layout math for align / distribute / stack ────────────────────────────────

export type AlignEdge =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'center-horizontal'
  | 'center-vertical'

/** Return new top-left positions to align a set of boxes along an edge. */
export function alignBoxes(
  items: { id: string; box: Box }[],
  edge: AlignEdge
): Map<string, Vec> {
  const out = new Map<string, Vec>()
  if (items.length === 0) return out

  const minX = Math.min(...items.map((i) => i.box.x))
  const maxX = Math.max(...items.map((i) => i.box.x + i.box.w))
  const minY = Math.min(...items.map((i) => i.box.y))
  const maxY = Math.max(...items.map((i) => i.box.y + i.box.h))
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2

  for (const { id, box } of items) {
    let { x, y } = box
    switch (edge) {
      case 'left':
        x = minX
        break
      case 'right':
        x = maxX - box.w
        break
      case 'top':
        y = minY
        break
      case 'bottom':
        y = maxY - box.h
        break
      case 'center-horizontal':
        x = midX - box.w / 2
        break
      case 'center-vertical':
        y = midY - box.h / 2
        break
    }
    out.set(id, { x, y })
  }
  return out
}

/** Distribute boxes so the gaps between them along an axis are equal. */
export function distributeBoxes(
  items: { id: string; box: Box }[],
  axis: 'horizontal' | 'vertical'
): Map<string, Vec> {
  const out = new Map<string, Vec>()
  if (items.length < 3) return out

  const sorted = [...items].sort((a, b) =>
    axis === 'horizontal' ? a.box.x - b.box.x : a.box.y - b.box.y
  )

  const size = (b: Box) => (axis === 'horizontal' ? b.w : b.h)
  const start = (b: Box) => (axis === 'horizontal' ? b.x : b.y)

  const first = sorted[0].box
  const last = sorted[sorted.length - 1].box
  const span = start(last) + size(last) - start(first)
  const totalSize = sorted.reduce((s, i) => s + size(i.box), 0)
  const gap = (span - totalSize) / (sorted.length - 1)

  let cursor = start(first)
  for (const { id, box } of sorted) {
    const pos = cursor
    cursor += size(box) + gap
    out.set(id, axis === 'horizontal' ? { x: pos, y: box.y } : { x: box.x, y: pos })
  }
  return out
}

/** Stack boxes in a row/column with a fixed gap, starting from the first one. */
export function stackBoxes(
  items: { id: string; box: Box }[],
  axis: 'horizontal' | 'vertical',
  gap: number
): Map<string, Vec> {
  const out = new Map<string, Vec>()
  if (items.length === 0) return out

  const sorted = [...items].sort((a, b) =>
    axis === 'horizontal' ? a.box.x - b.box.x : a.box.y - b.box.y
  )

  const origin = sorted[0].box
  let cursor = axis === 'horizontal' ? origin.x : origin.y
  for (const { id, box } of sorted) {
    if (axis === 'horizontal') {
      out.set(id, { x: cursor, y: origin.y })
      cursor += box.w + gap
    } else {
      out.set(id, { x: origin.x, y: cursor })
      cursor += box.h + gap
    }
  }
  return out
}
