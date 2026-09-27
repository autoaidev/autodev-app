import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@renderer/ui'
import { OfficeAgent, hhmm } from './officeTypes'

/**
 * EventsPanel — the office's LIVE server-side activity stream, with two views:
 *
 *   • "All events" (DEFAULT): the WHOLE-OFFICE stream — every agent's events,
 *     newest-first, each row labeled with its agent NAME (like the pixel-office
 *     web "Hook Events" All tab / Room stream). Fetched office-wide via
 *     `officeEvents(officeSlug)` → `GET /api/hooks/events?office_id=…` (no agent_id).
 *   • "Agent events": only the FOCUSED character's events, via `officeAgentEvents`
 *     → `…&agent_id=…`. Requires a focused agent.
 *
 * Source of truth is the office's authoritative `hook_events` (the same feed the
 * pixel-office web "Events" tab renders) — NOT the local `.autodev/hooks-events.jsonl`
 * (grok-tui headless loops don't write it reliably). So the user SEES what working
 * agents are actually doing — tool calls, narration, status, task lifecycle.
 *
 * DEPTH + PAGING (parity with the web activity view): the first fetch pulls a DEEP
 * page (matching the web depth), and "Load older events" walks the FULL history
 * back via the server's `before=<id>` cursor (returned as `nextBefore` / `hasMore`),
 * merging older pages below the live head. A text SEARCH filters the loaded rows.
 *
 * Parameterized so the sidebar AND the per-agent events MODAL (a card icon) share
 * ONE implementation: `lockAgent` forces agent-only mode for `agent` and hides the
 * toggle; `embedded` drops the fixed rail width/border so it fills a modal.
 *
 * Self-contained poll (every EVENTS_POLL_MS while `active`), keyed on the stable
 * primitives (officeSlug, mode, focused slug). Resilient: a transient fetch failure
 * keeps the last events and shows a subtle "reconnecting…" hint. Newest-first;
 * auto-follows the top when the reader is already there.
 */

const EVENTS_POLL_MS = 4000
// Deep first page so the panel matches the pixel-office web activity depth
// immediately; older history is reachable via the `before` cursor below.
const DEEP_LIMIT = 200

type EventRow = { id: string; at: number; evt: string; tool?: string; text: string; agentName?: string }
type Mode = 'all' | 'agent'

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

/** Merge a freshly-fetched page into the loaded list: upsert by id (so a live poll
 *  never drops already-loaded older pages), newest-first. */
function mergeById(existing: EventRow[], incoming: EventRow[]): EventRow[] {
  if (incoming.length === 0) return existing
  const byId = new Map<string, EventRow>()
  for (const e of existing) byId.set(e.id, e)
  for (const e of incoming) byId.set(e.id, e)
  return Array.from(byId.values()).sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
}

