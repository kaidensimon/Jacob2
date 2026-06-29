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

  const skeletons: Skeleton[] = []

  for (const shape of shapes.values()) {
    if (!shape.id || !shape.type) continue

    switch (shape.type) {
      case 'rectangle':
      case 'ellipse':
      case 'diamond': {
        skeletons.push({
          type: shape.type,
          id: shape.id,
          x: shape.x ?? 0,
          y: shape.y ?? 0,
          width: shape.width ?? DEFAULT_W,
          height: shape.height ?? DEFAULT_H,
          ...(shape.text ? { label: { text: fixCanvasGlyphs(shape.text) } } : {}),
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
          // Anchor/geometry from whatever endpoints we can resolve.
          const a = fromB ? centerOf(fromB) : centerOf(toB!)
          const b = toB ? centerOf(toB) : centerOf(fromB!)
          sk.x = a.x
          sk.y = a.y
          sk.points = [
            [0, 0],
            [b.x - a.x, b.y - a.y],
          ]
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
  const skeletons = buildSkeletons(shapes, externalBounds)
  if (skeletons.length === 0) return []
  try {
    return convertToExcalidrawElements(skeletons as any, {
      regenerateIds: false,
    }) as ExcalidrawElement[]
  } catch {
    return []
  }
}
