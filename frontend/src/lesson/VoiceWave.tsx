import { useEffect, useRef } from 'react'

const BARS = 16
const W = 120
const H = 22
const COLOR = '#4f46e5'

/**
 * Live mic waveform for Voice Tutor Mode: symmetric level bars fed by the
 * AnalyserNode tapping the microphone. Reads audio via rAF directly onto a
 * canvas — zero React re-renders. Falls back to a flat dotted line when the
 * mic is quiet or the analyser isn't up yet.
 */
export function VoiceWave({ analyser }: { analyser: React.RefObject<AnalyserNode | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)

    const data = new Uint8Array(64)
    let raf = 0
    const draw = () => {
      ctx.clearRect(0, 0, W, H)
      const a = analyser.current
      if (a) a.getByteFrequencyData(data)
      const step = W / BARS
      ctx.fillStyle = COLOR
      for (let i = 0; i < BARS; i++) {
        // sample the voice-heavy lower half of the spectrum
        const v = a ? data[Math.floor((i / BARS) * (data.length / 2))] / 255 : 0
        const h = Math.max(2, v * (H - 4))
        const x = i * step + step * 0.25
        ctx.globalAlpha = 0.45 + 0.55 * v
        ctx.fillRect(x, (H - h) / 2, step * 0.5, h)
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [analyser])

  return (
    <canvas
      ref={canvasRef}
      className="ex-voice-wave"
      style={{ width: W, height: H, display: 'block' }}
      aria-label="Listening"
    />
  )
}
