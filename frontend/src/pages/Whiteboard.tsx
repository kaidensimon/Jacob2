import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Excalidraw, MainMenu, WelcomeScreen } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { useAuth } from '../context/AuthContext'
import { ChatPanel } from '../excalidraw-agent/ChatPanel'
import { useExcalidrawAgent } from '../excalidraw-agent/useExcalidrawAgent'

const STORAGE_KEY = 'excalidraw-session'

type SavedScene = {
  elements: readonly ExcalidrawElement[]
  appState: Partial<AppState>
}

function loadScene(): SavedScene | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const data = JSON.parse(raw)
    return {
      elements: data.elements ?? [],
      appState: { ...(data.appState ?? {}), collaborators: [] },
    }
  } catch {
    return undefined
  }
}

export default function Whiteboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [initialData] = useState<SavedScene | undefined>(() => loadScene())

  const agent = useExcalidrawAgent(api)

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

  useEffect(() => () => clearTimeout(saveTimer.current), [])

  if (!user) {
    navigate('/signin')
    return null
  }

  return (
    <div className="ex-layout">
      <div className="ex-canvas">
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
      </div>

      <div className="ex-sidebar">
        <ChatPanel
          chat={agent.chat}
          isGenerating={agent.isGenerating}
          onSend={agent.sendMessage}
          onStop={agent.stop}
          onNewChat={agent.newChat}
        />
      </div>
    </div>
  )
}
