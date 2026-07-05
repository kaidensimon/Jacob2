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
  // Fraction of the container's box that centered text can actually use.
  const frac = type === 'diamond' ? 0.55 : type === 'ellipse' ? 0.72 : 0.9
  // Fit the whole label on one line if it's short; otherwise at least the
  // longest single word (so no word breaks across lines).
  const target = (label.length <= 24 ? full : longestWord) + PAD
  const minW = Math.ceil(target / frac)
  const minH = Math.ceil((fontSize * 1.5 + PAD) / (type === 'rectangle' ? 1 : 0.7))
  return { width: Math.max(width, minW), height: Math.max(height, minH) }
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
  const fromTop = fromB ? fromB.y : a.y
  const toTop = toB ? toB.y : b.y
  const fromBot = fromB ? fromB.y + fromB.height : a.y
  const toBot = toB ? toB.y + toB.height : b.y
  const topY = Math.min(...hit.map((o) => o.y), fromTop, toTop) - CLR
  const botY = Math.max(...hit.map((o) => o.y + o.height), fromBot, toBot) + CLR
  // pick the side with the smaller detour from the straight line
  const midY = (a.y + b.y) / 2
  const cy = Math.abs(midY - topY) <= Math.abs(botY - midY) ? topY : botY
  // exit from the top/bottom edge of the endpoint shapes, straight up/down,
  // across at the clearance line, then into the target
  const a2 = fromB ? edgePoint(fromB, { x: centerOf(fromB).x, y: cy }, 6) : a
  const b2 = toB ? edgePoint(toB, { x: centerOf(toB).x, y: cy }, 6) : b
  return [a2, { x: a2.x, y: cy }, { x: b2.x, y: cy }, b2]
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
  const boundsOf = (id?: string): Bounds | undefined => {
    if (!id) return undefined
    const a = shapes.get(id)
    if (a) return agentBounds(a)
    return externalBounds.get(id)
  }

  // Solid shapes an arrow must not stab: everything except itself and the two
  // shapes it connects. (Endpoint-inside cases are exempted by segHitsBox.)
  const obstaclesFor = (arrow: AgentShape): Bounds[] => {
    const out: Bounds[] = []
    for (const other of shapes.values()) {
      if (other.id === arrow.id || other.id === arrow.fromId || other.id === arrow.toId) continue
      if (
        other.type === 'rectangle' || other.type === 'ellipse' ||
        other.type === 'diamond' || other.type === 'math'
      ) {
        out.push(agentBounds(other))
      }
    }
    return out
  }

  const skeletons: Skeleton[] = []

  for (const shape of shapes.values()) {
    if (!shape.id || !shape.type) continue

    switch (shape.type) {
      case 'rectangle':
      case 'ellipse':
      case 'diamond': {
        const fitted = shape.text
          ? fitLabelledContainer(
              shape.type,
              fixCanvasGlyphs(shape.text),
              shape.width ?? DEFAULT_W,
              shape.height ?? DEFAULT_H
            )
          : { width: shape.width ?? DEFAULT_W, height: shape.height ?? DEFAULT_H }
        skeletons.push({
          type: shape.type,
          id: shape.id,
          x: shape.x ?? 0,
          y: shape.y ?? 0,
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
        break
      }

      case 'text': {
        skeletons.push({
          type: 'text',
          id: shape.id,
          x: shape.x ?? 0,
          y: shape.y ?? 0,
          text: fixCanvasGlyphs(shape.text ?? ''),
          ...(shape.fontSize ? { fontSize: shape.fontSize } : {}),
          ...(shape.strokeColor ? { strokeColor: shape.strokeColor } : {}),
        })
        break
      }

      case 'math': {
        // Only renderable once the client has rasterized the LaTeX to a file.
        if (!shape.fileId) break
        skeletons.push({
          type: 'image',
          id: shape.id,
          x: shape.x ?? 0,
          y: shape.y ?? 0,
          width: shape.width ?? DEFAULT_W,
          height: shape.height ?? DEFAULT_H,
          fileId: shape.fileId,
          status: 'saved',
          // Carry the LaTeX so the agent can read its own equations on review.
          customData: { latex: shape.latex ?? shape.text ?? '' },
        })
        break
      }

      case 'arrow':
      case 'line': {
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
          const a = fromB ? edgePoint(fromB, cb, GAP) : ca
          const b = toB ? edgePoint(toB, ca, GAP) : cb
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

        if (shape.type === 'arrow' && shape.text) sk.label = { text: fixCanvasGlyphs(shape.text) }
        skeletons.push(sk)
        break
      }
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
