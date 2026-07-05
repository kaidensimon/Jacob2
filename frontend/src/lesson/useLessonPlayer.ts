import { useCallback, useEffect, useRef, useState } from 'react'
import { exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { shapesToElements } from '../excalidraw-agent/convert'
import type { AgentShape } from '../excalidraw-agent/types'
import { renderLatexToImage } from '../excalidraw-agent/mathRender'

// Browser half of Voice Tutor Mode. The backend LessonConsumer (ws/lesson/) is
// the brain: it plans + conducts lessons, drives Rime TTS, and runs Deepgram STT
// for voice commands + barge-in. Here we render shapes into the EXISTING
// Excalidraw canvas (hidden → faded in), follow with the camera, play the audio,
// and stream the mic up as PCM16.

const WS_URL = 'ws://localhost:8000/ws/lesson/'

// Summarise what the user has selected on the canvas so the backend intent router
// can "look at what you selected" (text/latex, and the first selected image).
function readSelection(api: ExcalidrawImperativeAPI) {
  const st: any = api.getAppState()
  const selIds = new Set(
    Object.keys(st.selectedElementIds || {}).filter((id) => st.selectedElementIds[id])
  )
  const parts: string[] = []
  let image: string | undefined
  for (const e of api.getSceneElements()) {
    const isSel = selIds.has(e.id)
    const isChild = (e as any).containerId && selIds.has((e as any).containerId)
    if (!isSel && !isChild) continue
    const latex = (e as any).customData?.latex
    if (latex) parts.push(latex)
    else if ((e as any).text) parts.push((e as any).text)
    if (e.type === 'image' && (e as any).fileId && !image) {
      const f: any = (api.getFiles() as any)[(e as any).fileId]
      if (f?.dataURL) image = f.dataURL
    }
  }
  return { count: selIds.size, text: parts.join('; ').slice(0, 2000), image }
}

// Export the whole board as a PNG dataURL — injected into the sidebar
// elaboration agent so a fresh context can SEE what's been drawn.
async function snapshotBoard(api: ExcalidrawImperativeAPI): Promise<string | null> {
  const els = api.getSceneElements().filter((e) => !e.isDeleted)
  if (els.length === 0) return null
  const blob = await exportToBlob({
    elements: els,
    appState: { ...api.getAppState(), exportBackground: true },
    files: api.getFiles(),
    mimeType: 'image/png',
    exportPadding: 24,
    getDimensions: (w: number, h: number) => {
      const max = 1200
      const s = Math.min(1, max / Math.max(w, h))
      return { width: w * s, height: h * s, scale: s }
    },
  })
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onloadend = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(blob)
  })
}

type PlayerStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'teaching' | 'error'

