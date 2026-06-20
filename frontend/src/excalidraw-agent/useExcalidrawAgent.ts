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
import {
  type Box,
  type Vec,
  alignBoxes,
  boxIntersects,
  distributeBoxes,
  getViewportBounds,
  stackBoxes,
} from './geometry'
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
    `- Fidelity: does it clearly and correctly visualize the request: "${request}"? Is anything ESSENTIAL missing or wrong?\n` +
    '- Clutter: is it too busy? Are there too many labels, wordy annotations, or decorative extras? Readable diagrams are sparse — plan to REMOVE or shorten anything non-essential.\n' +
    '- Readability: are labels short and legible (not cut off, not overlapping shapes/other text)? Is there a clear structure a viewer can follow at a glance?\n' +
    '- Cleanliness: is it balanced with generous whitespace? Anything cramped, lopsided, or scattered?\n' +
    '- Collisions: do any shapes/labels overlap in a way that HURTS the visual? Keep intentional overlaps (Venn diagrams, a curve on a surface, nesting, layering); fix only those that make it messy or unreadable.\n' +
    'Specific fixes to make: (a) if a label sits on top of another label, an arrow, or the content ' +
    'of a shape, MOVE it into nearby clear space; (b) if a big shape that contains other content has ' +
    'a centered label, move that label to just inside its TOP edge so it is off the inner content; ' +
    '(c) if you drew a long leader/pointer line from a label to a distant feature, DELETE the line ' +
    'and place the label right next to the feature instead (make room if needed).\n' +
    'IMPORTANT: review is for CLEANING UP, not adding. Do NOT add new shapes or labels unless ' +
    'something genuinely essential is missing — when in doubt, SIMPLIFY: delete clutter, shorten or ' +
    'merge wordy/overlapping labels, lift text off shapes into clear space, and add whitespace. ' +
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
  // Set when a pass actually changed the canvas (used to know when to stop).
  const mutatedRef = useRef(false)
  // The user's camera when the turn started — restored when the agent finishes.
  const userViewRef = useRef<{ scrollX: number; scrollY: number; zoom: any } | null>(null)
  // A pending "which whiteboard item do you want plotted?" question.
  const pendingGrapherRef = useRef<PendingGrapher | null>(null)

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

  // Apply a Map<id, position> from a layout action to the agent's shapes.
  const applyPositions = useCallback(
    (positions: Map<string, Vec>) => {
      for (const [id, pos] of positions) {
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

      switch (action._type) {
        case 'think':
          if (action.text) push({ kind: 'think', text: action.text })
          break
        case 'message':
          if (action.text) push({ kind: 'message', text: action.text })
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
            applyToCanvas()
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
              shapesRef.current.set(shape.id, { ...existing, ...patch })
              push({ kind: 'action', text: `Updated ${shape.id}` })
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
          if (!api) break
          const scene = api.getSceneElements().filter((e) => !e.isDeleted)
          let targets = scene
          let label = '🔭 Zoomed out to review the whole drawing'
          if (action.ids?.length) {
            const want = new Set(action.ids)
            targets = scene.filter((e) => want.has(e.id))
            label = `🔍 Zoomed in to inspect ${targets.length} shape${targets.length > 1 ? 's' : ''}`
          } else if (action.bounds) {
            const b: Box = {
              x: action.bounds.x + origin.x,
              y: action.bounds.y + origin.y,
              w: action.bounds.w,
              h: action.bounds.h,
            }
            targets = scene.filter((e) =>
              boxIntersects({ x: e.x, y: e.y, w: e.width, h: e.height }, b)
            )
            label = '🔍 Zoomed in to take a closer look'
          }
          if (targets.length > 0) {
            api.scrollToContent(targets, {
              fitToViewport: true,
              viewportZoomFactor: 0.8,
              animate: false,
            })
            push({ kind: 'action', text: label })
          }
          break
        }

        case 'review':
          // The model wants to take another look — drives a critique pass.
          reviewRequestedRef.current = true
          break
      }
    },
    [api, applyToCanvas, applyPositions, boundsOfId, push]
  )

  // Run one request/response turn against the agent.
  const runTurn = useCallback(
    async (
      message: string,
      history: { role: 'user' | 'assistant'; text: string }[],
      signal: AbortSignal,
      issues?: string[]
    ) => {
      await settle()
      const ctx = await gatherContext(api!, originRef.current)
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
        },
        handleAction,
        signal
      )
    },
    [api, handleAction]
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
      userViewRef.current = null

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

        // Stable chat origin for this turn: the viewport top-left right now.
        const startState = api.getAppState()
        const vp = getViewportBounds(startState)
        originRef.current = { x: vp.x, y: vp.y }
        // Remember the user's camera so we can restore it after the agent roams.
        userViewRef.current = {
          scrollX: startState.scrollX,
          scrollY: startState.scrollY,
          zoom: startState.zoom,
        }

        reviewRequestedRef.current = false
        await runTurn(task, baseHistory, controller.signal)

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
          await runTurn(buildCritiquePrompt(task, issues), reviewHistory, controller.signal, issues)
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          push({ kind: 'error', text: err?.message || 'Something went wrong.' })
        }
      } finally {
        // Return the camera to where the user left it.
        const uv = userViewRef.current
        if (uv) {
          try {
            api.updateScene({
              appState: { scrollX: uv.scrollX, scrollY: uv.scrollY, zoom: uv.zoom },
            })
          } catch {
            // ignore
          }
        }
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
    setChat([])
  }, [])

  return { chat, isGenerating, sendMessage, stop, newChat, respondToSavePrompt }
}

function describeCreate(shape: AgentShape): string {
  if (shape.type === 'arrow') {
    if (shape.fromId && shape.toId) return `Arrow ${shape.fromId} → ${shape.toId}`
    return 'Drew an arrow'
  }
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
