import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Pill, Button, Icon } from '@renderer/ui'
import { type SessionMeta, type SessionMsg, baseName, clock } from './types'

/** Initials for an avatar tile — user vs the agent (workspace basename). */
function initials(label: string): string {
  const parts = label.replace(/[-_]/g, ' ').split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '··'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/**
 * The transcript reader (2d, right pane). Header carries the task title, a
 * STREAMING pill for a live session, the mono session ids, and Resume-here /
 * Export actions. The body renders chat bubbles; `tool`-role messages fold into
 * a mono tool-line block. A live session shows a typing indicator at the tail.
 * The footer is the "Interject in this session" composer.
 */
export function TranscriptPane({
  session,
  msgs,
  onResume,
  resumeDisabled,
  resumeTitle,
  onExport,
  exportDisabled,
  exportTitle,
  onInterject,
  interjectDisabled,
  interjectHint,
  notice,
  connectSlot
}: {
  session: SessionMeta
  msgs: SessionMsg[]
  onResume: () => void
  resumeDisabled?: boolean
  resumeTitle?: string
  onExport: () => void
  exportDisabled?: boolean
  exportTitle?: string
  // Returns an {error} when the write is rejected (e.g. non-AutoDev cwd); the
  // composer keeps the draft and shows the error instead of silently clearing.
  onInterject: (text: string) => void | Promise<{ error?: string } | void>
  interjectDisabled?: boolean
  interjectHint?: string
  notice?: { kind: 'ok' | 'error'; text: string } | null
  connectSlot?: ReactNode
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState('')
  const [sendErr, setSendErr] = useState('')
  const agent = baseName(session.cwd)

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [msgs])

  const submit = async (): Promise<void> => {
    const t = draft.trim()
    if (!t || interjectDisabled) return
    const r = await onInterject(t)
    if (r && 'error' in r && r.error) { setSendErr(r.error); return }
    setSendErr('')
    setDraft('')
  }

  return (
    <>
      <div className="sv-pane-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="sv-pane-title">
            <h2 style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {session.title || '(untitled)'}
            </h2>
            {session.live && <Pill variant="green" mono selected>STREAMING</Pill>}
          </div>
          <div className="sv-pane-sub">
            {session.provider} · {agent} · {session.id.slice(0, 12)} · started {clock(session.mtime)}
          </div>
        </div>
        <Button
          size="sm"
          onClick={onResume}
          disabled={resumeDisabled}
          title={resumeTitle}
          style={resumeDisabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
        >
          <Icon name="clock" size={12} /> Resume here
        </Button>
        <Button
          size="sm"
          onClick={onExport}
          disabled={exportDisabled}
          title={exportTitle ?? "Export this session's trace"}
          style={exportDisabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
        >
          <Icon name="external" size={12} /> Export
        </Button>
      </div>

      {notice && (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          style={{
            padding: '7px 18px',
            borderBottom: '1px solid var(--bd-2)',
            fontSize: 'var(--fs-meta)',
            color: notice.kind === 'error' ? 'var(--st-error)' : 'var(--st-running)'
          }}
        >
          {notice.text}
        </div>
      )}

      {connectSlot}

      <div className="sv-transcript" ref={bodyRef}>
        {msgs.length === 0 && <div className="sv-empty">(empty transcript)</div>}
        {msgs.map((m, i) => {
          if (m.role === 'tool') {
            return <div key={i} className="sv-toolblock">{m.text}</div>
          }
          const who = m.role === 'user' ? 'user' : m.role === 'system' ? 'sys' : 'asst'
          const author = m.role === 'user' ? 'you' : m.role === 'system' ? 'system' : agent
          return (
            <div key={i} className={'sv-msg ' + who}>
              <div className={'sv-av ' + who}>{m.role === 'user' ? 'YOU' : m.role === 'system' ? '··' : initials(agent)}</div>
              <div className="sv-bubble">
                <div className="sv-msg-author">{author}{m.ts ? ` · ${clock(m.ts)}` : ''}</div>
                {m.text}
              </div>
            </div>
          )
        })}
        {session.live && (
          <div className="sv-msg asst">
            <div className="sv-av asst">{initials(agent)}</div>
            <div className="sv-bubble">
              <span className="sv-typing"><i /><i /><i /></span>
            </div>
          </div>
        )}
      </div>

      <div className="sv-composer">
        <input
          value={draft}
          onChange={(e) => { setDraft(e.target.value); if (sendErr) setSendErr('') }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
          placeholder={interjectDisabled ? (interjectHint ?? 'Read-only session') : 'Interject in this session…'}
          aria-label="Interject in this session"
          disabled={interjectDisabled}
          title={interjectDisabled ? interjectHint : undefined}
          style={interjectDisabled ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
        />
        <Button variant="primary" size="sm" onClick={submit} disabled={interjectDisabled || !draft.trim()}>Send</Button>
      </div>
      {(sendErr || (interjectDisabled && interjectHint)) && (
        <div
          role={sendErr ? 'alert' : undefined}
          style={{
            padding: '0 18px 8px',
            fontSize: 'var(--fs-meta)',
            color: sendErr ? 'var(--st-error)' : 'var(--tx-3)'
          }}
        >
          {sendErr || interjectHint}
        </div>
      )}
    </>
  )
}

export default TranscriptPane
