import { exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { AgentAction } from './types'
import {
  type Box,
  type PeripheralCluster,
  type Vec,
  boxIntersects,
  clusterShapes,
  roundBox,
} from './geometry'

const STREAM_URL = 'http://localhost:8000/api/excalidraw/stream/'
const ORCHESTRATOR_URL = 'http://localhost:8000/api/orchestrator/'
const MANIM_GENERATE_URL = 'http://localhost:8000/api/manim/generate/'
const MANIM_SAVE_URL = 'http://localhost:8000/api/manim/save/'

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('access_token') ?? ''}`,
})

export interface AnimationResult {
  id: number
  title: string
  videoUrl: string
}

/** Generate (and render) a Manim animation for a topic. Can take a minute. */
export async function generateAnimation(
  task: string,
  signal: AbortSignal
): Promise<AnimationResult> {
  const res = await fetch(MANIM_GENERATE_URL, {
    method: 'POST',
    body: JSON.stringify({ task }),
    headers: authHeaders(),
    signal,
  })
  if (!res.ok) {
    let detail = `Animation failed (HTTP ${res.status})`
    try {
      const data = await res.json()
      if (data?.error) detail = data.error
    } catch {
      // keep generic
    }
    throw new Error(detail)
  }
  return (await res.json()) as AnimationResult
}

/** Read a graphable equation/surface out of an image using vision. */
export async function readEquationFromImage(
  imageDataUrl: string,
  signal: AbortSignal
): Promise<{ dimension: '2d' | '3d'; expressions: string[]; message?: string }> {
  const res = await fetch('http://localhost:8000/api/grapher/read-image/', {
    method: 'POST',
    body: JSON.stringify({ image: imageDataUrl }),
    headers: authHeaders(),
    signal,
  })
  if (!res.ok) {
    let detail = `Image read failed (HTTP ${res.status})`
    try {
      const d = await res.json()
      if (d?.error) detail = d.error
    } catch {
      // keep generic
    }
    throw new Error(detail)
  }
  const d = await res.json()
  return {
    dimension: d.dimension === '3d' ? '3d' : '2d',
    expressions: d.expressions || [],
    message: d.message,
  }
}

/** Persist a generated animation to the user's library. */
export async function saveAnimation(id: number, title?: string): Promise<void> {
  const res = await fetch(MANIM_SAVE_URL, {
    method: 'POST',
    body: JSON.stringify({ id, title }),
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`Save failed (HTTP ${res.status})`)
}

export interface OrchestratorDecision {
  action: 'chat' | 'ask' | 'whiteboard' | 'manim' | 'grapher'
  message?: string
  task?: string
  // For action 'grapher':
  dimension?: '2d' | '3d'
  expressions?: string[]
  source?: 'whiteboard' // the equation to plot is on the whiteboard, not in the message
}

/**
 * Ask the reasoning orchestrator what to do with a user message. It receives
 * ONLY the message + conversation history (no canvas context), and returns a
 * routing decision.
 */
export async function orchestrate(
  message: string,
  history: { role: 'user' | 'assistant'; text: string }[],
  signal: AbortSignal
): Promise<OrchestratorDecision> {
  const token = localStorage.getItem('access_token') ?? ''
  const res = await fetch(ORCHESTRATOR_URL, {
    method: 'POST',
    body: JSON.stringify({ message, history }),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    signal,
  })
  if (!res.ok) {
    let detail = `Orchestrator failed (HTTP ${res.status})`
    try {
      const data = await res.json()
      if (data?.error) detail = data.error
    } catch {
      // keep generic
    }
    throw new Error(detail)
  }
  return (await res.json()) as OrchestratorDecision
}

export interface BlurryShape {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  text?: string
}

export interface AgentContext {
  origin: Vec
  viewport: Box
  blurryShapes: BlurryShape[]
  peripheralClusters: { x: number; y: number; w: number; h: number; count: number }[]
  selectedIds: string[]
  screenshot?: string
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

const offsetBox = (b: Box, origin: Vec): Box => ({
  x: b.x - origin.x,
  y: b.y - origin.y,
  w: b.w,
  h: b.h,
})

/**
 * Gather what the agent "sees", mirroring tldraw's prompt parts:
 *  - viewport bounds (relative to the request origin)
 *  - blurry shapes: shapes inside the viewport, in relative coordinates
 *  - peripheral clusters: shapes outside the viewport, grouped into clusters
 *  - selection + a screenshot
 *
 * `origin` is the chat origin (viewport top-left when the turn started) — all
 * coordinates are sent relative to it so the model reasons about small numbers.
 */
export async function gatherContext(
  api: ExcalidrawImperativeAPI,
  origin: Vec,
  viewport: Box,
  // The region the agent SEES (screenshot + which shapes count as in-view).
  // Defaults to `viewport`, but when there's a selection it's wider than the
  // clear drawing area so the agent can see the selected content too.
  screenshotView: Box = viewport
): Promise<AgentContext> {
  const appState = api.getAppState()

  const all = api.getSceneElements().filter((el) => !el.isDeleted)

  // Map a container's id -> its bound label text.
  const labelByContainer = new Map<string, string>()
  for (const el of all) {
    const cId = (el as any).containerId
    const text = (el as any).text
    if (el.type === 'text' && cId && typeof text === 'string' && text) {
      labelByContainer.set(cId, text)
    }
  }

  // Content shapes (skip bound labels — they travel with their container).
  const content = all.filter((el) => !(el.type === 'text' && (el as any).containerId))

  const inViewport: typeof content = []
  const outside: typeof content = []
  for (const el of content) {
    const box: Box = { x: el.x, y: el.y, w: el.width, h: el.height }
    if (boxIntersects(box, screenshotView)) inViewport.push(el)
    else outside.push(el)
  }

  // Blurry shapes (in viewport), relative + rounded.
  const blurryShapes: BlurryShape[] = inViewport.map((el) => {
    const b = roundBox(offsetBox({ x: el.x, y: el.y, w: el.width, h: el.height }, origin))
    const ownText = (el as any).text
    const latex = (el as any).customData?.latex as string | undefined
    const text =
      (latex ? `math: ${latex}` : '') ||
      (typeof ownText === 'string' && ownText) ||
      labelByContainer.get(el.id) ||
      undefined
    return { id: el.id, type: el.type, x: b.x, y: b.y, w: b.w, h: b.h, text }
  })

  // Peripheral clusters (off viewport), relative + rounded.
  const clusters: PeripheralCluster[] = clusterShapes(
    outside.map((el) => ({ x: el.x, y: el.y, w: el.width, h: el.height })),
    { padding: 75 }
  )
  const peripheralClusters = clusters.map((c) => {
    const b = roundBox(offsetBox(c.bounds, origin))
    return { x: b.x, y: b.y, w: b.w, h: b.h, count: c.count }
  })

  const selectedIds = Object.keys(appState.selectedElementIds || {}).filter(
    (id) => appState.selectedElementIds[id]
  )

  // Screenshot what the agent is actually looking at, so when it zooms in via
  // setMyView the image zooms in with it (and it sees any selected content).
  const visibleEls = all.filter((el) =>
    boxIntersects({ x: el.x, y: el.y, w: el.width, h: el.height }, screenshotView)
  )
  let screenshot: string | undefined
  if (visibleEls.length > 0) {
    try {
      const blob = await exportToBlob({
        elements: visibleEls,
        appState: { ...appState, exportBackground: true },
        files: api.getFiles(),
        mimeType: 'image/png',
        exportPadding: 16,
        getDimensions: (w, h) => {
          const max = 1024
          const scale = Math.min(1, max / Math.max(w, h))
          return { width: w * scale, height: h * scale, scale }
        },
      })
      screenshot = await blobToDataUrl(blob)
    } catch {
      screenshot = undefined
    }
  }

  return {
    origin,
    viewport: roundBox(offsetBox(viewport, origin)),
    blurryShapes,
    peripheralClusters,
    selectedIds,
    screenshot,
  }
}

export interface StreamPayload {
  messages: string[]
  viewport: Box
  blurryShapes: BlurryShape[]
  peripheralClusters: { x: number; y: number; w: number; h: number; count: number }[]
  selectedIds: string[]
  screenshot?: string
  history: { role: 'user' | 'assistant'; text: string }[]
  issues?: string[]
  // A correct plot the agent asked for (via the `graphRef` tool), fed back as a
  // drawing reference.
  referenceImage?: string
  referenceNote?: string
}

/**
 * POST a prompt to the Django Excalidraw agent endpoint and invoke `onAction`
 * for each streamed action. SSE protocol: `data: {<action>, complete, time}\n\n`.
 */
export async function streamAgent(
  payload: StreamPayload,
  onAction: (action: AgentAction) => void,
  signal: AbortSignal
): Promise<void> {
  const token = localStorage.getItem('access_token') ?? ''
  const res = await fetch(STREAM_URL, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    signal,
  })

  if (!res.ok || !res.body) {
    let detail = `Request failed (HTTP ${res.status})`
    try {
      const data = await res.json()
      if (data?.error) detail = data.error
    } catch {
      // streaming/empty body — keep the generic message
    }
    throw new Error(detail)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const parts = buffer.split('\n\n')
      buffer = parts.pop() || ''

      for (const part of parts) {
        const match = part.match(/^data: (.+)$/m)
        if (!match) continue
        try {
          onAction(JSON.parse(match[1]) as AgentAction)
        } catch {
          // ignore malformed chunk
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
