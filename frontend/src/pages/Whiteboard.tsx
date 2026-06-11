import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  DefaultSizeStyle,
  ErrorBoundary,
  TLComponents,
  Tldraw,
  TldrawUiToastsProvider,
  TLUiOverrides,
} from 'tldraw'
import { TldrawAgentApp } from '../agent/TldrawAgentApp'
import {
  TldrawAgentAppContextProvider,
  TldrawAgentAppProvider,
} from '../agent/TldrawAgentAppProvider'
import { ChatPanel } from '../components/ChatPanel'
import { ChatPanelFallback } from '../components/ChatPanelFallback'
import { CustomHelperButtons } from '../components/CustomHelperButtons'
import { AgentViewportBoundsHighlights } from '../components/highlights/AgentViewportBoundsHighlights'
import { AllContextHighlights } from '../components/highlights/ContextHighlights'
import { TargetAreaTool } from '../tools/TargetAreaTool'
import { TargetShapeTool } from '../tools/TargetShapeTool'
import { useAuth } from '../context/AuthContext'

DefaultSizeStyle.setDefaultValue('s')

const tools = [TargetShapeTool, TargetAreaTool]
const overrides: TLUiOverrides = {
  tools: (editor, tools) => ({
    ...tools,
    'target-area': {
      id: 'target-area',
      label: 'Pick Area',
      kbd: 'c',
      icon: 'tool-frame',
      onSelect() { editor.setCurrentTool('target-area') },
    },
    'target-shape': {
      id: 'target-shape',
      label: 'Pick Shape',
      kbd: 's',
      icon: 'tool-frame',
      onSelect() { editor.setCurrentTool('target-shape') },
    },
  }),
}

export default function Whiteboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [app, setApp] = useState<TldrawAgentApp | null>(null)

  const handleUnmount = useCallback(() => setApp(null), [])

  const components: TLComponents = useMemo(() => ({
    HelperButtons: () =>
      app && (
        <TldrawAgentAppContextProvider app={app}>
          <CustomHelperButtons />
        </TldrawAgentAppContextProvider>
      ),
    OnTheCanvas: () =>
      app ? (
        <TldrawAgentAppContextProvider app={app}>
          <AgentViewportBoundsHighlights />
          <AllContextHighlights />
        </TldrawAgentAppContextProvider>
      ) : null,
  }), [app])

  if (!user) {
    navigate('/signin')
    return null
  }

  return (
    <TldrawUiToastsProvider>
      <div className="tldraw-agent-container">
        <div className="tldraw-canvas">
          <Tldraw
            persistenceKey="tldraw-agent-session"
            tools={tools}
            overrides={overrides}
            components={components}
          >
            <TldrawAgentAppProvider onMount={setApp} onUnmount={handleUnmount} />
          </Tldraw>
        </div>
        <ErrorBoundary fallback={ChatPanelFallback}>
          {app && (
            <TldrawAgentAppContextProvider app={app}>
              <ChatPanel />
            </TldrawAgentAppContextProvider>
          )}
        </ErrorBoundary>
      </div>
    </TldrawUiToastsProvider>
  )
}
