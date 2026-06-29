import { useEffect, useRef, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { Box } from './geometry'

/**
 * Renders a dashed "<name>'s view" rectangle over the canvas, tracking the
 * agent's independent viewport (in scene coords) as the user pans/zooms — like
 * tldraw's agent-viewport highlight. Clicking the label jumps the user there.
 */
export function AgentViewOverlay({
  api,
  view,
  name,
  onGoto,
}: {
  api: ExcalidrawImperativeAPI | null
  view: Box | null
  name: string
  onGoto?: () => void
}) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null
  )
  const rafRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!api || !view) {
      setRect(null)
      return
    }
    let active = true
    const tick = () => {
      if (!active) return
      const a = api.getAppState() as any
      const zoom = a.zoom?.value ?? 1
      // Excalidraw: a scene point maps to (sceneX + scrollX) * zoom within the
      // canvas container.
      setRect({
        left: (view.x + a.scrollX) * zoom,
        top: (view.y + a.scrollY) * zoom,
        width: view.w * zoom,
        height: view.h * zoom,
      })
      rafRef.current = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      active = false
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [api, view])

  if (!rect) return null

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 4,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          border: '2px dashed #6741d9',
          borderRadius: 6,
          background: 'rgba(103, 65, 217, 0.03)',
          boxSizing: 'border-box',
        }}
      >
        <button
          onClick={onGoto}
          title={onGoto ? `Go to ${name}'s view` : undefined}
          style={{
            position: 'absolute',
            top: -27,
            left: -2,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: '#1e1e1e',
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1,
            padding: '5px 9px',
            borderRadius: 5,
            border: 'none',
            whiteSpace: 'nowrap',
            cursor: onGoto ? 'pointer' : 'default',
            pointerEvents: onGoto ? 'auto' : 'none',
            boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#51cf66',
              display: 'inline-block',
            }}
          />
          {name}'s view
        </button>
      </div>
    </div>
  )
}
