import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ChatItem } from './types'
import './chat.css'

interface VoiceTutor {
  on: boolean
  toggle: () => void
  status: string
  transcript: string
}

interface Props {
  chat: ChatItem[]
  isGenerating: boolean
  onSend: (text: string) => void
  onStop: () => void
  onNewChat: () => void
  onSaveAnimation: (animationId: number, title: string, save: boolean) => void
  onOpenGrapher: (mode: '2d' | '3d') => void
  voiceTutor?: VoiceTutor
}

const VOICE_STATUS_LABEL: Record<string, string> = {
  connecting: 'connecting…',
  listening: '🎙️ listening — ask me to teach you something',
  thinking: 'thinking…',
  teaching: 'teaching — talk any time to butt in',
  error: 'voice error — check the mic / keys',
}

export function ChatPanel({
  chat,
  isGenerating,
  onSend,
  onStop,
  onNewChat,
  onSaveAnimation,
  onOpenGrapher,
  voiceTutor,
}: Props) {
  const [value, setValue] = useState('')
  const historyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = historyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat, isGenerating])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = value.trim()
    if (!text || isGenerating) return
    onSend(text)
    setValue('')
  }

  return (
    <div className="ex-chat">
      <div className="ex-chat-header">
        <span className="ex-chat-title">AI Assistant</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {voiceTutor && (
            <button
              className={`ex-voice-toggle${voiceTutor.on ? ' ex-voice-on' : ''}`}
              onClick={voiceTutor.toggle}
              title={voiceTutor.on ? 'Turn off Voice Tutor Mode' : 'Turn on Voice Tutor Mode'}
            >
              {voiceTutor.on ? '🎙️ Voice tutor: on' : '🎙️ Voice tutor'}
            </button>
          )}
          <button className="ex-chat-newchat" onClick={onNewChat} title="New chat">
            ＋
          </button>
        </div>
      </div>

      {voiceTutor?.on && (
        <div className="ex-voice-strip">
          <span className="ex-voice-status">
            {VOICE_STATUS_LABEL[voiceTutor.status] ?? voiceTutor.status}
          </span>
          {voiceTutor.transcript && (
            <span className="ex-voice-transcript">“{voiceTutor.transcript}”</span>
          )}
        </div>
      )}

      <div className="ex-grapher-bar">
        <button className="ex-grapher-btn" onClick={() => onOpenGrapher('2d')}>
          📈 2D Graph
        </button>
        <button className="ex-grapher-btn" onClick={() => onOpenGrapher('3d')}>
          🧊 3D Graph
        </button>
      </div>

      <div className="ex-chat-history" ref={historyRef}>
        {chat.length === 0 && (
          <div className="ex-chat-empty">
            Ask me to draw something —
            <br />
            “a login flow”, “a 3-box mind map about dogs”, “an org chart”.
          </div>
        )}
        {chat.map((item, i) => (
          <ChatRow key={i} item={item} onSaveAnimation={onSaveAnimation} />
        ))}
        {isGenerating && <div className="ex-chat-thinking">Thinking…</div>}
      </div>

      <form className="ex-chat-input" onSubmit={submit}>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit(e)
            }
          }}
          placeholder="Describe what to draw…"
          rows={2}
        />
        <div className="ex-chat-actions">
          {isGenerating ? (
            <button type="button" className="ex-chat-stop" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="ex-chat-send" disabled={!value.trim()}>
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

function ChatRow({
  item,
  onSaveAnimation,
}: {
  item: ChatItem
  onSaveAnimation: (animationId: number, title: string, save: boolean) => void
}) {
  switch (item.kind) {
    case 'user':
      return <div className="ex-row ex-row-user">{item.text}</div>
    case 'think':
      return <div className="ex-row ex-row-think">{item.text}</div>
    case 'message':
      return <div className="ex-row ex-row-message">{item.text}</div>
    case 'action':
      return (
        <div className="ex-row ex-row-action">
          <span className="ex-row-action-dot">✎</span> {item.text}
        </div>
      )
    case 'error':
      return <div className="ex-row ex-row-error">{item.text}</div>
    case 'video':
      return (
        <div className="ex-row ex-row-video">
          <div className="ex-video-title">{item.title}</div>
          <video className="ex-video" src={item.url} controls preload="metadata" />
        </div>
      )
    case 'save-prompt':
      return (
        <div className="ex-row ex-row-save">
          <div className="ex-save-q">Do you want to save this animation for future reference?</div>
          <div className="ex-save-actions">
            <button
              className="ex-save-yes"
              onClick={() => onSaveAnimation(item.animationId, item.title, true)}
            >
              Yes
            </button>
            <button
              className="ex-save-no"
              onClick={() => onSaveAnimation(item.animationId, item.title, false)}
            >
              No
            </button>
          </div>
        </div>
      )
  }
}
