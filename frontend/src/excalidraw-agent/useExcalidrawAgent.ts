import { useCallback, useRef, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { shapesToElements } from './convert'
import type { Bounds } from './convert'
import {
  gatherContext,
  generateAnimation,
  orchestrate,
  readEquationFromImage,
  saveAnimation,
  streamAgent,
} from './agentClient'
import { detectOverlaps } from './detect'
import { renderLatexToImage } from './mathRender'
import { renderGraphToImage } from '../grapher/graphRender'
import { plotGraph } from '../grapher/plotEquation'
import { plotRegion } from '../grapher/regionRender'
import {
  type Box,
  type Vec,
  alignBoxes,
  boxExpandBy,
  boxUnion,
  contentBounds,
  distributeBoxes,
  getViewportBounds,
  stackBoxes,
} from './geometry'

// The agent has a name and its own independent viewport (shown as an overlay),
// like tldraw's agent. It draws in empty space away from the user's content and
// never moves the user's camera.
export const AGENT_NAME = 'Jacob'
import type { AgentAction, AgentShape, ChatItem } from './types'

// Let Excalidraw finish rendering/measuring before we screenshot or measure.
function settle(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(() => resolve(), 80))
  })
}

// The self-critique prompt for a review pass. Asks the model to judge the
// drawing on quality — not just overlaps — and to reposition strategically.
function buildCritiquePrompt(request: string, issues: string[]): string {
  const overlapNote =
    issues.length > 0
      ? `\n\nThese overlaps were detected automatically. Do NOT blindly separate them — JUDGE each one. ` +
        `Some overlaps are intentional and correct (e.g. Venn-diagram circles, a boundary curve drawn ` +
        `on a surface, nested or containing shapes, deliberate layering). Keep those. Only fix overlaps ` +
        `that actually make the drawing messy, cramped, or hard to read:\n- ${issues.join('\n- ')}`
      : '\n\nNo overlaps were detected automatically, but still look critically.'

  return (
    'You are now reviewing your OWN drawing as a designer. Your goal is a clean, uncluttered, ' +
    'instantly readable diagram. Study the screenshot and reason step by step in a `think` action:\n' +
    `- LOOK HARD AT THE SCREENSHOT FIRST, and be your HARSHEST critic. Squint: would someone INSTANTLY recognize this as "${request}"? If it reads as disjointed, floating, or misaligned strokes instead of the actual object, it FAILS — say so bluntly and fix it. Do NOT rate your own work generously.\n` +
    '- STRUCTURAL COHERENCE (critical for anything built from multiple primitives — a cylinder, cone, sphere, box, 3D axes, a curve on axes, etc.): the parts must actually CONNECT and line up into ONE coherent object. Check every join precisely: a cylinder\'s two vertical sides must touch the LEFT and RIGHT edges of BOTH the top and bottom ellipses (same x as the ellipse extremes, spanning exactly top-to-bottom — no gaps, no overshoot); a cone\'s sides meet at a single apex AND land on the base ellipse\'s edges; a box\'s edges meet at shared corners; axes share one origin. If any piece floats, stops short, overshoots, or is offset, the figure looks BROKEN — REPAIR it by moving/resizing those endpoints to the exact connection points. Reconnecting a broken figure is REQUIRED and is NOT "adding clutter".\n' +
    `- Fidelity: does it clearly and correctly visualize "${request}"? Is anything ESSENTIAL missing, wrong, or unrecognizable?\n` +
    '- Clutter: is it too busy? Are there too many labels, wordy annotations, or decorative extras? Readable diagrams are sparse — plan to REMOVE or shorten anything non-essential.\n' +
    '- Readability: are labels short and legible (not cut off, not overlapping shapes/other text)? Is there a clear structure a viewer can follow at a glance?\n' +
    '- Cleanliness: is it balanced with generous whitespace? Anything cramped, lopsided, or scattered?\n' +
    '- Collisions: do any shapes/labels overlap in a way that HURTS the visual? Keep intentional overlaps (Venn diagrams, a curve on a surface, nesting, layering); fix only those that make it messy or unreadable.\n' +
    'Specific fixes to make: (a) if a label sits on top of another label, an arrow, or the content ' +
    'of a shape, MOVE it into nearby clear space; (b) if a big shape that contains other content has ' +
    'a centered label, move that label to just inside its TOP edge so it is off the inner content; ' +
    '(c) if you drew a long leader/pointer line from a label to a distant feature, DELETE the line ' +
    'and place the label right next to the feature instead (make room if needed).\n' +
    'A precisely PLOTTED graph curve (a smooth blue line the graph tool drew for you) is EXACT and ' +
    'FINAL — NEVER delete, move, or redraw it; only tidy the axes and labels around it.\n' +
    'IMPORTANT: review is for REPAIRING and cleaning up. First FIX broken structure (reconnect / ' +
    'realign the pieces of a figure so it reads as the real object), then remove clutter. Do NOT add ' +
    'NEW decorative shapes or labels unless something essential is missing — when in doubt, SIMPLIFY: ' +
    'delete clutter, shorten or merge wordy/overlapping labels, lift text off shapes into clear space, ' +
    'and add whitespace. ' +
    'Move strategically (a spot that fixes the issue AND keeps the composition balanced and ' +
    'readable), not the minimum nudge. Use stack/distribute/align for tidy groups, resize to widen ' +
    'containers with cut-off text, move for placement, delete to cut clutter.\n' +
    'If the drawing is already clean, correct, and readable, STOP — do NOT emit another `review`. ' +
    'Instead, end with a `message` that EXPLAINS THE VISUAL to the user: what it shows and means, ' +
    'what the key elements represent, and the takeaway — as if teaching the concept. Do NOT narrate ' +
    'your edits (never say things like "I moved the row" or "I color-coded the arrows").' +
    overlapNote
  )
}