export function useLessonPlayer(
  api: ExcalidrawImperativeAPI | null,
  onAnimate?: (prompt: string) => void
) {
  const [status, setStatus] = useState<PlayerStatus>('idle')
  const [voiceOn, setVoiceOn] = useState(false)
  const [caption, setCaption] = useState('')
  const [transcript, setTranscript] = useState('')
  // post-cleanup "digest" window: true while the ready-to-move-on button shows
  const [digest, setDigest] = useState(false)
  // true while a TTS clip is actually playing — drives the talking sprite
  const [speaking, setSpeaking] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const lessonElsRef = useRef<Set<string>>(new Set())
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const mimeRef = useRef('audio/mpeg')
  // Progressive playback (MediaSource): play chunks as they stream in instead
  // of waiting for the whole clip. chunksRef stays as the fallback path.
  const msRef = useRef<MediaSource | null>(null)
  const sbRef = useRef<SourceBuffer | null>(null)
  const pendingRef = useRef<ArrayBuffer[]>([])
  const streamingRef = useRef(false)
  const streamEndedRef = useRef(false)
  const gotBytesRef = useRef(false)
  // mic
  const micCtxRef = useRef<AudioContext | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  // keep the latest callback without retriggering the ws handler
  const onAnimateRef = useRef(onAnimate)
  onAnimateRef.current = onAnimate

  const send = (obj: any) => wsRef.current?.send(JSON.stringify(obj))
  const ack = useCallback(() => {
    setSpeaking(false)
    send({ type: 'audioEnded' })
  }, [])

  // ── canvas reveal ────────────────────────────────────────────────────────────
  // Shapes don't pop in as one clump: each fades in over REVEAL_MS, staggered
  // REVEAL_STAGGER apart in the order the beat introduces them, so the board
  // looks like it's being drawn out while Jacob talks.
  const REVEAL_STAGGER = 180
  const REVEAL_MS = 320
  const animsRef = useRef<Map<string, number>>(new Map()) // elementId -> start time
  const animRafRef = useRef<number | undefined>(undefined)

  const pumpReveal = useCallback(() => {
    const anims = animsRef.current
    if (!api || anims.size === 0) {
      animRafRef.current = undefined
      return
    }
    const now = performance.now()
    let changed = false
    const els = api.getSceneElements().map((e) => {
      const start = anims.get(e.id)
      if (start === undefined) return e
      const t = (now - start) / REVEAL_MS
      if (t < 0) return e // this shape's turn hasn't come yet
      if (t >= 1) anims.delete(e.id)
      changed = true
      return { ...e, opacity: Math.min(100, Math.round(100 * t)) } as ExcalidrawElement
    })
    if (changed) api.updateScene({ elements: els })
    animRafRef.current = requestAnimationFrame(pumpReveal)
  }, [api])

  const revealIds = useCallback(
    (ids: string[], camera: boolean) => {
      if (!api) return
      const now = performance.now()
      const startFor = new Map<string, number>()
      ids.forEach((id, i) => startFor.set(id, now + i * REVEAL_STAGGER))
      const revealed: ExcalidrawElement[] = []
      for (const e of api.getSceneElements()) {
        const start =
          startFor.get(e.id) ??
          ((e as any).containerId ? startFor.get((e as any).containerId) : undefined)
        if (start === undefined || (e as any).opacity === 100) continue
        animsRef.current.set(e.id, start) // bound labels share their box's turn
        revealed.push(e)
      }
      if (camera && revealed.length) {
        try {
          api.scrollToContent(revealed, { fitToContent: true, animate: true, duration: 500 } as any)
        } catch { /* older API */ }
      }
      if (animsRef.current.size > 0 && animRafRef.current === undefined) {
        animRafRef.current = requestAnimationFrame(pumpReveal)
      }
    },
    [api, pumpReveal]
  )

  useEffect(() => () => {
    if (animRafRef.current) cancelAnimationFrame(animRafRef.current)
  }, [])

  const loadShapes = useCallback(
    async (shapes: AgentShape[], origin: { x: number; y: number }) => {
      if (!api) return
      const map = new Map<string, AgentShape>()
      for (const s of shapes) {
        const shape: AgentShape = { ...s }
        if (typeof shape.x === 'number') shape.x += origin.x
        if (typeof shape.y === 'number') shape.y += origin.y
        map.set(shape.id, shape)
      }
      await Promise.all(
        [...map.values()]
          .filter((s) => s.type === 'math' && (s.latex || s.text))
          .map(async (s) => {
            try {
              const { dataUrl, width, height } = await renderLatexToImage(s.latex ?? s.text ?? '', {
                fontSize: s.fontSize ?? 20, color: s.strokeColor || '#1e1e1e',
              })
              const fileId = `lesson-math-${s.id}`
              api.addFiles([{ id: fileId as any, mimeType: 'image/png', dataURL: dataUrl as any,
                created: Date.now(), lastRetrieved: Date.now() } as any])
              map.set(s.id, { ...s, fileId, width, height })
            } catch { /* skip */ }
          })
      )
      const converted = shapesToElements(map, new Map())
      for (const el of converted) lessonElsRef.current.add(el.id)
      const hidden = converted.map((e) => ({ ...e, opacity: 0 }) as ExcalidrawElement)
      const userEls = api.getSceneElements().filter((e) => !lessonElsRef.current.has(e.id))
      api.updateScene({ elements: [...userEls, ...hidden] })
      // Bring the camera to this section's board right away, so the learner is
      // already looking at the right spot when the first beat starts drawing.
      if (hidden.length) {
        try {
          api.scrollToContent(hidden, { fitToContent: true, animate: true, duration: 600 } as any)
        } catch { /* older API */ }
      }
    },
    [api]
  )

  // ── audio ────────────────────────────────────────────────────────────────────
  const stopAudio = useCallback(() => {
    setSpeaking(false)
    streamingRef.current = false
    pendingRef.current = []
    sbRef.current = null
    msRef.current = null
    if (audioRef.current) {
      const a = audioRef.current
      audioRef.current = null
      a.onended = null; a.onerror = null
      a.pause()
      if (a.src.startsWith('blob:')) URL.revokeObjectURL(a.src)
      a.removeAttribute('src')
    }
    window.speechSynthesis?.cancel()
  }, [])

  // Feed the SourceBuffer one pending chunk at a time; close the stream once
  // the server said audioEnd and everything has been appended.
  const pump = useCallback(() => {
    const ms = msRef.current, sb = sbRef.current
    if (!ms || !sb || ms.readyState !== 'open' || sb.updating) return
    const next = pendingRef.current.shift()
    if (next) {
      try { sb.appendBuffer(next) } catch { stopAudio(); ack() }
    } else if (streamEndedRef.current) {
      try { ms.endOfStream() } catch { /* already closed */ }
    }
  }, [ack, stopAudio])

  const startStream = useCallback((mime: string) => {
    const ms = new MediaSource()
    msRef.current = ms
    streamingRef.current = true
    streamEndedRef.current = false
    gotBytesRef.current = false
    pendingRef.current = []
    const audio = new Audio(URL.createObjectURL(ms))
    audioRef.current = audio
    audio.onended = ack
    audio.onerror = ack
    audio.onplaying = () => setSpeaking(true)
    ms.addEventListener('sourceopen', () => {
      if (msRef.current !== ms) return // barged in before the source opened
      URL.revokeObjectURL(audio.src)
      const sb = ms.addSourceBuffer(mime)
      sbRef.current = sb
      sb.addEventListener('updateend', pump)
      sb.addEventListener('error', () => { stopAudio(); ack() })
      pump()
    })
    audio.play().catch(ack) // starts as soon as the first chunk is buffered
  }, [ack, pump, stopAudio])

  const playClip = useCallback(() => {
    const blob = new Blob(chunksRef.current, { type: mimeRef.current })
    chunksRef.current = []
    const audio = new Audio(URL.createObjectURL(blob))
    audioRef.current = audio
    audio.onended = ack
    audio.onerror = ack
    audio.onplaying = () => setSpeaking(true)
    audio.play().catch(ack)
  }, [ack])

  const speakFallback = useCallback((text: string) => {
    if (!('speechSynthesis' in window) || !text.trim()) return ack()
    const u = new SpeechSynthesisUtterance(text)
    u.onstart = () => setSpeaking(true)
    u.onend = ack; u.onerror = ack
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(u)
  }, [ack])

  // ── message handling ──────────────────────────────────────────────────────────
  const handle = useCallback(
    async (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') {
        if (streamingRef.current) {
          gotBytesRef.current = true
          pendingRef.current.push(ev.data)
          pump()
        } else {
          chunksRef.current.push(ev.data)
        }
        return
      }
      const msg = JSON.parse(ev.data)
      switch (msg.type) {
        case 'getContext':
          send({ type: 'context', selection: api ? readSelection(api) : {} })
          break
        case 'getSnapshot': {
          let image: string | null = null
          try {
            if (api) image = await snapshotBoard(api)
          } catch { /* empty/unavailable board */ }
          send({ type: 'snapshot', image })
          break
        }
        case 'animate': onAnimateRef.current?.(msg.prompt || ''); break
        case 'getIssues': {
          // Run the real readability detector on JUST this section's elements.
          let issues: string[] = []
          try {
            if (api) {
              const { detectIssues } = await import('../excalidraw-agent/detect')
              const ids = new Set<string>(msg.ids || [])
              const els = api
                .getSceneElements()
                .filter((e) => ids.has(e.id) || ids.has((e as any).containerId))
              issues = detectIssues(els).map((i: any) => i.desc)
            }
          } catch { /* detector unavailable */ }
          send({ type: 'issues', issues })
          break
        }
        case 'replaceShapes':
          // Cleaned-up section: loadShapes drops the old lesson elements and
          // converts the fixed ones; reveal everything at once, camera on it.
          await loadShapes(msg.shapes, msg.origin)
          revealIds((msg.shapes || []).map((s: AgentShape) => s.id), true)
          break
        case 'digest': setDigest(true); break
        case 'digestDone': setDigest(false); break
        case 'listening': setStatus('listening'); break
        case 'thinking': setStatus('thinking'); break
        case 'lessonStarted': setStatus('teaching'); setCaption(''); break
        case 'loadShapes': await loadShapes(msg.shapes, msg.origin); break
        case 'reveal': revealIds(msg.ids, msg.camera); break
        case 'emphasize': break
        case 'beat': setCaption(msg.say); break
        case 'answer': setCaption(msg.text); break
        case 'audioStart': {
          stopAudio()
          const mime = msg.mime || 'audio/mpeg'
          mimeRef.current = mime
          if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime)) {
            startStream(mime)
          } else {
            chunksRef.current = []
          }
          break
        }
        case 'audioEnd':
          if (streamingRef.current) {
            if (!gotBytesRef.current) { stopAudio(); ack() } // empty clip — nothing to play
            else { streamEndedRef.current = true; pump() }
          } else {
            playClip()
          }
          break
        case 'speak': stopAudio(); speakFallback(msg.text); break
        case 'stopAudio': stopAudio(); break
        case 'transcript': setTranscript(msg.final ? '' : msg.text); break
        case 'sectionDone': break
        case 'lessonDone': setStatus(voiceOn ? 'listening' : 'idle'); setCaption(''); setDigest(false); break
        case 'error': console.error('lesson error:', msg.message); break
      }
    },
    [api, loadShapes, revealIds, playClip, speakFallback, stopAudio, startStream, pump, ack, voiceOn]
  )

  const connect = useCallback(
    () =>
      new Promise<WebSocket>((resolve, reject) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) return resolve(wsRef.current)
        setStatus('connecting')
        const token = localStorage.getItem('access_token') ?? ''
        const ws = new WebSocket(`${WS_URL}?token=${token}`)
        ws.binaryType = 'arraybuffer'
        ws.onmessage = handle
        ws.onclose = () => { wsRef.current = null }
        ws.onerror = () => reject(new Error('WebSocket failed'))
        ws.addEventListener('message', function onReady(e) {
          if (typeof e.data === 'string' && JSON.parse(e.data).type === 'ready') {
            ws.removeEventListener('message', onReady); wsRef.current = ws; resolve(ws)
          }
        })
      }),
    [handle]
  )

  // ── mic capture → PCM16 16k mono → consumer ───────────────────────────────────
  const startMic = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    micStreamRef.current = stream
    const ctx = new AudioContext({ sampleRate: 16000 })
    micCtxRef.current = ctx
    const src = ctx.createMediaStreamSource(stream)
    const proc = ctx.createScriptProcessor(4096, 1, 1)
    proc.onaudioprocess = (e) => {
      const f32 = e.inputBuffer.getChannelData(0)
      const i16 = new Int16Array(f32.length)
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]))
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(i16.buffer)
    }
    src.connect(proc); proc.connect(ctx.destination)
  }, [])

  const stopMic = useCallback(() => {
    micCtxRef.current?.close().catch(() => {})
    micCtxRef.current = null
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
  }, [])

  // ── public controls ───────────────────────────────────────────────────────────
  const enableVoice = useCallback(async () => {
    try {
      await connect()
      await startMic()
      send({ type: 'voiceOn' })
      setVoiceOn(true)
      setStatus('listening')
    } catch (e) {
      console.error(e); setStatus('error')
    }
  }, [connect, startMic])

  const disableVoice = useCallback(() => {
    stopMic(); stopAudio()
    send({ type: 'voiceOff' }); send({ type: 'stop' })
    setVoiceOn(false); setStatus('idle'); setCaption(''); setTranscript(''); setDigest(false)
  }, [stopMic, stopAudio])

  // "Ready to move on" — skips the post-cleanup digest timer.
  const moveOn = useCallback(() => {
    send({ type: 'moveOn' })
    setDigest(false)
  }, [])

  const toggleVoice = useCallback(() => {
    if (voiceOn) disableVoice(); else void enableVoice()
  }, [voiceOn, enableVoice, disableVoice])

  // Typed trigger (optional convenience alongside voice).
  const teach = useCallback(async (topic: string) => {
    if (!topic.trim()) return
    await connect(); send({ type: 'startLesson', topic })
  }, [connect])

  return { toggleVoice, enableVoice, disableVoice, teach, voiceOn, status, caption, transcript, digest, moveOn, speaking }
}
