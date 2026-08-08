import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@renderer/ui'
import { useOfficeMessages, steer } from '@renderer/services/officeService'
import type { ChatMessage } from '../office/officeTypes'
import './ChatTab.css'

/**
 * ChatTab (redesign screen 2f — the agent detail "Chat" sub-tab).
 *
 * The office-conversation surface for ONE agent: a live message stream + a
 * composer that steers the agent instantly. Backed by services/officeService —
 * `useOfficeMessages(officeSlug, ref, { active })` reads the character's
 * conversation (ONE poll SHARED with OfficeView for the same character) and
 * `steer(agentId, text)` sends a live instant-message (NOT a queued TODO task).
 *
 * The service now owns the poll cadence, the empty-poll / auth-expiry keep-alive
 * guards, the "keep the last transcript on a transient error" behaviour, and the
 * optimistic echo (steer() reconciles into every open conversation for that agent).
 * ChatTab only resolves the office link off AgentState, gates the shared poll by
 * on-screen visibility, and owns its own at-bottom-safe scroll + composer.
 *
 * Chat only exists for an office-bound agent; a plain local workspace shows a
 * clean empty state pointing at "Connect to office".
 */

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

function fmtTime(ms: string | number | undefined): string {
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
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')

  const rootRef = useRef<HTMLDivElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Is this chat actually on-screen? The parent (AgentDetail) keeps the Chat sub-tab
  // MOUNTED but display:none when another sub-tab is selected, so we self-detect
  // visibility (offsetParent goes null under a display:none ancestor; IO fires on the
  // toggle) and pass it to the shared poll as `active` — the service keeps the last
  // transcript and stops polling on OUR behalf when nobody visible is watching.
  const [onScreen, setOnScreen] = useState(true)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const compute = (): void => setOnScreen(!document.hidden && el.offsetParent !== null)
    compute()
    const io = new IntersectionObserver(() => compute())
    io.observe(el)
    document.addEventListener('visibilitychange', compute)
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', compute) }
  }, [])

  // Clear the half-typed message (and any stale send error) when the agent changes.
  // AgentDetail keys ChatTab by agent.path so it remounts fresh, but this stays as
  // defense in depth so a draft can never carry to the wrong agent.
  useEffect(() => {
    setDraft('')
    setSendError('')
  }, [agentPath])

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

  // The shared conversation stream — ONE poll per (office, character), SHARED with
  // OfficeView. `active: onScreen` pauses OUR contribution while hidden (the service
  // keeps the last transcript). An empty `ref` yields an inert empty snapshot.
  const { messages, loading, error, resolvedAgentId } = useOfficeMessages(officeSlug, ref, {
    active: onScreen
  })

  const onScroll = (): void => {
    const el = feedRef.current
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  const scrollToBottom = (): void => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // Auto-scroll to newest only when the reader is pinned to the bottom.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom()
  }, [messages.length])

  const send = useCallback(async (): Promise<void> => {
    const t = draft.trim()
    if (!t || sending) return
    // Never let a stale resolved id steer the wrong agent: trust the service's
    // resolvedAgentId only when it matches THIS agent's officeAgentId (or when the
    // agent has no id and was resolved by slug). Otherwise fall back to the current
    // agent's officeAgentId. (ChatTab is also keyed per agent by the parent, so the
    // resolved id resets on switch — this is defense in depth.)
    const targetId =
      resolvedAgentId && (!agent?.officeAgentId || resolvedAgentId === agent.officeAgentId)
        ? resolvedAgentId
        : agent?.officeAgentId
    if (!targetId) return // link not resolved yet
    setSending(true)
    setSendError('')
    const r = await steer(targetId, t)
    setSending(false)
    if ('error' in r) {
      setSendError(r.error)
      return
    }
    // Optimistic echo + reconcile is owned by the service: steer() pushes a `you`
    // message into every open conversation for this agent, and the next shared poll
    // reconciles it against the server record — no local message list to maintain.
    setDraft('')
    atBottomRef.current = true
    taRef.current?.focus()
  }, [draft, sending, resolvedAgentId, agent])

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
      <div className="dv-chat" ref={rootRef}>
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

  // The composer error is a send failure; the feed error is the service's initial
  // load error. Show whichever is present (both are transient, at-bottom-safe).
  const shownError = sendError || error

  return (
    <div className="dv-chat" ref={rootRef}>
      <div
        className="dv-chat__feed"
        ref={feedRef}
        onScroll={onScroll}
        role="log"
        aria-label="Office conversation"
        aria-live="polite"
      >
        {(loading || agent === null) && <div className="dv-chat__status">Loading conversation…</div>}
        {!loading && agent !== null && shownError && (
          <div className="dv-chat__status is-err">{shownError}</div>
        )}
        {!loading && agent !== null && !shownError && messages.length === 0 && (
          <div className="dv-chat__status">
            No messages yet. Say hello below — it steers the agent live.
          </div>
        )}
        {messages.map((m: ChatMessage) => {
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
