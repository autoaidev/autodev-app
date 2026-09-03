import React, { useEffect, useRef, useState } from 'react'
import { Pill, Button, Icon, AgentAvatar } from '@renderer/ui'
import { OfficeAgent, ChatMessage, hhmm } from './officeTypes'
import { renderMarkdownInline } from '../agent/useMarkdown'
import '../agent/markdown.css'

/**
 * AgentStream — the focused character's read-only activity stream (2c, left of
 * the lower split). "One stream at a time": only the focused agent's timeline
 * scrolls here. Rows are `[time mono][body]`, colored by role.
 *
 * Source: `officeMessages()` for the focused character (assistant/system turns).
 * The composer sends a LIVE instant-message via `officeSteer` (not a TODO task).
 * Read-only otherwise — `Open agent` jumps to the Agents tab (2a).
 */
export interface AgentStreamProps {
  agent: OfficeAgent
  messages: ChatMessage[]
  disabled: boolean
  onSend: (text: string) => void | Promise<void>
  onOpenAgent: () => void
  /**
   * Advanced shows the full scrolling timeline + live steer composer. Basic (false)
   * collapses this bottom feed to a compact 2–3 line "latest status" summary (the
   * full stream + steer live on the Agents tab, one click away via "Open agent" —
   * and flipping Advanced restores it here).
   */
  advanced?: boolean
}

function bodyColor(role: ChatMessage['role']): string {
  if (role === 'a2a') return 'var(--role-violet)'
  if (role === 'system') return 'var(--tx-dim)'
  if (role === 'user') return 'var(--accent-ink)'
  return 'var(--tx-2)'
}

export function AgentStream({
  agent,
  messages,
  disabled,
  onSend,
  onOpenAgent,
  advanced = false
}: AgentStreamProps): React.JSX.Element {
  const [text, setText] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  const onScroll = (): void => {
    const el = bodyRef.current
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }
  const scrollToBottom = (): void => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // Switching focused character = a fresh view: re-pin to the tail.
  useEffect(() => {
    atBottomRef.current = true
    scrollToBottom()
  }, [agent.id])

  // Auto-scroll to newest only when the reader was already pinned to the bottom,
  // so the 5s poll can't yank scrollback away mid-read.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom()
  }, [messages.length])

  const submit = (): void => {
    const t = text.trim()
    if (!t || disabled) return
    void onSend(t)
    setText('')
  }

  // BASIC — no bottom firehose. Collapse to a compact latest-status summary (the
  // newest 2–3 lines) with an "Open agent" jump to the full stream + steer composer
  // on the Agents tab. Flipping Advanced restores the full feed below.
  if (!advanced) {
    const latest = messages.slice(-3)
    const status = agent.online ? (agent.status || 'working…') : 'not connected'
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', borderBottom: '1px solid var(--bd-2)' }}>
          <AgentAvatar
            name={agent.name}
            idKey={agent.id}
            provider={agent.provider}
            size={22}
            avatarUrl={agent.avatarUrl}
            avatarColor={agent.color}
            online={agent.online}
            title={agent.name}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 'var(--fs-body)', fontWeight: 700, color: 'var(--tx-hi)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</div>
            <div style={{ fontSize: 'var(--fs-tiny)', color: agent.online ? 'var(--st-running)' : 'var(--tx-4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{status}</div>
          </div>
          <Button variant="secondary" size="sm" onClick={onOpenAgent} title="Open this character in the Agents tab (full activity + steer)">
            <Icon name="external" size={11} /> Open agent
          </Button>
        </div>
        <div style={{ padding: '10px 14px', minHeight: 0 }}>
          {latest.length === 0 ? (
            <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-faint)' }}>
              {agent.online ? 'Waiting for activity…' : 'This character is offline. Connect & operate it, or Spawn the office.'}
            </div>
          ) : (
            latest.map((m) => (
              <div key={m.id} style={{ display: 'flex', gap: 10, padding: '3px 0', alignItems: 'baseline' }}>
                <span style={{ flex: 'none', width: 34, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-section)', color: 'var(--tx-gutter)' }}>{hhmm(m.at)}</span>
                {/* Compact single-line preview — INLINE-only markdown (bold/italic/
                    code/links) so it stays rich but never breaks the one-line layout.
                    User's own text stays literal. */}
                {m.role === 'user' ? (
                  <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-meta)', color: bodyColor(m.role), lineHeight: 1.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={m.text}>
                    {m.text}
                  </span>
                ) : (
                  <span
                    className="dv-md-inline"
                    style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-meta)', color: bodyColor(m.role), lineHeight: 1.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    title={m.text}
                    dangerouslySetInnerHTML={{ __html: renderMarkdownInline(m.text) }}
                  />
                )}
              </div>
            ))
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
      {/* stream header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '10px 14px',
          borderBottom: '1px solid var(--bd-2)'
        }}
      >
        <AgentAvatar
          name={agent.name}
          idKey={agent.id}
          provider={agent.provider}
          size={22}
          avatarUrl={agent.avatarUrl}
          avatarColor={agent.color}
          online={agent.online}
          title={agent.name}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 'var(--fs-body)', fontWeight: 700, color: 'var(--tx-hi)' }}>{agent.name}</div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-tiny)',
              color: 'var(--tx-ghost)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {agent.officeSlug}/{agent.slug}
          </div>
        </div>
        <Pill variant="amber" mono>
          READ-ONLY
        </Pill>
        <Button variant="secondary" size="sm" onClick={onOpenAgent} title="Open this character in the Agents tab">
          <Icon name="external" size={11} /> Open agent
        </Button>
      </div>

      {/* timeline */}
      <div ref={bodyRef} onScroll={onScroll} style={{ flex: 1, overflow: 'auto', padding: '10px 14px', minHeight: 0 }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-faint)', padding: '8px 0' }}>
            {agent.online ? 'Waiting for activity…' : 'This character is offline. Connect & operate it, or Spawn the office.'}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} style={{ display: 'flex', gap: 12, padding: '5px 0', alignItems: 'baseline' }}>
            <span
              style={{
                flex: 'none',
                width: 38,
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-section)',
                color: 'var(--tx-gutter)'
              }}
            >
              {hhmm(m.at)}
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-body)', color: bodyColor(m.role), lineHeight: 1.5, wordBreak: 'break-word' }}>
              {m.author && m.role === 'a2a' && (
                <span style={{ color: 'var(--role-violet)', fontWeight: 600, marginRight: 6 }}>{m.author}</span>
              )}
              {/* Ticker stream — INLINE-only markdown (rich marks, no block layout).
                  User's own text stays literal. */}
              {m.role === 'user' ? (
                m.text
              ) : (
                <span className="dv-md-inline" dangerouslySetInnerHTML={{ __html: renderMarkdownInline(m.text) }} />
              )}
            </span>
          </div>
        ))}
      </div>

      {/* composer — live steer to the focused character */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: '0 14px 12px',
          padding: '9px 12px',
          background: 'var(--bg-input)',
          border: '1px solid var(--bd-1)',
          borderRadius: 'var(--r-card)'
        }}
      >
        <span title="Live instant-message (steer)" style={{ color: 'var(--role-violet)', fontSize: 13 }}>⚡</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
          placeholder={disabled ? 'Select a character…' : `Message ${agent.name} in the office…`}
          aria-label={`Instant-message ${agent.name}`}
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

export default AgentStream
