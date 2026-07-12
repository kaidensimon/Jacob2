import { useEffect, useRef, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { Box } from './geometry'

const W = 92
const H = 92

/**
 * The little Jacob character that waddles onto the canvas and "draws" while
 * the chat agent is generating. He stands at the bottom-right corner of the
 * agent's viewport (tracking pan/zoom), scribbles with a pencil wiggle, and
 * walks off when the request finishes. Pure decoration — pointer-events: none.
 */
export function JacobSprite({
  api,
  view,
  active,
}: {
  api: ExcalidrawImperativeAPI | null
  view: Box | null
  active: boolean
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [show, setShow] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const rafRef = useRef<number | undefined>(undefined)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Appear while drawing; play the walk-off animation before unmounting.
  useEffect(() => {
    if (active && view) {
      clearTimeout(hideTimer.current)
      setShow(true)
      setLeaving(false)
    } else {
      setLeaving(true)
      hideTimer.current = setTimeout(() => setShow(false), 550)
    }
    return () => clearTimeout(hideTimer.current)
  }, [active, view])

  // Track the agent viewport's bottom-right corner across pan/zoom.
  useEffect(() => {
    if (!api || !view || !show) {
      setPos(null)
      return
    }
    let live = true
    const tick = () => {
      if (!live) return
      const a = api.getAppState() as any
      const zoom = a.zoom?.value ?? 1
      // Anchor at the viewport's bottom-right corner, but clamp onto the
      // visible canvas so he never gets clipped off the edge of the screen.
      let left = (view.x + view.w + a.scrollX) * zoom - W * 0.4
      let top = (view.y + view.h + a.scrollY) * zoom - H + 6
      const cw = a.width ?? window.innerWidth
      const ch = a.height ?? window.innerHeight
      left = Math.max(10, Math.min(left, cw - W - 10))
      top = Math.max(10, Math.min(top, ch - H - 10))
      setPos({ left, top })
      rafRef.current = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      live = false
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [api, view, show])

  if (!show || !pos) return null

  return (
    <div
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 5 }}
    >
      <div
        className={`jacob-sprite${leaving ? ' jacob-sprite-leave' : ''}`}
        style={{ left: pos.left, top: pos.top, width: W, height: H }}
      >
        <img className="jacob-sprite-img" src="/jacob-sprite.png" alt="" draggable={false} />
      </div>
    </div>
  )
}
