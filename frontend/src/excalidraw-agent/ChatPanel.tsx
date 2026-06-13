import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ChatItem } from './types'
import './chat.css'

interface Props {
  chat: ChatItem[]
  isGenerating: boolean
  onSend: (text: string) => void
  onStop: () => void
  onNewChat: () => void
}

export function ChatPanel({ chat, isGenerating, onSend, onStop, onNewChat }: Props) {
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
        <button className="ex-chat-newchat" onClick={onNewChat} title="New chat">
          ＋
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
          <ChatRow key={i} item={item} />
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

function ChatRow({ item }: { item: ChatItem }) {
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
  }
}
