import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Excalidraw, MainMenu, WelcomeScreen, exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { useAuth } from '../context/AuthContext'
import apiClient from '../api'
import { ChatPanel } from '../excalidraw-agent/ChatPanel'
import { useExcalidrawAgent } from '../excalidraw-agent/useExcalidrawAgent'
import { AgentViewOverlay } from '../excalidraw-agent/AgentViewOverlay'
import { JacobSprite } from '../excalidraw-agent/JacobSprite'
import { GrapherModal } from '../grapher/GrapherModal'
import { GrapherBoundary } from '../grapher/GrapherBoundary'
import { useLessonPlayer } from '../lesson/useLessonPlayer'

const STORAGE_KEY = 'excalidraw-session'

type SavedScene = {
  elements: readonly ExcalidrawElement[]
  appState: Partial<AppState>
  files?: any
}

function loadLocalScene(): SavedScene | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const data = JSON.parse(raw)
    return {
      elements: data.elements ?? [],
      appState: { ...(data.appState ?? {}), collaborators: [] },
      files: data.files,
    }
  } catch {
    return undefined
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onloadend = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(blob)
  })
}

export default function Whiteboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const sessionId = searchParams.get('session')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [initialData, setInitialData] = useState<SavedScene | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  // The saved-session identity (id is set once it's been saved to the account).
  const [session, setSession] = useState<{ id?: number; title: string }>({
    title: 'Untitled whiteboard',
  })
  const [grapher, setGrapher] = useState<
    { mode: '2d' | '3d'; expressions?: string[]; key: number } | null
  >(null)
  const grapherKey = useRef(0)

  const openGrapher = useCallback(
    (mode: '2d' | '3d', expressions?: string[]) =>
      setGrapher({ mode, expressions, key: grapherKey.current++ }),
    []
  )

  const agent = useExcalidrawAgent(api, openGrapher)
  // Voice "show me this as an animation" → the chat orchestrator, whose router
  // sends it down the Manim pipeline (video + save prompt appear in the chat).
  const onVoiceAnimate = useCallback(
    (prompt: string) => void agent.sendMessage(`Create a visual animation of: ${prompt}`),
    [agent.sendMessage]
  )
  const lesson = useLessonPlayer(api, onVoiceAnimate)

  // ── Dev-only R&D test bridge ────────────────────────────────────────────────
  // Exposes the Excalidraw API + agent handles on `window.__ex` so the Playwright
  // harness can send prompts, know when generation finishes, export the whole
  // scene to PNG, and run the real overlap detector. Stripped from prod builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as any).__ex = {
      api,
      send: agent.sendMessage,
      stop: agent.stop,
      newChat: agent.newChat,
      // Full reset for isolated test runs: wipe the canvas AND the agent state.
      reset() {
        agent.newChat()
        api?.updateScene({ elements: [] })
      },
      isGenerating: agent.isGenerating,
      chat: agent.chat,
      agentView: agent.agentView,
      async exportScene() {
        if (!api) return null
        const els = api.getSceneElements().filter((e) => !e.isDeleted)
        if (els.length === 0) return null
        const blob = await exportToBlob({
          elements: els,
          appState: { ...api.getAppState(), exportBackground: true },
          files: api.getFiles(),
          mimeType: 'image/png',
          exportPadding: 24,
          getDimensions: (w: number, h: number) => {
            const max = 1600
            const s = Math.min(1, max / Math.max(w, h))
            return { width: w * s, height: h * s, scale: s }
          },
        })
        return await blobToDataUrl(blob)
      },
      async issues() {
        if (!api) return []
        const { detectIssues } = await import('../excalidraw-agent/detect')
        return detectIssues(api.getSceneElements())
      },
    }
  }, [api, agent.sendMessage, agent.stop, agent.newChat, agent.isGenerating, agent.chat, agent.agentView])

  // Load the scene: from the account if ?session=<id>, else from localStorage.
  useEffect(() => {
    let cancelled = false
    async function load() {
      if (sessionId) {
        try {
          const res = await apiClient.get(`/whiteboards/${sessionId}/`)
          if (cancelled) return
          const { id, title, scene } = res.data
          setInitialData({
            elements: scene.elements ?? [],
            appState: { ...(scene.appState ?? {}), collaborators: [] },
            files: scene.files,
          })
          setSession({ id, title })
        } catch {
          if (!cancelled) setInitialData(loadLocalScene())
        }
      } else {
        setInitialData(loadLocalScene())
      }
      if (!cancelled) setLoaded(true)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState) => {
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        try {
          const { collaborators, ...persistableAppState } = appState
          void collaborators
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ elements, appState: persistableAppState })
          )
        } catch {
          // ignore quota / serialization errors
        }
      }, 500)
    },
    []
  )

  // Save the current canvas to the user's account (with a thumbnail).
  const saveToAccount = useCallback(
    async (asNew: boolean) => {
      if (!api) return
      const defaultTitle = asNew ? '' : session.title
      const title = window.prompt('Name this whiteboard:', defaultTitle)
      if (title === null) return // cancelled

      const elements = api.getSceneElements()
      const appState = api.getAppState()
      const files = api.getFiles()

      let thumbnail: string | undefined
      try {
        if (elements.length > 0) {
          const blob = await exportToBlob({
            elements,
            appState: { ...appState, exportBackground: true },
            files,
            mimeType: 'image/png',
            exportPadding: 16,
            getDimensions: (w, h) => {
              const max = 480
              const s = Math.min(1, max / Math.max(w, h))
              return { width: w * s, height: h * s, scale: s }
            },
          })
          thumbnail = await blobToDataUrl(blob)
        }
      } catch {
        thumbnail = undefined
      }

      const { collaborators, ...persistableAppState } = appState
      void collaborators
      const scene = { elements, appState: persistableAppState, files }

      try {
        const res = await apiClient.post('/whiteboards/save/', {
          id: asNew ? undefined : session.id,
          title: title.trim() || 'Untitled whiteboard',
          scene,
          thumbnail,
        })
        setSession({ id: res.data.id, title: res.data.title })
        api.setToast({ message: `Saved “${res.data.title}”`, duration: 2500 })
      } catch {
        api.setToast({ message: 'Could not save whiteboard', duration: 3000 })
      }
    },
    [api, session]
  )

  useEffect(() => () => clearTimeout(saveTimer.current), [])

  if (!user) {
    navigate('/signin')
    return null
  }
  if (!loaded) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#666',
        }}
      >
        Loading whiteboard…
      </div>
    )
  }

  return (
    <div className="ex-layout">
      <div className="ex-canvas" style={{ position: 'relative' }}>
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={initialData}
          onChange={handleChange}
        >
          <MainMenu>
            <MainMenu.Item
              onSelect={() => navigate('/dashboard')}
              icon={
                <span style={{ fontSize: 16, lineHeight: 1 }} aria-hidden>
                  ←
                </span>
              }
            >
              Back to Dashboard
            </MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.Item onSelect={() => saveToAccount(false)}>
              {session.id ? 'Save whiteboard' : 'Save to my account'}
            </MainMenu.Item>
            {session.id && (
              <MainMenu.Item onSelect={() => saveToAccount(true)}>
                Save as a copy
              </MainMenu.Item>
            )}
            <MainMenu.Separator />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.DefaultItems.ToggleTheme />
          </MainMenu>
          <WelcomeScreen>
            <WelcomeScreen.Center>
              <WelcomeScreen.Center.Logo>Whiteboard</WelcomeScreen.Center.Logo>
              <WelcomeScreen.Center.Heading>
                Draw, or ask the AI assistant on the right →
              </WelcomeScreen.Center.Heading>
            </WelcomeScreen.Center>
          </WelcomeScreen>
        </Excalidraw>

        {lesson.digest && (
          <button
            onClick={lesson.moveOn}
            style={{
              position: 'absolute', bottom: 84, left: '50%', transform: 'translateX(-50%)',
              zIndex: 7, border: 'none', borderRadius: 8, padding: '9px 20px',
              fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#fff',
              background: '#4f46e5',
              boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
            }}
          >
            Ready to move on →
          </button>
        )}

        {lesson.caption && (
          <div
            style={{
              position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
              zIndex: 6, maxWidth: '72%', textAlign: 'center',
              background: 'rgba(24,24,27,0.88)', color: '#fff', borderRadius: 10,
              padding: '10px 16px', fontSize: 15, lineHeight: 1.4,
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            }}
          >
            {lesson.caption}
          </div>
        )}

        <AgentViewOverlay
          api={api}
          view={agent.agentView}
          name={agent.agentName}
          onGoto={agent.goToAgentView}
        />
        <JacobSprite api={api} view={agent.agentView} active={agent.isGenerating} />
        {agent.agentView && (
          <button
            onClick={agent.goToAgentView}
            style={{
              position: 'absolute',
              bottom: 18,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 5,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              background: '#1e1e1e',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
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
            Go to {agent.agentName}'s view ↗
          </button>
        )}
      </div>

      <div className="ex-sidebar">
        <ChatPanel
          chat={agent.chat}
          isGenerating={agent.isGenerating}
          onSend={agent.sendMessage}
          onStop={agent.stop}
          onNewChat={agent.newChat}
          onSaveAnimation={agent.respondToSavePrompt}
          onOpenGrapher={openGrapher}
          voiceTutor={{
            on: lesson.voiceOn,
            toggle: lesson.toggleVoice,
            status: lesson.status,
            transcript: lesson.transcript,
          }}
        />
      </div>

      {grapher && (
        <GrapherBoundary key={grapher.key} onClose={() => setGrapher(null)}>
          <GrapherModal
            mode={grapher.mode}
            initialExpressions={grapher.expressions}
            onClose={() => setGrapher(null)}
          />
        </GrapherBoundary>
      )}
    </div>
  )
}
