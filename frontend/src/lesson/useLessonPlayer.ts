import { useCallback, useRef, useState } from 'react'
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

type PlayerStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'teaching' | 'error'

export function useLessonPlayer(api: ExcalidrawImperativeAPI | null) {
  const [status, setStatus] = useState<PlayerStatus>('idle')
  const [voiceOn, setVoiceOn] = useState(false)
  const [caption, setCaption] = useState('')
  const [transcript, setTranscript] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const lessonElsRef = useRef<Set<string>>(new Set())
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const mimeRef = useRef('audio/mpeg')
  // mic
  const micCtxRef = useRef<AudioContext | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)

  const send = (obj: any) => wsRef.current?.send(JSON.stringify(obj))
  const ack = useCallback(() => send({ type: 'audioEnded' }), [])

  // ── canvas reveal ────────────────────────────────────────────────────────────
  const revealIds = useCallback(
    (ids: string[], camera: boolean) => {
      if (!api) return
      const set = new Set(ids)
      const revealed: ExcalidrawElement[] = []
      const els = api.getSceneElements().map((e) => {
        if (set.has(e.id) || set.has((e as any).containerId)) {
          revealed.push(e)
          return { ...e, opacity: 100 } as ExcalidrawElement
        }
        return e
      })
      api.updateScene({ elements: els })
      if (camera && revealed.length) {
        try {
          api.scrollToContent(revealed, { fitToContent: true, animate: true, duration: 500 } as any)
        } catch { /* older API */ }
      }
    },
    [api]
  )

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
    },
    [api]
  )

  // ── audio ────────────────────────────────────────────────────────────────────
  const stopAudio = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    window.speechSynthesis?.cancel()
  }, [])

  const playClip = useCallback(() => {
    const blob = new Blob(chunksRef.current, { type: mimeRef.current })
    chunksRef.current = []
    const audio = new Audio(URL.createObjectURL(blob))
    audioRef.current = audio
    audio.onended = ack
    audio.onerror = ack
    audio.play().catch(ack)
  }, [ack])

  const speakFallback = useCallback((text: string) => {
    if (!('speechSynthesis' in window) || !text.trim()) return ack()
    const u = new SpeechSynthesisUtterance(text)
    u.onend = ack; u.onerror = ack
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(u)
  }, [ack])

  // ── message handling ──────────────────────────────────────────────────────────
  const handle = useCallback(
    async (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') { chunksRef.current.push(ev.data); return }
      const msg = JSON.parse(ev.data)
      switch (msg.type) {
        case 'getContext':
          send({ type: 'context', selection: api ? readSelection(api) : {} })
          break
        case 'listening': setStatus('listening'); break
        case 'thinking': setStatus('thinking'); break
        case 'lessonStarted': setStatus('teaching'); setCaption(''); break
        case 'loadShapes': await loadShapes(msg.shapes, msg.origin); break
        case 'reveal': revealIds(msg.ids, msg.camera); break
        case 'emphasize': break
        case 'beat': setCaption(msg.say); break
        case 'answer': setCaption(msg.text); break
        case 'audioStart': chunksRef.current = []; mimeRef.current = msg.mime || 'audio/mpeg'; break
        case 'audioEnd': playClip(); break
        case 'speak': speakFallback(msg.text); break
        case 'stopAudio': stopAudio(); break
        case 'transcript': setTranscript(msg.final ? '' : msg.text); break
        case 'sectionDone': break
        case 'lessonDone': setStatus(voiceOn ? 'listening' : 'idle'); setCaption(''); break
        case 'error': console.error('lesson error:', msg.message); break
      }
    },
    [api, loadShapes, revealIds, playClip, speakFallback, stopAudio, voiceOn]
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
    setVoiceOn(false); setStatus('idle'); setCaption(''); setTranscript('')
  }, [stopMic, stopAudio])

  const toggleVoice = useCallback(() => {
    if (voiceOn) disableVoice(); else void enableVoice()
  }, [voiceOn, enableVoice, disableVoice])

  // Typed trigger (optional convenience alongside voice).
  const teach = useCallback(async (topic: string) => {
    if (!topic.trim()) return
    await connect(); send({ type: 'startLesson', topic })
  }, [connect])

  return { toggleVoice, enableVoice, disableVoice, teach, voiceOn, status, caption, transcript }
}