export function EventsPanel({
  agent,
  active,
  officeSlug: officeSlugProp,
  lockAgent = false,
  embedded = false
}: {
  agent: OfficeAgent | null
  active: boolean
  officeSlug?: string
  lockAgent?: boolean
  embedded?: boolean
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(lockAgent ? 'agent' : 'all')
  const [events, setEvents] = useState<EventRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [stale, setStale] = useState(false) // last poll failed → show "reconnecting…"
  const [query, setQuery] = useState('')
  // Paging state for "Load older": the oldest-boundary cursor + whether more exist,
  // and whether the user has loaded any older page yet (so the live head poll only
  // seeds the cursor before any manual paging, never resets it afterwards).
  const [cursor, setCursor] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const loadedOlderRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const atTopRef = useRef(true)

  const slug = agent?.slug ?? ''
  const officeSlug = agent?.officeSlug || officeSlugProp || ''

  // "Agent events" needs a focused character; with none, we can only show All.
  // `lockAgent` pins agent mode for the per-agent modal (toggle hidden).
  const effectiveMode: Mode = lockAgent ? 'agent' : (mode === 'agent' && slug ? 'agent' : 'all')

  // Fresh scope = fresh view: drop the previous rows immediately so stale events
  // never bleed across an office / agent / mode change.
  useEffect(() => {
    setEvents([]); setLoaded(false); setStale(false)
    setCursor(null); setHasMore(false); setTotal(0); loadedOlderRef.current = false
    atTopRef.current = true
  }, [officeSlug, slug, effectiveMode])

  // The live poll. Keyed on stable primitives so it doesn't re-arm every office
  // poll. Paused while hidden/no-office; keeps the last events on a transient error.
  useEffect(() => {
    if (!active || !officeSlug) return
    if (effectiveMode === 'agent' && !slug) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      try {
        const r = effectiveMode === 'agent'
          ? await window.api.officeAgentEvents(officeSlug, slug, DEEP_LIMIT)
          : await window.api.officeEvents(officeSlug, DEEP_LIMIT)
        if (!alive) return
        if (r && 'ok' in r) {
          setEvents((prev) => mergeById(prev, r.events))
          setTotal(r.total)
          // Only the FIRST head load seeds the older-paging cursor; once the user has
          // paged older, the cursor/hasMore reflect that deeper boundary — don't reset.
          if (!loadedOlderRef.current) { setCursor(r.nextBefore); setHasMore(r.hasMore) }
          setStale(false)
        } else { setStale(true) }
      } catch { if (alive) setStale(true) }
      finally { if (alive) { setLoaded(true); timer = setTimeout(() => void tick(), EVENTS_POLL_MS) } }
    }
    void tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [active, officeSlug, slug, effectiveMode])

  // "Load older events" — fetch the next page back via the server `before` cursor,
  // merge below the head, and advance the oldest boundary.
  const loadOlder = async (): Promise<void> => {
    if (loadingOlder || cursor == null) return
    setLoadingOlder(true)
    try {
      const r = effectiveMode === 'agent'
        ? await window.api.officeAgentEvents(officeSlug, slug, DEEP_LIMIT, cursor)
        : await window.api.officeEvents(officeSlug, DEEP_LIMIT, cursor)
      if (r && 'ok' in r) {
        loadedOlderRef.current = true
        setEvents((prev) => mergeById(prev, r.events))
        setCursor(r.nextBefore)
        setHasMore(r.hasMore)
        if (r.total) setTotal(r.total)
      }
    } catch { /* transient — the button stays, user can retry */ }
    finally { setLoadingOlder(false) }
  }

  // Client-side SEARCH over the loaded rows (label + tool + text + agent name).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return events
    return events.filter((e) =>
      e.text.toLowerCase().includes(q) ||
      (e.tool ?? '').toLowerCase().includes(q) ||
      evtLabel(e.evt).toLowerCase().includes(q) ||
      (e.agentName ?? '').toLowerCase().includes(q)
    )
  }, [events, query])

  // Newest-first: "follow newest" == stay pinned to the TOP. Only snap up when the
  // reader is already near the top, so a poll can't yank scrollback mid-read.
  const onScroll = (): void => { const el = bodyRef.current; if (el) atTopRef.current = el.scrollTop < 40 }
  useEffect(() => { if (atTopRef.current && bodyRef.current) bodyRef.current.scrollTop = 0 }, [filtered.length && filtered[0]?.id])

  const seg = (m: Mode, label: string, disabled: boolean): React.JSX.Element => (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={mode === m}
      onClick={() => setMode(m)}
      style={{
        flex: 1, padding: '4px 8px', border: 'none', cursor: disabled ? 'default' : 'pointer',
        fontSize: 'var(--fs-tiny)', fontWeight: 700, borderRadius: 'var(--r-input)',
        color: mode === m ? 'var(--tx-hi)' : 'var(--tx-4)',
        background: mode === m ? 'var(--bg-panel)' : 'transparent',
        boxShadow: mode === m ? '0 1px 2px rgba(0,0,0,.12)' : 'none',
        opacity: disabled ? 0.45 : 1
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      aria-label="Office events"
      style={{
        ...(embedded
          ? { width: '100%', flex: 1 }
          : { width: 320, flex: 'none', borderLeft: '1px solid var(--bd-2)' }),
        display: 'flex', flexDirection: 'column', minHeight: 0,
        background: 'var(--bg-panel)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px 8px', borderBottom: '1px solid var(--bd-2)', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <Icon name="bolt" size={12} />
          <div style={{ flex: 1, fontSize: 'var(--fs-panel-title)', fontWeight: 700, color: 'var(--tx-hi)' }}>
            Events{total ? <span style={{ marginLeft: 6, fontWeight: 600, color: 'var(--tx-dim)', fontSize: 'var(--fs-tiny)' }}>{total.toLocaleString()}</span> : null}
          </div>
          {stale && loaded && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-tiny)', color: 'var(--tx-4)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--tx-dim)' }} />reconnecting…
            </span>
          )}
        </div>
        {/* 2-segment view toggle: All events (whole office) vs Agent events (focused).
            Hidden when the panel is locked to one agent (per-agent modal). */}
        {!lockAgent && (
          <div style={{ display: 'flex', gap: 2, width: '100%', padding: 2, borderRadius: 'var(--r-input)', background: 'var(--bg-input)' }}>
            {seg('all', 'All events', false)}
            {seg('agent', 'Agent events', !slug)}
          </div>
        )}
        {/* SEARCH over the loaded rows. */}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search events…"
          aria-label="Search events"
          style={{
            width: '100%', background: 'var(--bg-input)', border: '1px solid var(--bd-1)',
            borderRadius: 'var(--r-input)', color: 'var(--tx-1)', fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-meta)', padding: '5px 9px', outline: 'none'
          }}
        />
      </div>
      <div
        ref={bodyRef}
        onScroll={onScroll}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 0' }}
      >
        {!officeSlug ? (
          <div style={{ padding: '18px 14px', color: 'var(--tx-4)', fontSize: 'var(--fs-meta)' }}>No office open.</div>
        ) : !loaded ? (
          <div style={{ padding: '18px 14px', color: 'var(--tx-4)', fontSize: 'var(--fs-meta)' }}>Loading events…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '18px 14px', color: 'var(--tx-4)', fontSize: 'var(--fs-meta)' }}>
            {query.trim() ? 'No events match your search.' : 'No events yet.'}
          </div>
        ) : (
          <>
            {filtered.map((e) => (
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
                  {/* In All-events mode, tag each row with its agent name (muted, right-aligned). */}
                  {effectiveMode === 'all' && e.agentName && (
                    <span style={{ display: 'block', marginTop: 1, textAlign: 'right', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)', fontWeight: 600 }}>
                      {e.agentName}
                    </span>
                  )}
                </div>
              </div>
            ))}
            {/* PAGING — walk the full history back. Hidden once the server reports no
                older events. Disabled/labeled while a page is in flight. */}
            {hasMore && !query.trim() && (
              <div style={{ padding: '8px 14px 4px', textAlign: 'center' }}>
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  disabled={loadingOlder || cursor == null}
                  style={{
                    background: 'transparent', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)',
                    color: 'var(--accent)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-desc)',
                    fontWeight: 600, padding: '5px 12px', cursor: loadingOlder ? 'default' : 'pointer'
                  }}
                >
                  {loadingOlder ? 'Loading…' : 'Load older events'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
