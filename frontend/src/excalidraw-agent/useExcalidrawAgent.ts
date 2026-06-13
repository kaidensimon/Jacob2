import { useCallback, useRef, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { shapesToElements } from './convert'
import type { Bounds } from './convert'
import { gatherContext, streamAgent } from './agentClient'
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

export function useExcalidrawAgent(api: ExcalidrawImperativeAPI | null) {
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

  const sendMessage = useCallback(
    async (text: string) => {
      if (!api || !text.trim() || isGenerating) return

      push({ kind: 'user', text })
      setIsGenerating(true)

      // Forget any agent shapes the user deleted before this prompt, so they
      // aren't resurrected when the agent renders again.
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

      const baseHistory = chat
        .filter((c) => c.kind === 'user' || c.kind === 'message')
        .map((c) => ({
          role: (c.kind === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          text: c.text,
        }))

      const controller = new AbortController()
      abortRef.current = controller

      try {
        reviewRequestedRef.current = false
        await runTurn(text, baseHistory, controller.signal)

        // Critique passes. The detector now only flags OBJECTIVE readability
        // problems (text-on-text, text-on-arrow, arrows through shapes — never
        // intentional nesting), so we drive the loop with it: keep cleaning up
        // while real problems remain OR the model wants another look. A stall
        // guard stops us spinning on something that isn't improving.
        const reviewHistory = [...baseHistory, { role: 'user' as const, text }]
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
          await runTurn(buildCritiquePrompt(text, issues), reviewHistory, controller.signal, issues)
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
    [api, chat, isGenerating, push, runTurn, reconcileDeleted]
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const newChat = useCallback(() => {
    abortRef.current?.abort()
    shapesRef.current = new Map()
    agentElementIdsRef.current = new Set()
    setChat([])
  }, [])

  return { chat, isGenerating, sendMessage, stop, newChat }
}

function describeCreate(shape: AgentShape): string {
  if (shape.type === 'arrow') {
    if (shape.fromId && shape.toId) return `Arrow ${shape.fromId} → ${shape.toId}`
    return 'Drew an arrow'
  }
  const label = shape.text ? ` “${shape.text}”` : ''
  return `Drew ${shape.type}${label}`
}
