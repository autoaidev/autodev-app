import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AgentAvatar, Icon } from '@renderer/ui'
import { OfficeAgent, authorColor, hhmm } from './officeTypes'
import type { RoomEntry } from '@renderer/services/officeService'
import { renderMarkdown } from '../agent/useMarkdown'
import '../agent/markdown.css'

/**
 * OfficeRoom — the office ROOM view (a top-level "Room" tab in the Office area).
 *
 * A UNIFIED, read-only stream that merges EVERY character's conversation
 * (messages + activity narration) into one chronological feed, each line tagged
 * with its SOURCE character (real pixel-art avatar via AgentAvatar / name / color).
 * Live-updates off the shared per-character message store (officeService).
 *
 * The composer is AGENT-TARGETED — there is NO room-wide broadcast (the room is a
 * read stream). Every message goes to ONE character; the DEFAULT target is the
 * FIRST/TOP character in the office order (the "PM"). Retarget by @tagging a name
 * OR the dropdown. Delivery reuses the EXISTING per-character steer path (a live
 * instant-message that queues as a steer once an offline character connects).
 */
export interface OfficeRoomProps {
  officeName: string
  /** The office characters, in office order (agents[0] = the top/PM = default target). */
  agents: OfficeAgent[]
  /** The merged, chronological, per-character-tagged room feed (officeService.useOfficeRoom). */
  entries: RoomEntry[]
  /** Deliver to ONE character — reuses the existing steer path. */
  onSend: (agentId: string, text: string) => void | Promise<void>
  loading?: boolean
}

