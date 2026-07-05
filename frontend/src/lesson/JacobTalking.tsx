import { useEffect, useState } from 'react'

// Mouth cycle for the voice tutor: 1/5 closed, 3 wide open, 2/4 in between.
const FRAMES = [1, 2, 3, 4, 5].map((n) => `/jacob-talk/${n}.png`)
const STILL = '/jacob-sprite.png'
const FRAME_MS = 110

/**
 * Jacob standing on the canvas during Voice Tutor Mode. While a TTS clip is
 * playing his mouth cycles through the talking frames; between clips he
 * reverts to the still sprite. Pure decoration — pointer-events: none.
 */
export function JacobTalking({ visible, speaking }: { visible: boolean; speaking: boolean }) {
  const [frame, setFrame] = useState(0)

  // Preload every frame once so the first talk cycle doesn't flicker.
  useEffect(() => {
    for (const src of [...FRAMES, STILL]) {
      const img = new Image()
      img.src = src
    }
  }, [])

  useEffect(() => {
    if (!speaking) {
      setFrame(0)
      return
    }
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FRAME_MS)
    return () => clearInterval(id)
  }, [speaking])

  if (!visible) return null

  return (
    <div className="jacob-talking">
      <img src={speaking ? FRAMES[frame] : STILL} alt="" draggable={false} />
    </div>
  )
}
