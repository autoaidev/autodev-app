import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@renderer/ui'
import './ChatTab.css'

/**
 * ChatTab (redesign screen 2f — the agent detail "Chat" sub-tab).
 *
 * The office-conversation surface for ONE agent: a live message stream + a
 * composer that steers the agent instantly. Backed by the real office API —
 * `officeMessages` (polled) reads the character's conversation and `officeSteer`
 * sends a live instant-message (NOT a queued TODO task, which is `sendAgentMessage`).
 *
 * Chat only exists for an office-bound agent; a plain local workspace shows a
 * clean empty state pointing at "Connect to office".
 */

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'a2a' | 'system'
  author: string
  text: string
  kind: string
  at: number
}
type ChatResult =
  | { ok: true; agentId: string; agentName: string; messages: ChatMessage[] }
  | { error: string }

// Only the office-link fields we need off AgentState (fetched via agentState()).
interface AgentLite {
  path?: string
  name?: string
  online?: boolean
  officeAgentId?: string
  officeAgentSlug?: string
  officeSlug?: string
}

const SLASH_COMMANDS = ['/task', '/pause', '/context', '/switch grok→claude']

function fmtTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function ChatTab({ agentPath }: { agentPath: string }): JSX.Element {
  const [agent, setAgent] = useState<AgentLite | null>(null)
  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  const [resolvedId, setResolvedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const feedRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Resolve the office link off AgentState, then keep it fresh on updates.
  useEffect(() => {
    let alive = true
    void (window.api.agentState(agentPath) as Promise<AgentLite>).then((a) => {
      if (alive) setAgent(a ?? null)
    })
    const off = window.api.onAgentUpdated((s: AgentLite) => {
      if (s?.path === agentPath) setAgent(s)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [agentPath])

  const ref = agent?.officeAgentId || agent?.officeAgentSlug || ''
  const officeSlug = agent?.officeSlug || ''

  const onScroll = (): void => {
    const el = feedRef.current
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  const scrollToBottom = (): void => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // Poll the character's conversation while an office link exists.
  useEffect(() => {
    if (agent === null) return // still resolving AgentState
    if (!ref) {
      setLoading(false)
      return
    }
    let alive = true
    const load = async (initial: boolean): Promise<void> => {
      if (initial) setLoading(true)
      const r = (await window.api.officeMessages(officeSlug, ref)) as ChatResult
      if (!alive) return
      if ('error' in r) {
        if (initial) setError(r.error) // keep prior messages on a transient poll error
      } else {
        setError('')
        setResolvedId(r.agentId)
        setMsgs(r.messages)
      }
      if (initial) setLoading(false)
    }
    void load(true)
    const timer = setInterval(() => void load(false), 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // Depend on the stable primitives that actually drive the fetch — NOT the
    // `agent` object identity. Every onAgentUpdated push is a new object; keying
    // the effect off it would re-run the fetch and flash "Loading…" on each poll.
  }, [ref, officeSlug, agent !== null])

  // Auto-scroll to newest only when the reader is pinned to the bottom.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom()
  }, [msgs.length])

  const send = useCallback(async (): Promise<void> => {
    const t = draft.trim()
    if (!t || sending) return
    const targetId = resolvedId || agent?.officeAgentId
    if (!targetId) return // link not resolved yet
    setSending(true)
    const r = (await window.api.officeSteer(targetId, t)) as { ok?: boolean; error?: string }
    setSending(false)
    if (r?.error) {
      setError(r.error)
      return
    }
    setDraft('')
    atBottomRef.current = true
    // Optimistic echo; the next poll reconciles against the server record.
    setMsgs((m) => [
      ...m,
      { id: `local-${Date.now()}`, role: 'user', author: 'You', text: t, kind: 'steer', at: Date.now() }
    ])
    taRef.current?.focus()
  }, [draft, sending, resolvedId, agent])

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const insertSlash = (cmd: string): void => {
    setDraft((d) => (d.trim() ? `${cmd} ${d}` : `${cmd} `))
    taRef.current?.focus()
  }

  // Local agent with no office character — chat needs an office link.
  if (agent !== null && !ref) {
    return (
      <div className="dv-chat">
        <div className="dv-chat__empty">
          <div className="dv-chat__empty-glyph">💬</div>
          <div className="dv-chat__empty-title">No office conversation</div>
          <div className="dv-chat__empty-body">
            This is a local agent. Connect it to a Pixel Office character to read and
            message its conversation here — messages you send steer the agent live.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="dv-chat">
      <div
        className="dv-chat__feed"
        ref={feedRef}
        onScroll={onScroll}
        role="log"
        aria-label="Office conversation"
        aria-live="polite"
      >
        {(loading || agent === null) && <div className="dv-chat__status">Loading conversation…</div>}
        {!loading && agent !== null && error && (
          <div className="dv-chat__status is-err">{error}</div>
        )}
        {!loading && agent !== null && !error && msgs.length === 0 && (
          <div className="dv-chat__status">
            No messages yet. Say hello below — it steers the agent live.
          </div>
        )}
        {msgs.map((m) => {
          if (m.role === 'system') {
            return (
              <div key={m.id} className="dv-chat__marker">
                <span>{m.text}</span>
                <time>{fmtTime(m.at)}</time>
              </div>
            )
          }
          const own = m.role === 'user'
          const avClass = own ? 'av-you' : m.role === 'a2a' ? 'av-a2a' : 'av-agent'
          const auClass = own ? 'au-you' : m.role === 'a2a' ? 'au-a2a' : ''
          return (
            <div key={m.id} className={'dv-chat__row' + (own ? ' is-own' : '')}>
              <div className={'dv-chat__avatar ' + avClass} aria-hidden="true">
                {initials(m.author || (own ? 'You' : 'Agent'))}
              </div>
              <div className="dv-chat__bubble">
                <div className="dv-chat__bmeta">
                  <span className={'dv-chat__author ' + auClass}>{m.author}</span>
                  <time>{fmtTime(m.at)}</time>
                </div>
                <div className="dv-chat__text">{m.text}</div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="dv-chat__slash" role="group" aria-label="Slash commands">
        {SLASH_COMMANDS.map((cmd) => (
          <button key={cmd} type="button" className="dv-chat__chip" onClick={() => insertSlash(cmd)}>
            {cmd}
          </button>
        ))}
      </div>

      <div className="dv-chat__composer">
        <textarea
          ref={taRef}
          rows={1}
          value={draft}
          aria-label="Message this office agent (steers it live)"
          placeholder={
            agent?.online
              ? `Reply to ${agent?.name || 'the agent'}…  (Enter to send · Shift+Enter for newline)`
              : 'Agent is offline — a steer may not be delivered until it reconnects'
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
        <Button variant="primary" disabled={sending || !draft.trim()} onClick={() => void send()}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  )
}
