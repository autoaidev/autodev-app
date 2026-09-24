import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '@renderer/ui'
import { OfficeAgent, hhmm } from './officeTypes'

/**
 * EventsPanel — the focused office character's LIVE server-side activity stream.
 *
 * Source of truth is the office's authoritative `hook_events` (the same feed the
 * pixel-office web "Events" tab renders), fetched via `officeAgentEvents` — NOT
 * the local `.autodev/hooks-events.jsonl` (grok-tui headless loops don't write it
 * reliably). So the user SEES what a working agent is actually doing — tool calls,
 * narration, status, task start/complete — instead of trusting a heuristic badge.
 *
 * Self-contained poll (every EVENTS_POLL_MS while `active`), keyed on the stable
 * (officeSlug, slug) primitives. Resilient: a transient fetch failure keeps the
 * last events and shows a subtle "reconnecting…" hint rather than crashing the
 * view. Newest-first; auto-follows the top when the reader is already there.
 */

const EVENTS_POLL_MS = 4000
const EVENTS_LIMIT = 50

type EventRow = { id: string; at: number; evt: string; tool?: string; text: string }

/** A concise, human label for an event-type token ('tool_start' → 'Tool'). Falls
 *  back to a Title-Cased version of the raw token for anything unmapped. */
function evtLabel(evt: string): string {
  const map: Record<string, string> = {
    tool_start: 'Tool', tool_end: 'Tool ✓', pre_tool_use: 'Tool', post_tool_use: 'Tool ✓',
    agent_message: 'Says', notification: 'Note', user_prompt_submit: 'Prompt',
    task_start: 'Task ▶', task_complete: 'Task ✓', task_assigned: 'Task +',
    stop: 'Turn end', session_start: 'Start', status: 'Status', reasoning: 'Thinks'
  }
  return map[evt] ?? evt.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Accent color for an event row's type chip — tools blue, narration neutral,
 *  task lifecycle green, prompts ink. Keeps the stream scannable at a glance. */
function evtColor(evt: string): string {
  if (evt.includes('tool')) return 'var(--accent)'
  if (evt.startsWith('task')) return 'var(--st-running)'
  if (evt === 'user_prompt_submit') return 'var(--accent-ink)'
  if (evt === 'notification' || evt === 'agent_message' || evt === 'reasoning') return 'var(--tx-3)'
  return 'var(--tx-dim)'
}

export function EventsPanel({ agent, active }: { agent: OfficeAgent | null; active: boolean }): React.JSX.Element {
  const [events, setEvents] = useState<EventRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [stale, setStale] = useState(false) // last poll failed → show "reconnecting…"
  const bodyRef = useRef<HTMLDivElement>(null)
  const atTopRef = useRef(true)

  const slug = agent?.slug ?? ''
  const officeSlug = agent?.officeSlug ?? ''

  // Fresh character = fresh view: drop the previous agent's events immediately so
  // stale rows never bleed across a selection change.
  useEffect(() => { setEvents([]); setLoaded(false); setStale(false); atTopRef.current = true }, [slug, officeSlug])

  // The live poll. Keyed on stable primitives so it doesn't re-arm every 8s office
  // poll. Paused while hidden/no-agent; keeps the last events on a transient error.
  useEffect(() => {
    if (!active || !slug || !officeSlug) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      try {
        const r = await window.api.officeAgentEvents(officeSlug, slug, EVENTS_LIMIT)
        if (!alive) return
        if (r && 'ok' in r) { setEvents(r.events); setStale(false) } else { setStale(true) }
      } catch { if (alive) setStale(true) }
      finally { if (alive) { setLoaded(true); timer = setTimeout(() => void tick(), EVENTS_POLL_MS) } }
    }
    void tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [active, slug, officeSlug])

  // Newest-first: "follow newest" == stay pinned to the TOP. Only snap up when the
  // reader is already near the top, so a poll can't yank scrollback mid-read.
  const onScroll = (): void => { const el = bodyRef.current; if (el) atTopRef.current = el.scrollTop < 40 }
  useEffect(() => { if (atTopRef.current && bodyRef.current) bodyRef.current.scrollTop = 0 }, [events.length && events[0]?.id])

  return (
    <div
      aria-label="Agent events"
      style={{
        width: 320, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0,
        borderLeft: '1px solid var(--bd-2)', background: 'var(--bg-panel)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', borderBottom: '1px solid var(--bd-2)' }}>
        <Icon name="bolt" size={12} />
        <div style={{ flex: 1, fontSize: 'var(--fs-panel-title)', fontWeight: 700, color: 'var(--tx-hi)' }}>Events</div>
        {stale && loaded && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-tiny)', color: 'var(--tx-4)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--tx-dim)' }} />reconnecting…
          </span>
        )}
      </div>
      <div
        ref={bodyRef}
        onScroll={onScroll}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0' }}
      >
        {!agent ? (
          <div style={{ padding: '18px 14px', color: 'var(--tx-4)', fontSize: 'var(--fs-meta)' }}>No character selected.</div>
        ) : !loaded ? (
          <div style={{ padding: '18px 14px', color: 'var(--tx-4)', fontSize: 'var(--fs-meta)' }}>Loading events…</div>
        ) : events.length === 0 ? (
          <div style={{ padding: '18px 14px', color: 'var(--tx-4)', fontSize: 'var(--fs-meta)' }}>No events yet.</div>
        ) : (
          events.map((e) => (
            <div
              key={e.id}
              style={{
                display: 'flex', gap: 9, alignItems: 'baseline', padding: '5px 14px',
                borderBottom: '1px solid var(--bd-3, var(--bd-2))'
              }}
            >
              <span style={{ flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)', minWidth: 38 }}>
                {hhmm(e.at)}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    display: 'inline-block', marginRight: 6, padding: '0 6px', borderRadius: 'var(--r-input)',
                    fontSize: 'var(--fs-tiny)', fontWeight: 700, color: evtColor(e.evt),
                    background: 'var(--bg-input)', whiteSpace: 'nowrap'
                  }}
                >
                  {evtLabel(e.evt)}{e.tool ? ` · ${e.tool}` : ''}
                </span>
                <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-2)', wordBreak: 'break-word' }}>{e.text}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
