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
import { detectIssues, type DetectedIssue } from './detect'
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

// Turn a detected problem into a GROUNDED instruction: name the exact shape to
// move, where it is now, and a concrete empty coordinate to move it to — all in
// the agent's own relative frame (origin-subtracted) so it matches the shape
// list it sees. This is what lets it reason about a fix instead of guessing.
function describeIssue(issue: DetectedIssue, origin: Vec): string {
  let s = issue.desc
  if (issue.moveId && issue.moveBox) {
    const rx = Math.round(issue.moveBox.x - origin.x)
    const ry = Math.round(issue.moveBox.y - origin.y)
    s += `\n    → to fix: move shape \`${issue.moveId}\` (currently at (${rx}, ${ry}))`
    if (issue.suggest) {
      const sx = Math.round(issue.suggest.x - origin.x)
      const sy = Math.round(issue.suggest.y - origin.y)
      s += ` to about (${sx}, ${sy}) — that spot is empty. Confirm it's still clear against the shape list, then move it there.`
    } else {
      s += ` into the nearest genuinely empty space (read the shape list and pick a gap where no other shape's box sits).`
    }
  }
  return s
}

// The self-critique prompt for a repair pass. It does NOT ask for a vague
// "make it better" — it walks the model through an explicit DIAGNOSE → CHOOSE
// THE RIGHT OPERATION → VERIFY THE TARGET → APPLY method, because the failure
// mode is that the model knows something is wrong but not HOW to fix it
// correctly. Each issue already carries the exact id + a free target coordinate.
function buildCritiquePrompt(request: string, issues: string[]): string {
  const work =
    issues.length > 0
      ? 'PROBLEMS DETECTED (fix THESE, and only these, this pass — each one lists the exact shape to ' +
        'move and an empty coordinate to move it to):\n- ' +
        issues.join('\n- ') +
        '\n'
      : 'No objective collisions were detected. Only act if you can SEE a clear STRUCTURAL break in the ' +
        'screenshot — a multi-part figure whose pieces do not meet (a cylinder whose sides miss the ' +
        'ellipse edges, a cone not meeting at one apex, axes not sharing an origin, a curve detached ' +
        'from its axes). If the drawing already reads cleanly, change NOTHING and finish.\n'

  return (
    `You are REPAIRING your own drawing — not redesigning it. A viewer should instantly recognize it ` +
    `as "${request}". Reason carefully; a careless "fix" that shoves a label onto something else is ` +
    `worse than leaving it.\n\n` +
    work +
    '\nWork problem-by-problem. For EACH one, think THROUGH the fix in a `think` action BEFORE you ' +
    'touch anything, in this exact order:\n' +
    '1. DIAGNOSE the root cause from the coordinates — not just "they overlap". Which is it?\n' +
    '   • a label placed ON TOP of a shape/another label → it needs to move to empty space;\n' +
    '   • several `math` equations or notes piled up → they render TALLER than expected, so the whole ' +
    'column is too tight → re-`stack` that column with a bigger gap (≥ 90), don\'t nudge one;\n' +
    '   • an annotation dropped INTO the figure instead of the margin → move it out to a tidy side column;\n' +
    '   • an arrow crossing an unrelated shape → re-route or shorten THAT arrow, or move the shape;\n' +
    '   • text cut off / overflowing its box → `resize` the container wider (or shorten the text);\n' +
    '   • a figure whose primitives don\'t connect → a STRUCTURAL break (see below).\n' +
    '2. CHOOSE THE RIGHT OPERATION for that cause (move / resize / stack / align / distribute / delete) ' +
    '— the diagnosis dictates the tool. Do not default to nudging everything.\n' +
    '3. VERIFY THE TARGET before moving: use the empty coordinate given, or compute one yourself from ' +
    'the shape list, and CHECK it does not land on any other shape\'s box. If the region is genuinely ' +
    'too crowded for the label to fit, MAKE ROOM (shift a neighbor or the whole annotation column) ' +
    'rather than cramming — a fix that creates a new overlap is not a fix.\n' +
    '4. APPLY only the minimum edits, referencing shapes by `id`. NEVER recreate a shape you already ' +
    'made. NEVER move/delete/redraw a PLOTTED graph curve or its axes (they are exact and final).\n' +
    '5. STRUCTURAL breaks: reconnect the pieces by moving/resizing their endpoints to the EXACT join ' +
    'points (e.g. a cylinder\'s left side must run from the top ellipse\'s left-edge point straight ' +
    'down to the bottom ellipse\'s left-edge point — same x, no gap, no overshoot). Reconnecting is a ' +
    'repair, not clutter.\n\n' +
    'RULES: touch ONLY shapes named in a problem (leave everything that already works alone — needless ' +
    'edits are what ruin good drawings); add NOTHING new unless something ESSENTIAL is missing; prefer ' +
    'the smallest safe change.\n' +
    'When every listed problem is resolved and the drawing reads cleanly, STOP — do NOT emit another ' +
    '`review`. End with a `message` that EXPLAINS THE VISUAL to the user (what it shows and means, the ' +
    'key elements, the takeaway), never a description of your edits.'
  )
}