export function useExcalidrawAgent(
  api: ExcalidrawImperativeAPI | null,
  onOpenGrapher?: (mode: '2d' | '3d', expressions?: string[]) => void
) {
  const [chat, setChat] = useState<ChatItem[]>([])
  const [isGenerating, setIsGenerating] = useState(false)

  // The shapes the agent owns (id -> shape, in ABSOLUTE scene coords) and the
  // element ids it last rendered.
  const shapesRef = useRef<Map<string, AgentShape>>(new Map())
  const agentElementIdsRef = useRef<Set<string>>(new Set())
  const abortRef = useRef<AbortController | null>(null)
  // The chat origin for the current turn — coords from the model are relative
  // to this; we add it back to get absolute scene coordinates.
  const originRef = useRef<Vec>({ x: 0, y: 0 })
  // Set when the model emits a `review` action (it wants another critique pass).
  const reviewRequestedRef = useRef(false)
  // Set when the model emits `needContext` — it can't tell what to draw and is
  // asking the user to elaborate, so we stop instead of forcing a drawing.
  const needsContextRef = useRef(false)
  // Set when the model emits `graphRef` — it wants a real plot rendered and fed
  // back as a drawing reference before it draws the shape.
  const pendingGraphRefRef = useRef<{
    dimension: '2d' | '3d'
    expressions: string[]
    box?: Box | null
  } | null>(null)
  // Set when the model emits `regionRef` — it wants the client to draw a full
  // region-between-curves figure (curves, shaded region, axes, both strips).
  const pendingRegionRef = useRef<{
    lower: string
    upper: string
    xmin: number
    xmax: number
    box?: Box | null
  } | null>(null)
  // Set when a pass actually changed the canvas (used to know when to stop).
  const mutatedRef = useRef(false)
  // The agent's OWN viewport (absolute scene coords) — independent of the user's
  // camera. It's where the agent looks/draws; rendered as a "Jacob's view"
  // overlay. `agentView` is the state mirror so the overlay re-renders.
  const agentViewRef = useRef<Box | null>(null)
  // The agent's CLEAR drawing area (its coordinate viewport). Reported as
  // "(0,0)..(w,h)" — distinct from agentViewRef, which can be wider (to include
  // the user's selection) or moved by setMyView for inspection.
  const drawAreaRef = useRef<Box | null>(null)
  const [agentView, setAgentViewState] = useState<Box | null>(null)
  const setAgentView = useCallback((box: Box | null) => {
    agentViewRef.current = box
    setAgentViewState(box)
  }, [])
  // A pending "which whiteboard item do you want plotted?" question.
  const pendingGrapherRef = useRef<PendingGrapher | null>(null)
  // In-flight LaTeX→image renders for `math` shapes (awaited before we
  // screenshot / run the overlap detector so the canvas is settled).
  const pendingRendersRef = useRef<Promise<void>[]>([])

  const MAX_REVIEW_PASSES = 6

  const push = useCallback((item: ChatItem) => {
    setChat((prev) => [...prev, item])
  }, [])

  // Drop any agent shapes the user has since deleted from the canvas, so they
  // don't get re-created when the agent next renders. (Agent element ids match
  // their shape ids, so a missing id means the user removed it.)
  const reconcileDeleted = useCallback(() => {
    if (!api) return
    const liveIds = new Set(api.getSceneElements().filter((e) => !e.isDeleted).map((e) => e.id))
    for (const id of [...shapesRef.current.keys()]) {
      if (!liveIds.has(id)) shapesRef.current.delete(id)
    }
  }, [api])

  // Absolute bounds of an agent shape from the live scene (real measured size).
  const boundsOfId = useCallback(
    (id: string): Box | null => {
      if (!api || !shapesRef.current.has(id)) return null
      const el = api.getSceneElements().find((e) => e.id === id && !e.isDeleted)
      if (!el) return null
      return { x: el.x, y: el.y, w: el.width, h: el.height }
    },
    [api]
  )

  // Re-render the agent's shapes onto the canvas, preserving the user's own shapes.
  const applyToCanvas = useCallback(() => {
    if (!api) return
    const userElements = api
      .getSceneElements()
      .filter((e) => !e.isDeleted && !agentElementIdsRef.current.has(e.id))

    const externalBounds = new Map<string, Bounds>()
    for (const e of userElements) {
      if (
        (e.type === 'rectangle' || e.type === 'ellipse' || e.type === 'diamond') &&
        !shapesRef.current.has(e.id)
      ) {
        externalBounds.set(e.id, { x: e.x, y: e.y, width: e.width, height: e.height })
      }
    }

    const converted = shapesToElements(shapesRef.current, externalBounds)
    const newAgentIds = new Set(converted.map((e) => e.id))
    api.updateScene({ elements: [...userElements, ...converted] })
    agentElementIdsRef.current = newAgentIds
    mutatedRef.current = true
  }, [api])

  // Render a `math` shape's LaTeX to an image, register it as an Excalidraw
  // file, and stamp the shape with its fileId + measured size so it renders.
  const startMathRender = useCallback(
    (shape: AgentShape) => {
      if (!api) return
      const latex = (shape.latex ?? shape.text ?? '').trim()
      if (!latex) return
      const p = (async () => {
        try {
          const { dataUrl, width, height } = await renderLatexToImage(latex, {
            fontSize: shape.fontSize ?? 20,
            color: shape.strokeColor || '#1e1e1e',
          })
          const cur = shapesRef.current.get(shape.id)
          if (!cur) return // user/agent deleted it while we were rendering
          const fileId = `math-${shape.id}`
          api.addFiles([
            {
              id: fileId as any,
              mimeType: 'image/png',
              dataURL: dataUrl as any,
              created: Date.now(),
              lastRetrieved: Date.now(),
            } as any,
          ])
          shapesRef.current.set(shape.id, { ...cur, fileId, width, height })
          applyToCanvas()
        } catch (err) {
          console.error('math render failed', err)
        }
      })()
      pendingRendersRef.current.push(p)
    },
    [api, applyToCanvas]
  )

  // Wait for any in-flight LaTeX renders to finish (and land on the canvas).
  const flushMathRenders = useCallback(async () => {
    const ps = pendingRendersRef.current
    pendingRendersRef.current = []
    if (ps.length) await Promise.allSettled(ps)
  }, [])

  // Decide WHERE the agent draws and WHAT it looks at:
  //  - origin: top-left of its clear drawing area (its coords are relative to it)
  //  - view:   the region it screenshots / shows as "Jacob's view"
  // If the user has a SELECTION, the agent must SEE it: we draw in clear space
  // just to the right of the selection and frame the view to include BOTH, so
  // the screenshot + shape list contain the selected content (to the agent's
  // left, at negative x). Otherwise we draw to the right of all content.
  const computePlacement = useCallback((): { origin: Vec; drawArea: Box; view: Box } => {
    const fallback = { x: 0, y: 0, w: 1000, h: 750 }
    if (!api) return { origin: { x: 0, y: 0 }, drawArea: fallback, view: fallback }
    const appState = api.getAppState()
    const userVp = getViewportBounds(appState)
    const w = Math.max(700, Math.round(userVp.w))
    const h = Math.max(520, Math.round(userVp.h))
    const all = api.getSceneElements().filter((e) => !e.isDeleted)
    const toBox = (e: any): Box => ({ x: e.x, y: e.y, w: e.width, h: e.height })
    const GAP = 160

    const selIds = Object.keys(appState.selectedElementIds || {}).filter(
      (id) => (appState.selectedElementIds as any)[id]
    )
    const selected = all.filter((e) => selIds.includes(e.id) && !(e as any).containerId)
    const selBox = contentBounds(selected.map(toBox))
    if (selBox) {
      // Draw in the clear area to the right of the selection; SEE both.
      const drawArea = { x: Math.round(selBox.x + selBox.w + GAP), y: Math.round(selBox.y), w, h }
      return { origin: { x: drawArea.x, y: drawArea.y }, drawArea, view: boxUnion(selBox, drawArea) }
    }

    const content = contentBounds(all.map(toBox))
    const region = content
      ? { x: Math.round(content.x + content.w + GAP), y: Math.round(content.y), w, h }
      : { x: Math.round(userVp.x), y: Math.round(userVp.y), w, h }
    return { origin: { x: region.x, y: region.y }, drawArea: region, view: region }
  }, [api])

  // Pan the USER's camera to center the agent's viewport (the only time we move
  // the user's camera — and only when they ask to, via the "go to" affordance).
  const goToAgentView = useCallback(() => {
    if (!api || !agentViewRef.current) return
    const v = agentViewRef.current
    const appState = api.getAppState()
    const zoom = appState.zoom?.value ?? 1
    const width = appState.width ?? window.innerWidth
    const height = appState.height ?? window.innerHeight
    const cx = v.x + v.w / 2
    const cy = v.y + v.h / 2
    api.updateScene({
      appState: { scrollX: width / (2 * zoom) - cx, scrollY: height / (2 * zoom) - cy },
    })
  }, [api])

  // Apply a Map<id, position> from a layout action to the agent's shapes.
  const applyPositions = useCallback(
    (positions: Map<string, Vec>) => {
      for (const [id, pos] of positions) {
        if (id.startsWith('gcurve-')) continue // never reposition a plotted curve
        const shape = shapesRef.current.get(id)
        if (shape) shapesRef.current.set(id, { ...shape, x: pos.x, y: pos.y })
      }
      if (positions.size > 0) applyToCanvas()
    },
    [applyToCanvas]
  )

  const handleAction = useCallback(
    (action: AgentAction) => {
      if ('error' in action) {
        push({ kind: 'error', text: action.error })
        return
      }
      if (!action.complete) return

      const origin = originRef.current

      // A deterministically-plotted graph curve ("gcurve-…") is EXACT and FINAL.
      // Never let the agent delete, move, resize, or edit it — it may only build
      // axes/labels around it. (The USER can still delete it via the canvas.)
      const targetId =
        action._type === 'delete' || action._type === 'move' || action._type === 'resize'
          ? action.id
          : action._type === 'update'
            ? action.shape?.id
            : undefined
      if (typeof targetId === 'string' && targetId.startsWith('gcurve-')) return

      switch (action._type) {
        case 'think':
          if (action.text) push({ kind: 'think', text: action.text })
          break
        case 'message':
          if (action.text) push({ kind: 'message', text: action.text })
          break

        case 'needContext':
          // The agent doesn't know what to draw — surface its question and flag
          // the turn so we skip drawing/review entirely.
          needsContextRef.current = true
          push({
            kind: 'message',
            text: action.text || 'I need a bit more detail — what would you like me to visualize?',
          })
          break

        case 'create': {
          const shape = action.shape
          if (shape?.id) {
            // Model gives viewport-relative coords; store absolute.
            const abs: AgentShape = { ...shape }
            if (typeof shape.x === 'number') abs.x = shape.x + origin.x
            if (typeof shape.y === 'number') abs.y = shape.y + origin.y
            shapesRef.current.set(shape.id, abs)
            push({ kind: 'action', text: describeCreate(shape) })
            if (abs.type === 'math') startMathRender(abs)
            else applyToCanvas()
          }
          break
        }

        case 'update': {
          const shape = action.shape
          if (shape?.id) {
            const existing = shapesRef.current.get(shape.id)
            if (existing) {
              const patch: Partial<AgentShape> = { ...shape }
              if (typeof shape.x === 'number') patch.x = shape.x + origin.x
              if (typeof shape.y === 'number') patch.y = shape.y + origin.y
              const merged = { ...existing, ...patch }
              shapesRef.current.set(shape.id, merged)
              push({ kind: 'action', text: `Updated ${shape.id}` })
              if (
                merged.type === 'math' &&
                (patch.latex !== undefined ||
                  patch.text !== undefined ||
                  patch.fontSize !== undefined ||
                  patch.strokeColor !== undefined)
              ) {
                startMathRender(merged)
                break
              }
              applyToCanvas()
            }
          }
          break
        }

        case 'move': {
          const { id, x, y } = action
          if (id) {
            const existing = shapesRef.current.get(id)
            if (existing && typeof x === 'number' && typeof y === 'number') {
              shapesRef.current.set(id, { ...existing, x: x + origin.x, y: y + origin.y })
              push({ kind: 'action', text: `Moved ${id}` })
              applyToCanvas()
            }
          }
          break
        }

        case 'resize': {
          const { id, width, height } = action
          if (id) {
            const existing = shapesRef.current.get(id)
            if (existing) {
              shapesRef.current.set(id, {
                ...existing,
                ...(typeof width === 'number' ? { width } : {}),
                ...(typeof height === 'number' ? { height } : {}),
              })
              push({ kind: 'action', text: `Resized ${id}` })
              applyToCanvas()
            }
          }
          break
        }

        case 'align': {
          const items = (action.ids ?? [])
            .map((id) => ({ id, box: boundsOfId(id) }))
            .filter((i): i is { id: string; box: Box } => i.box !== null)
          if (items.length >= 2 && action.edge) {
            applyPositions(alignBoxes(items, action.edge))
            push({ kind: 'action', text: `Aligned ${items.length} shapes (${action.edge})` })
          }
          break
        }

        case 'distribute': {
          const items = (action.ids ?? [])
            .map((id) => ({ id, box: boundsOfId(id) }))
            .filter((i): i is { id: string; box: Box } => i.box !== null)
          if (items.length >= 3 && action.axis) {
            applyPositions(distributeBoxes(items, action.axis))
            push({ kind: 'action', text: `Distributed ${items.length} shapes` })
          }
          break
        }

        case 'stack': {
          const items = (action.ids ?? [])
            .map((id) => ({ id, box: boundsOfId(id) }))
            .filter((i): i is { id: string; box: Box } => i.box !== null)
          if (items.length >= 2 && action.axis) {
            applyPositions(stackBoxes(items, action.axis, action.gap ?? 40))
            push({ kind: 'action', text: `Stacked ${items.length} shapes` })
          }
          break
        }

        case 'delete': {
          if (action.id && shapesRef.current.delete(action.id)) {
            push({ kind: 'action', text: `Deleted ${action.id}` })
            applyToCanvas()
          }
          break
        }

        case 'setMyView': {
          // Move the agent's OWN viewport (the "Jacob's view" box) — NOT the
          // user's camera. The next screenshot is framed to this region.
          if (!api) break
          const scene = api.getSceneElements().filter((e) => !e.isDeleted)
          const toBox = (e: any): Box => ({ x: e.x, y: e.y, w: e.width, h: e.height })
          let box: Box | null = null
          let label = '🔭 Zoomed out to review the whole drawing'
          if (action.ids?.length) {
            const want = new Set(action.ids)
            box = contentBounds(scene.filter((e) => want.has(e.id)).map(toBox))
            if (box) box = boxExpandBy(box, 80)
            label = `🔍 Zoomed in to inspect ${action.ids.length} shape${action.ids.length > 1 ? 's' : ''}`
          } else if (action.bounds) {
            box = {
              x: action.bounds.x + origin.x,
              y: action.bounds.y + origin.y,
              w: action.bounds.w,
              h: action.bounds.h,
            }
            label = '🔍 Zoomed in to take a closer look'
          } else {
            // Zoom out to fit everything the agent has drawn.
            const mine = scene.filter((e) => agentElementIdsRef.current.has(e.id))
            box = contentBounds((mine.length ? mine : scene).map(toBox))
            if (box) box = boxExpandBy(box, 100)
          }
          if (box) {
            setAgentView(box)
            push({ kind: 'action', text: label })
          }
          break
        }

        case 'review':
          // The model wants to take another look — drives a critique pass.
          reviewRequestedRef.current = true
          break

        case 'graphRef': {
          // The model wants a correct plot to trace. Record the request; the turn
          // loop renders it and feeds the image back.
          const exprs = (action.expressions ?? []).filter((e) => typeof e === 'string' && e.trim())
          if (exprs.length) {
            // The agent can place the plot (viewport coords) so it fits the
            // layout when invoked partway through a drawing.
            const box: Box | null =
              typeof action.x === 'number' &&
              typeof action.y === 'number' &&
              typeof action.width === 'number' &&
              typeof action.height === 'number'
                ? { x: action.x + origin.x, y: action.y + origin.y, w: action.width, h: action.height }
                : null
            pendingGraphRefRef.current = {
              dimension: action.dimension === '3d' ? '3d' : '2d',
              expressions: exprs,
              box,
            }
            push({ kind: 'action', text: `📊 Plotting ${exprs.join(', ')} to trace it accurately…` })
          }
          break
        }

        case 'regionRef': {
          // The model wants the client to draw a region-between-curves figure.
          const lower = typeof action.lower === 'string' ? action.lower.trim() : ''
          const upper = typeof action.upper === 'string' ? action.upper.trim() : ''
          if (lower && upper && typeof action.xmin === 'number' && typeof action.xmax === 'number') {
            const box: Box | null =
              typeof action.x === 'number' &&
              typeof action.y === 'number' &&
              typeof action.width === 'number' &&
              typeof action.height === 'number'
                ? { x: action.x + origin.x, y: action.y + origin.y, w: action.width, h: action.height }
                : null
            pendingRegionRef.current = { lower, upper, xmin: action.xmin, xmax: action.xmax, box }
            push({ kind: 'action', text: `📐 Drawing the region between ${lower} and ${upper}…` })
          }
          break
        }
      }
    },
    [api, applyToCanvas, applyPositions, boundsOfId, push, startMathRender, setAgentView]
  )

  // Run one request/response turn against the agent.
  const runTurn = useCallback(
    async (
      message: string,
      history: { role: 'user' | 'assistant'; text: string }[],
      signal: AbortSignal,
      issues?: string[],
      reference?: { image: string; note: string }
    ) => {
      await settle()
      await flushMathRenders()
      const fallback = computePlacement()
      const drawArea = drawAreaRef.current ?? fallback.drawArea
      const view = agentViewRef.current ?? fallback.view
      // Report the clear draw area as the agent's viewport (so it draws where its
      // work stays visible); screenshot the wider view so it sees the selection.
      const ctx = await gatherContext(api!, originRef.current, drawArea, view)
      await streamAgent(
        {
          messages: [message],
          viewport: ctx.viewport,
          blurryShapes: ctx.blurryShapes,
          peripheralClusters: ctx.peripheralClusters,
          selectedIds: ctx.selectedIds,
          screenshot: ctx.screenshot,
          history,
          issues,
          referenceImage: reference?.image,
          referenceNote: reference?.note,
        },
        handleAction,
        signal
      )
    },
    [api, handleAction, flushMathRenders, computePlacement]
  )

  // Read the equation text off the given whiteboard elements, convert it into
  // grapher expressions (via the orchestrator), and open the grapher.
  const plotFromElements = useCallback(
    async (els: any[], signal: AbortSignal) => {
      if (!api) return
      const all = api.getSceneElements()
      const text = els
        .map((e) => elementText(e, all))
        .filter(Boolean)
        .join('; ')

      // No text? If they selected an image, read the equation from it with vision.
      if (!text.trim()) {
        const imageEl = els.find((e) => e.type === 'image' && e.fileId)
        if (imageEl) {
          const file = (api.getFiles() as any)?.[imageEl.fileId]
          const dataUrl: string | undefined = file?.dataURL
          if (dataUrl) {
            push({ kind: 'message', text: 'Reading the equation from the image…' })
            try {
              const res = await readEquationFromImage(dataUrl, signal)
              if (res.expressions.length) {
                push({ kind: 'message', text: `Plotting from the image: ${res.expressions.join(', ')}` })
                onOpenGrapher?.(res.dimension, res.expressions)
              } else {
                push({
                  kind: 'message',
                  text: res.message || "I couldn't find a graphable equation in that image.",
                })
              }
            } catch (err: any) {
              if (err?.name !== 'AbortError') {
                push({ kind: 'error', text: err?.message || 'Could not read that image.' })
              }
            }
            return
          }
        }
        push({
          kind: 'message',
          text: "I couldn't read an equation from that. What would you like me to plot?",
        })
        return
      }
      try {
        const decision = await orchestrate(`graph this equation: ${text}`, [], signal)
        if (decision.action === 'grapher' && decision.expressions?.length) {
          push({ kind: 'message', text: `Plotting: ${text}` })
          onOpenGrapher?.(decision.dimension === '3d' ? '3d' : '2d', decision.expressions)
        } else {
          push({
            kind: 'message',
            text: `I couldn't turn “${truncate(text, 60)}” into a graph. Try giving me the equation directly.`,
          })
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          push({ kind: 'error', text: err?.message || 'Could not plot that.' })
        }
      }
    },
    [api, push, onOpenGrapher]
  )

  // The user asked to plot "this"/something from the whiteboard but gave no
  // equation. Figure out what they mean from selection / canvas contents.
  const resolveWhiteboardPlot = useCallback(
    async (signal: AbortSignal) => {
      if (!api) return
      const all = api.getSceneElements().filter((e) => !e.isDeleted)
      const appState = api.getAppState()
      const selIds = Object.keys(appState.selectedElementIds || {}).filter(
        (id) => appState.selectedElementIds[id]
      )
      const selected = all.filter((e) => selIds.includes(e.id) && !e.containerId)
      const things = all.filter((e) => !e.containerId)

      if (selected.length > 0) {
        pendingGrapherRef.current = { type: 'confirm', elementIds: selected.map((e) => e.id) }
        push({
          kind: 'message',
          text: `You currently have ${describeSelection(selected, all)} selected. Do you mean to plot this? (yes / no)`,
        })
        return
      }
      if (things.length === 0) {
        push({
          kind: 'message',
          text: "There's nothing on the whiteboard to plot yet. Add an equation, or just tell me one.",
        })
        return
      }
      if (things.length === 1) {
        await plotFromElements(things, signal)
        return
      }
      pendingGrapherRef.current = { type: 'choose' }
      push({
        kind: 'message',
        text: 'There are several things on the whiteboard. Which one should I plot? Select it on the canvas (then say "this one"), or just tell me the equation.',
      })
    },
    [api, push, plotFromElements]
  )

  const sendMessage = useCallback(
    async (text: string) => {
      if (!api || !text.trim() || isGenerating) return

      push({ kind: 'user', text })
      setIsGenerating(true)

      const baseHistory = chat
        .filter((c) => c.kind === 'user' || c.kind === 'message')
        .map((c) => ({
          role: (c.kind === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          text: c.text,
        }))

      const controller = new AbortController()
      abortRef.current = controller
      // Clear the previous "Jacob's view" overlay when a new message starts.
      setAgentView(null)

      try {
        // 0. If we asked which whiteboard item to plot, interpret this reply.
        const pending = pendingGrapherRef.current
        if (pending) {
          if (pending.type === 'confirm') {
            if (isAffirmative(text)) {
              pendingGrapherRef.current = null
              const all = api.getSceneElements()
              await plotFromElements(
                all.filter((e) => pending.elementIds.includes(e.id)),
                controller.signal
              )
              return
            }
            if (isNegative(text)) {
              pendingGrapherRef.current = { type: 'choose' }
              push({
                kind: 'message',
                text: 'No problem — what on the whiteboard would you like me to plot? Select it (then say "this one"), or tell me the equation.',
              })
              return
            }
            // Ambiguous reply — drop the pending question and treat it normally.
            pendingGrapherRef.current = null
          } else {
            // 'choose' — did they select something on the canvas now?
            pendingGrapherRef.current = null
            const appState = api.getAppState()
            const selIds = Object.keys(appState.selectedElementIds || {}).filter(
              (id) => appState.selectedElementIds[id]
            )
            if (selIds.length > 0) {
              const all = api.getSceneElements()
              await plotFromElements(
                all.filter((e) => selIds.includes(e.id) && !e.containerId),
                controller.signal
              )
              return
            }
            // Otherwise fall through — they may have typed the equation directly.
          }
        }

        // 1. Reasoning orchestrator decides what to do. It gets ONLY the message
        //    + conversation history — no canvas context (that would waste tokens).
        const decision = await orchestrate(text, baseHistory, controller.signal)

        if (decision.action === 'grapher') {
          // The equation lives on the whiteboard (no equation was given) — figure
          // out which item they mean from selection / canvas contents.
          if (decision.source === 'whiteboard' || !decision.expressions?.length) {
            await resolveWhiteboardPlot(controller.signal)
            return
          }
          // Equation provided — open the grapher with it.
          push({
            kind: 'message',
            text:
              decision.message ||
              `Opening the ${decision.dimension === '3d' ? '3D' : '2D'} grapher with your equation.`,
          })
          onOpenGrapher?.(decision.dimension === '3d' ? '3d' : '2d', decision.expressions)
          return
        }

        if (decision.action === 'manim') {
          // Animation agent: generate + render a Manim video, show it in chat.
          const task = decision.task || text
          push({
            kind: 'message',
            text: `Animating "${task}" — reasoning about the best way to show it and rendering the video. This can take a few minutes for richer topics…`,
          })
          const result = await generateAnimation(task, controller.signal)
          push({ kind: 'video', url: result.videoUrl, title: result.title })
          push({ kind: 'save-prompt', animationId: result.id, title: result.title })
          return
        }

        if (decision.action !== 'whiteboard') {
          // chat / ask → just reply in the chat; no drawing.
          push({
            kind: 'message',
            text: decision.message || 'Done.',
          })
          return
        }

        // 2. Whiteboard agent flow — NOW we inject the full canvas context.
        const task = decision.task || text

        // Forget any agent shapes the user deleted before this prompt.
        reconcileDeleted()

        // Give the agent its OWN viewport: it draws in clear space (origin),
        // never on the user's content or camera, but its view is framed to
        // INCLUDE the user's selection so it actually looks at what they
        // referenced. The "Jacob's view" overlay shows where it's working.
        const placement = computePlacement()
        originRef.current = placement.origin
        drawAreaRef.current = placement.drawArea
        setAgentView(placement.view)

        reviewRequestedRef.current = false
        needsContextRef.current = false
        pendingGraphRefRef.current = null
        // Shared budget of reference plots for the WHOLE request (initial turn +
        // every review pass), so graphRef can't loop forever.
        let graphRefBudget = 3

        // Run a turn, then service any `graphRef` the agent emitted on it: render
        // the plot offscreen and feed the image back so it traces the real shape.
        // Works for both the initial turn and review passes (where the agent often
        // realizes the curve is missing and asks to plot it).
        const runServiced = async (
          message: string,
          history: { role: 'user' | 'assistant'; text: string }[],
          issues?: string[]
        ) => {
          await runTurn(message, history, controller.signal, issues)
          while (
            (pendingGraphRefRef.current || pendingRegionRef.current) &&
            graphRefBudget > 0 &&
            !controller.signal.aborted
          ) {
            // ── Region-between-curves figure (fully deterministic) ──────────────
            const rreq = pendingRegionRef.current
            if (rreq) {
              pendingRegionRef.current = null
              graphRefBudget--
              const da = drawAreaRef.current ?? computePlacement().drawArea
              const rbox =
                rreq.box ?? { x: da.x + da.w * 0.08, y: da.y + da.h * 0.12, w: da.w * 0.56, h: da.h * 0.72 }
              let region: Awaited<ReturnType<typeof plotRegion>> = null
              try {
                region = await plotRegion(rreq.lower, rreq.upper, rreq.xmin, rreq.xmax, rbox)
              } catch {
                region = null
              }
              if (region) {
                region.drawables.forEach((d, di) => {
                  const id = `gcurve-region-${graphRefBudget}-${di}`
                  if (d.type === 'rectangle' && d.rect) {
                    shapesRef.current.set(id, {
                      id, type: 'rectangle',
                      x: d.rect.x, y: d.rect.y, width: d.rect.w, height: d.rect.h,
                      strokeColor: d.stroke, backgroundColor: d.fill, fillStyle: d.fillStyle,
                    })
                  } else if (d.type === 'arrow' && d.points && d.points.length >= 2) {
                    const a = d.points[0], b = d.points[d.points.length - 1]
                    shapesRef.current.set(id, {
                      id, type: 'arrow', x: a[0], y: a[1],
                      points: [[0, 0], [b[0] - a[0], b[1] - a[1]]], strokeColor: d.stroke,
                    })
                  } else if (d.type === 'text' && d.points && d.points.length >= 1 && d.text) {
                    shapesRef.current.set(id, {
                      id, type: 'text', x: d.points[0][0], y: d.points[0][1],
                      text: d.text, fontSize: d.fontSize ?? 16, strokeColor: d.stroke,
                    })
                  } else if (d.points && d.points.length >= 2) {
                    const ox = d.points[0][0], oy = d.points[0][1]
                    shapesRef.current.set(id, {
                      id, type: 'line', x: ox, y: oy,
                      points: d.points.map(([px, py]) => [px - ox, py - oy] as [number, number]),
                      strokeColor: d.stroke, backgroundColor: d.fill, fillStyle: d.fillStyle,
                    })
                  }
                })
                applyToCanvas()
                push({ kind: 'action', text: '📐 Drew the region figure — adding integrals…' })
                const figRight = Math.round(rbox.x + rbox.w - originRef.current.x)
                const figTop = Math.round(rbox.y - originRef.current.y)
                const note =
                  `The region figure is COMPLETE and LOCKED — the bounding curves, the shaded region, ` +
                  `the x/y axes, both strips, AND all of their labels (curve names, "x"/"y", "dy dx", ` +
                  `"dx dy") are already drawn. Do NOT touch the figure and do NOT add any labels on or ` +
                  `near it — that space is done. Add ONLY: (1) a short TITLE above the figure (around ` +
                  `y=${figTop - 30}), and (2) the two integral forms as \`math\` elements OFF TO THE ` +
                  `RIGHT of the figure, starting around x=${figRight + 60} in the clear margin — the ` +
                  `ORIGINAL order and the SWAPPED order (solve each boundary for the other variable). ` +
                  `Keep ALL your text in the clear margins, never over the figure. Then finish.`
                await runTurn(`${task}\n\n${note}`, history, controller.signal)
              }
              continue
            }

            const req = pendingGraphRefRef.current as
              | { dimension: '2d' | '3d'; expressions: string[]; box?: Box | null }
              | null
            if (!req) break
            pendingGraphRefRef.current = null
            graphRefBudget--

            // 2D: draw the curve EXACTLY (deterministic — handles functions,
            // implicit relations like x^2+y^2=25, vertical lines, and polar),
            // then have the agent add axes/labels around it. Far more reliable
            // than asking the model to eyeball-trace points.
            if (req.dimension === '2d') {
              const da = drawAreaRef.current ?? computePlacement().drawArea
              // Use the spot the agent asked for; otherwise a default region.
              const box =
                req.box ?? { x: da.x + da.w * 0.18, y: da.y + da.h * 0.16, w: da.w * 0.5, h: da.h * 0.56 }
              let graph: Awaited<ReturnType<typeof plotGraph>> = null
              try {
                graph = await plotGraph(req.expressions, box)
              } catch {
                graph = null
              }
              if (graph) {
                const rel = (p: [number, number]) =>
                  `(${Math.round(p[0] - originRef.current.x)}, ${Math.round(p[1] - originRef.current.y)})`
                const CURVE_COLORS = ['#1971c2', '#2f9e44', '#e8590c', '#9c36b5', '#0c8599']
                const curveInfo: string[] = []
                // Curves (each branch a locked line).
                graph.curves.forEach((c, ci) => {
                  c.polylines.forEach((pl, pi) => {
                    if (pl.length < 2) return
                    // Use the polyline's bounding box as x/y/size so an arrow
                    // bound to this curve points at its true center.
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
                    for (const [px, py] of pl) {
                      minX = Math.min(minX, px); minY = Math.min(minY, py)
                      maxX = Math.max(maxX, px); maxY = Math.max(maxY, py)
                    }
                    shapesRef.current.set(`gcurve-graph-${graphRefBudget}-${ci}-${pi}`, {
                      id: `gcurve-graph-${graphRefBudget}-${ci}-${pi}`,
                      type: 'line', x: minX, y: minY,
                      width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY),
                      points: pl.map(([px, py]) => [px - minX, py - minY] as [number, number]),
                      strokeColor: CURVE_COLORS[ci % CURVE_COLORS.length],
                    })
                  })
                  curveInfo.push(`"${req.expressions[ci]}" passes through about ${rel(c.anchor)}`)
                })
                // Axes (locked arrows).
                const axis = (id: string, seg: [[number, number], [number, number]]) => {
                  const a0 = seg[0], a1 = seg[1]
                  shapesRef.current.set(id, {
                    id, type: 'arrow', x: a0[0], y: a0[1],
                    points: [[0, 0], [a1[0] - a0[0], a1[1] - a0[1]]], strokeColor: '#1e1e1e',
                  })
                }
                axis(`gcurve-graph-${graphRefBudget}-axx`, graph.xAxis)
                axis(`gcurve-graph-${graphRefBudget}-axy`, graph.yAxis)
                applyToCanvas()
                push({ kind: 'action', text: '📈 Drew the graph — labeling it…' })
                const curveIds = graph.curves
                  .map((_c, ci) => `gcurve-graph-${graphRefBudget}-${ci}-0`)
                  .join(', ')
                const note =
                  `The graph is DRAWN and LOCKED: the curve(s) and the x/y axes (origin at ` +
                  `${rel([graph.origin.x, graph.origin.y])}). Do NOT redraw, move, or touch any of it. ` +
                  `Your ONLY job now is to LABEL it. You MUST do BOTH: (1) add a small "x" just past the ` +
                  `right tip of the x-axis near ${rel(graph.xAxis[1])} and "y" just above the top of the ` +
                  `y-axis near ${rel(graph.yAxis[1])}; (2) for EACH curve, create a short text label of ` +
                  `its equation in nearby CLEAR space (OFF the curve), AND an arrow pointing from that ` +
                  `label to the curve — set the arrow's fromId to your text label and its toId to the ` +
                  `curve element (curve ids: ${curveIds}). Curves: ${curveInfo.join('; ')}. Keep all ` +
                  `text off the curves and axes. Then continue your work, or finish.`
                await runTurn(`${task}\n\n${note}`, history, controller.signal)
                continue
              }
            }

            // 3D surfaces (and 2D fallback): render an image to trace.
            let image: string | undefined
            try {
              image = await renderGraphToImage(req.dimension, req.expressions)
            } catch (err: any) {
              push({ kind: 'message', text: `I couldn't plot that (${err?.message || 'error'}) — I'll sketch it from what I know.` })
            }
            const note =
              `This is a CORRECT ${req.dimension.toUpperCase()} plot of ${req.expressions.join(', ')}, ` +
              `rendered by a real graphing engine. TRACE it so your drawing LOOKS LIKE THIS IMAGE: ` +
              `a curve MUST be a \`line\` with MANY points (~10-15) following the bend — never a ` +
              `straight 2-point line — and do NOT represent the graph as an equation image; draw the ` +
              `curve itself. CRITICAL ORIENTATION: the whiteboard's y-axis points DOWN (y grows ` +
              `downward), so to match the reference you must FLIP vertically — a curve that opens ` +
              `UPWARD in the reference (e.g. y=x^2, vertex at the bottom, arms rising) must be drawn ` +
              `with its arms going toward SMALLER y values (UP the canvas) and its vertex on the ` +
              `x-axis. Your finished curve must look like the reference image, not a vertical mirror ` +
              `of it.`
            const followup =
              `${task}\n\nThe reference plot you requested is attached — now DRAW THE CURVE/SURFACE ` +
              `ITSELF over your existing axes, tracing the reference. Do not just label it. Then ` +
              `CONTINUE the rest of your work/solution where you left off.`
            await runTurn(
              followup,
              history,
              controller.signal,
              undefined,
              image ? { image, note } : undefined
            )
          }
          // Budget spent but it still wants a plot — drop it so it doesn't hang.
          if (pendingGraphRefRef.current) pendingGraphRefRef.current = null
          if (pendingRegionRef.current) pendingRegionRef.current = null
        }

        const shapeCountBefore = shapesRef.current.size
        await runServiced(task, baseHistory)

        // If the agent asked for more context (or simply drew nothing on
        // purpose), respect that: don't force a drawing via the review loop.
        if (needsContextRef.current || shapesRef.current.size === shapeCountBefore) {
          setAgentView(null)
          return
        }

        api.setToast({
          message: `✏️ ${AGENT_NAME} is drawing nearby — open “${AGENT_NAME}'s view” to follow`,
          duration: 4000,
        })

        // Critique passes. The detector now only flags OBJECTIVE readability
        // problems (text-on-text, text-on-arrow, arrows through shapes — never
        // intentional nesting), so we drive the loop with it: keep cleaning up
        // while real problems remain OR the model wants another look. A stall
        // guard stops us spinning on something that isn't improving.
        const reviewHistory = [...baseHistory, { role: 'user' as const, text: task }]
        let prevIssues = Infinity
        let stalls = 0
        for (let pass = 0; pass < MAX_REVIEW_PASSES; pass++) {
          if (controller.signal.aborted) break

          await settle()
          await flushMathRenders()
          const issues = detectOverlaps(api.getSceneElements())
          const wantsReview = reviewRequestedRef.current

          // After the first (always-on) critique: stop only when the canvas is
          // objectively clean AND the model has nothing more it wants to do.
          if (pass > 0 && issues.length === 0 && !wantsReview) break

          // Don't spin forever on overlaps that won't reduce.
          if (issues.length > 0) {
            if (issues.length >= prevIssues) {
              if (++stalls >= 2) break
            } else {
              stalls = 0
            }
            prevIssues = issues.length
          }

          reviewRequestedRef.current = false
          mutatedRef.current = false
          push({
            kind: 'think',
            text:
              issues.length > 0
                ? `Cleaning up ${issues.length} readability issue${issues.length > 1 ? 's' : ''}…`
                : 'Reviewing the layout for clarity and balance…',
          })
          await runServiced(buildCritiquePrompt(task, issues), reviewHistory, issues)
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          push({ kind: 'error', text: err?.message || 'Something went wrong.' })
        }
      } finally {
        // We never moved the user's camera, so there's nothing to restore. The
        // "Jacob's view" overlay stays up (showing where it drew) until the
        // user's next message or until they go there.
        setIsGenerating(false)
        abortRef.current = null
      }
    },
    [
      api,
      chat,
      isGenerating,
      push,
      runTurn,
      reconcileDeleted,
      onOpenGrapher,
      plotFromElements,
      resolveWhiteboardPlot,
      computePlacement,
      setAgentView,
    ]
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  // Respond to the "save this animation?" prompt.
  const respondToSavePrompt = useCallback(
    async (animationId: number, title: string, save: boolean) => {
      // Remove the prompt (its buttons) from the chat.
      setChat((prev) =>
        prev.filter((c) => !(c.kind === 'save-prompt' && c.animationId === animationId))
      )
      if (save) {
        try {
          await saveAnimation(animationId, title)
          push({ kind: 'message', text: `Saved "${title}" to your library.` })
        } catch {
          push({ kind: 'error', text: 'Could not save the animation.' })
        }
      } else {
        push({ kind: 'message', text: "Okay — I won't save it." })
      }
    },
    [push]
  )

  const newChat = useCallback(() => {
    abortRef.current?.abort()
    shapesRef.current = new Map()
    agentElementIdsRef.current = new Set()
    setAgentView(null)
    setChat([])
  }, [setAgentView])

  return {
    chat,
    isGenerating,
    sendMessage,
    stop,
    newChat,
    respondToSavePrompt,
    agentView,
    agentName: AGENT_NAME,
    goToAgentView,
  }
}

function describeCreate(shape: AgentShape): string {
  if (shape.type === 'arrow') {
    if (shape.fromId && shape.toId) return `Arrow ${shape.fromId} → ${shape.toId}`
    return 'Drew an arrow'
  }
  if (shape.type === 'math') return 'Typeset an equation'
  const label = shape.text ? ` “${shape.text}”` : ''
  return `Drew ${shape.type}${label}`
}

// ── Whiteboard "plot this" resolution helpers ────────────────────────────────

type PendingGrapher =
  | { type: 'confirm'; elementIds: string[] }
  | { type: 'choose' }

const AFFIRMATIVE = /^\s*(y|ye|yes|yeah|yep|yup|sure|ok|okay|correct|right|do it|plot( it)?|that one|this one|the selected one)\b/i
const NEGATIVE = /^\s*(n|no|nope|nah|not|don'?t|incorrect|wrong|other)\b/i

function isAffirmative(s: string): boolean {
  return AFFIRMATIVE.test(s.trim())
}
function isNegative(s: string): boolean {
  return NEGATIVE.test(s.trim())
}

function colorName(hex?: string): string {
  if (!hex) return ''
  const map: Record<string, string> = {
    '#1e1e1e': 'black', '#e03131': 'red', '#2f9e44': 'green', '#1971c2': 'blue',
    '#f08c00': 'orange', '#9c36b5': 'purple', '#ae3ec9': 'purple', '#e64980': 'pink',
  }
  return map[hex.toLowerCase()] || ''
}

function readableType(t: string): string {
  if (t === 'freedraw' || t === 'draw') return 'drawing'
  return t
}

function elementText(el: any, all: readonly any[]): string {
  if (typeof el.text === 'string' && el.text) return el.text
  const child = all.find((c) => c.type === 'text' && c.containerId === el.id)
  return (child && child.text) || ''
}

function truncate(s: string, n = 40): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

function describeSelection(els: any[], all: readonly any[]): string {
  if (els.length === 1) {
    const e = els[0]
    const txt = elementText(e, all)
    if (e.type === 'text') return txt ? `the text “${truncate(txt)}”` : 'the text element'
    const c = colorName(e.strokeColor)
    const base = `the ${c ? c + ' ' : ''}${readableType(e.type)}`
    return txt ? `${base} labeled “${truncate(txt)}”` : base
  }
  return `the ${els.length} selected items`
}
