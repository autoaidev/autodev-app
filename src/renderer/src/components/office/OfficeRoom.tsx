import React, { useEffect, useRef, useState } from 'react'
import { ChatMessage, authorColor, hhmm } from './officeTypes'

/**
 * OfficeRoom — the shared room column (300px, --bg-1) on the Office screen (2c).
 *
 * Renders the conversational/inter-agent messages (colored author names + mono
 * time) with a composer at the bottom. There is no dedicated room-broadcast API,
 * so the composer delivers via `officeSteer` to the FOCUSED character (the closest
 * real path — a live instant-message, not a queued TODO).
 * TODO(redesign): add a real per-office room feed/post endpoint for a true room.
 */
export interface OfficeRoomProps {
  officeName: string
  messages: ChatMessage[]
  targetName: string
  disabled: boolean
  onSend: (text: string) => void | Promise<void>
  note?: string
}

export function OfficeRoom({
  officeName,
  messages,
  targetName,
  disabled,
  onSend,
  note
}: OfficeRoomProps): React.JSX.Element {
  const [text, setText] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const submit = (): void => {
    const t = text.trim()
    if (!t || disabled) return
    void onSend(t)
    setText('')
  }

  return (
    <div
      style={{
        width: 'var(--w-office-room)',
        flex: 'none',
        background: 'var(--bg-1)',
        borderLeft: '1px solid var(--bd-2)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0
      }}
    >
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd-2)' }}>
        <div
          style={{
            fontSize: 'var(--fs-section)',
            fontWeight: 700,
            letterSpacing: 'var(--ls-section)',
            textTransform: 'uppercase',
            color: 'var(--tx-4)'
          }}
        >
          Office room
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--role-violet)', marginTop: 2 }}>
          #{officeName.toLowerCase().replace(/\s+/g, '-')}
        </div>
      </div>

      <div ref={bodyRef} style={{ flex: 1, overflow: 'auto', padding: '10px 14px', minHeight: 0 }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-faint)', padding: '8px 0' }}>
            No room chatter yet.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} style={{ padding: '5px 0', lineHeight: 1.5 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 'var(--fs-meta)', fontWeight: 600, color: authorColor(m.author, m.role) }}>
                {m.author || (m.role === 'user' ? 'you' : m.role)}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-ghost)' }}>
                {hhmm(m.at)}
              </span>
            </div>
            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-2)', wordBreak: 'break-word' }}>{m.text}</div>
          </div>
        ))}
      </div>

      {note && (
        <div style={{ padding: '4px 14px', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>{note}</div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: '0 12px 12px',
          padding: '8px 11px',
          background: 'var(--bg-panel)',
          border: '1px solid var(--bd-1)',
          borderRadius: 'var(--r-card)'
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
          placeholder={disabled ? 'Select a character…' : `Message the room (→ ${targetName})…`}
          aria-label="Message the office room"
          style={{
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--tx-1)',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-body)'
          }}
        />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-ghost)' }}>⏎</span>
      </form>
    </div>
  )
}

export default OfficeRoom