/** Normalize a name/slug/tag to a compact matchable token (lowercase, alnum only). */
function tagKey(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Detect a leading `@mention` and resolve it to a character. Matches the token
 * (alnum, case-insensitive) as a PREFIX of a character's name or slug, so `@ali`
 * targets "Alice". Returns the matched agent + the message with the tag stripped.
 */
function matchTag(text: string, agents: OfficeAgent[]): { agent: OfficeAgent; rest: string } | null {
  const m = /^@(\S+)\s*(.*)$/s.exec(text)
  if (!m) return null
  const tok = tagKey(m[1])
  if (!tok) return null
  const agent =
    agents.find((a) => tagKey(a.name) === tok || tagKey(a.slug) === tok) ??
    agents.find((a) => tagKey(a.name).startsWith(tok) || tagKey(a.slug).startsWith(tok))
  if (!agent) return null
  return { agent, rest: m[2] }
}

export function OfficeRoom({
  officeName,
  agents,
  entries,
  onSend,
  loading
}: OfficeRoomProps): React.JSX.Element {
  const [text, setText] = useState('')
  // The composer's explicit target (a character id). Empty → fall back to the top
  // character (the PM). Retargeted by the dropdown or an @mention.
  const [targetId, setTargetId] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  // Character lookup by SOURCE ref (slug) for feed rows, and the default (top/PM).
  const bySlug = useMemo(() => {
    const m = new Map<string, OfficeAgent>()
    for (const a of agents) m.set(a.slug, a)
    return m
  }, [agents])
  const topAgent = agents[0]

  // Resolve the effective target: an @mention in the draft wins, else the explicit
  // selection, else the top/PM character. Keeps a live "→ Name" truthful as you type.
  const mentioned = useMemo(() => matchTag(text, agents), [text, agents])
  const selected = useMemo(
    () => agents.find((a) => a.id === targetId) ?? topAgent,
    [agents, targetId, topAgent]
  )
  const target = mentioned?.agent ?? selected

  const onScroll = (): void => {
    const el = bodyRef.current
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }
  const scrollToBottom = (): void => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // Auto-scroll to newest only when the reader was already pinned to the bottom, so
  // the 4s poll's freshly-merged feed can't yank scrollback away mid-read.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom()
  }, [entries.length])

  const submit = (): void => {
    if (!target) return
    // An @mention retargets AND is stripped from the delivered text.
    const t = (mentioned ? mentioned.rest : text).trim()
    if (!t) return
    void onSend(target.id, t)
    setText('')
  }

  const disabled = !target
  const targetOffline = !!target && !target.online

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, background: 'var(--bg-0)' }}>
      {/* room header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--bd-2)' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 'var(--fs-body)', fontWeight: 700, color: 'var(--tx-hi)' }}>Room</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--role-violet)', marginTop: 2 }}>
            #{officeName.toLowerCase().replace(/\s+/g, '-')} · {agents.length} character{agents.length === 1 ? '' : 's'}
          </div>
        </div>
        {/* live avatar cluster — one identity tile per character in the room */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {agents.slice(0, 8).map((a, i) => (
            <div key={a.id} style={{ marginLeft: i === 0 ? 0 : -6 }}>
              <AgentAvatar
                name={a.name}
                idKey={a.id}
                provider={a.provider}
                size={22}
                avatarUrl={a.avatarUrl}
                avatarColor={a.color}
                online={a.online}
                dim={!a.online}
                title={a.name + (a.online ? '' : ' (offline)')}
              />
            </div>
          ))}
        </div>
      </div>

      {/* unified stream */}
      <div ref={bodyRef} onScroll={onScroll} style={{ flex: 1, overflow: 'auto', padding: '10px 16px', minHeight: 0 }}>
        {entries.length === 0 && (
          <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-faint)', padding: '8px 0' }}>
            {loading ? 'Loading the room…' : 'No room chatter yet.'}
          </div>
        )}
        {entries.map((e) => {
          const a = bySlug.get(e.ref)
          const name = a?.name || e.msg.author || e.ref
          const nameColor = a?.color || authorColor(name, e.msg.role)
          const isUser = e.msg.role === 'user'
          return (
            <div key={e.key} style={{ display: 'flex', gap: 9, padding: '5px 0', alignItems: 'flex-start' }}>
              <div style={{ flex: 'none', marginTop: 1 }}>
                {isUser || !a ? (
                  <AgentAvatar name={isUser ? 'you' : name} idKey={isUser ? 'you' : e.ref} size={20} ring={false} />
                ) : (
                  <AgentAvatar
                    name={a.name}
                    idKey={a.id}
                    provider={a.provider}
                    size={20}
                    avatarUrl={a.avatarUrl}
                    avatarColor={a.color}
                    online={a.online}
                    dim={!a.online}
                    title={a.name}
                  />
                )}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span data-room-author style={{ fontSize: 'var(--fs-meta)', fontWeight: 600, color: isUser ? 'var(--role-violet-2)' : nameColor }}>
                    {isUser ? 'you' : name}
                  </span>
                  {e.msg.author && e.msg.role === 'a2a' && (
                    <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--role-violet)' }}>{e.msg.author}</span>
                  )}
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-ghost)' }}>
                    {hhmm(e.msg.at)}
                  </span>
                </div>
                {/* Agent / A2A narration is LLM-authored markdown → render it rich via
                    the SHARED `.dv-md` ruleset (sanitized in useMarkdown). The user's
                    own messages stay literal. */}
                {isUser ? (
                  <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-2)', wordBreak: 'break-word', lineHeight: 1.5 }}>
                    {e.msg.text}
                  </div>
                ) : (
                  <div
                    className="dv-md"
                    style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-2)', lineHeight: 1.5 }}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(e.msg.text) }}
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* agent-targeted composer — NO broadcast: every message goes to ONE character */}
      <div style={{ margin: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-desc)', color: 'var(--tx-4)' }}>
          <span>To</span>
          <select
            value={mentioned ? mentioned.agent.id : (selected?.id ?? '')}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={agents.length === 0 || !!mentioned}
            aria-label="Message target character"
            title={mentioned ? 'Targeted via @mention — clear the mention to use the dropdown' : 'Choose which character to message'}
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--bd-1)',
              borderRadius: 'var(--r-input)',
              color: 'var(--tx-1)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-desc)',
              padding: '3px 6px',
              maxWidth: 200
            }}
          >
            {agents.map((a, i) => (
              <option key={a.id} value={a.id}>
                {a.name}{i === 0 ? ' (PM)' : ''}{a.online ? '' : ' · offline'}
              </option>
            ))}
          </select>
          {target && (
            <span data-room-target style={{ color: target.color || 'var(--role-violet-2)', fontWeight: 600 }}>
              → {target.name}
            </span>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 11px',
            background: 'var(--bg-input)',
            border: '1px solid var(--bd-1)',
            borderRadius: 'var(--r-card)'
          }}
        >
          <span title="Live instant-message (steer)" style={{ display: 'inline-flex', color: 'var(--role-violet)' }}><Icon name="bolt" size={13} /></span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={disabled}
            placeholder={disabled ? 'No characters in this office yet…' : `Message → ${target?.name} (type @name to retarget)…`}
            aria-label="Message a character in the office room"
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

        {targetOffline && (
          <div style={{ fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>
            {target?.name} is offline — your message queues as a live steer once it connects.
          </div>
        )}
      </div>
    </div>
  )
}

export default OfficeRoom