// A shallow copy of the agent's shape map, used to snapshot a drawing before a
// repair pass so the caller can roll back a pass that made things worse.
function cloneShapes(m: Map<string, AgentShape>): Map<string, AgentShape> {
  return new Map(Array.from(m, ([id, shape]) => [id, { ...shape }]))
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

        // Repair passes. The detector flags only OBJECTIVE readability problems
        // (text-on-text, text-on-arrow, arrows through shapes — never intentional
        // nesting) and now hands each one the exact shape to move + an empty
        // target, so the agent can reason about HOW to fix it instead of guessing.
        // Each pass we SNAPSHOT the drawing and re-measure afterward: if a pass
        // left the canvas MESSIER than it found it, the fix backfired, so we roll
        // it back and stop — the user never sees a review pass that made things
        // worse. A stall guard stops us churning when nothing is improving.
        const reviewHistory = [...baseHistory, { role: 'user' as const, text: task }]
        let prevIssues = Infinity
        let stalls = 0
        for (let pass = 0; pass < MAX_REVIEW_PASSES; pass++) {
          if (controller.signal.aborted) break

          await settle()
          await flushMathRenders()
          const detected = detectIssues(api.getSceneElements())
          const wantsReview = reviewRequestedRef.current

          // After the first (always-on) pass: stop once the canvas is objectively
          // clean AND the model has nothing more it wants to look at.
          if (pass > 0 && detected.length === 0 && !wantsReview) break

          // Don't spin forever on overlaps that won't reduce.
          if (detected.length > 0) {
            if (detected.length >= prevIssues) {
              if (++stalls >= 2) break
            } else {
              stalls = 0
            }
            prevIssues = detected.length
          }

          // Snapshot the exact pre-pass drawing so we can undo a backfiring pass.
          const snapshot = cloneShapes(shapesRef.current)
          const before = detected.length
          // Ground each problem in the agent's relative frame: exact id + an empty
          // coordinate to move it to.
          const issues = detected.map((i) => describeIssue(i, originRef.current))

          reviewRequestedRef.current = false
          push({
            kind: 'think',
            text:
              detected.length > 0
                ? `Diagnosing and fixing ${detected.length} readability issue${detected.length > 1 ? 's' : ''}…`
                : 'Reviewing the layout for clarity and balance…',
          })
          await runServiced(buildCritiquePrompt(task, issues), reviewHistory, issues)

          // Re-measure. If this pass made the drawing messier, undo it and stop.
          await settle()
          await flushMathRenders()
          const after = detectIssues(api.getSceneElements()).length
          if (after > before) {
            shapesRef.current = snapshot
            applyToCanvas()
            push({
              kind: 'think',
              text: 'That pass added more overlap than it removed, so I undid it and kept the cleaner version.',
            })
            break
          }
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
      applyToCanvas,
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
