import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SearchInput, Pill, Button, Icon } from '@renderer/ui'
import TerminalPane from '../TerminalPane'
import { SessionRow } from '../components/sessions/SessionRow'
import { TranscriptPane } from '../components/sessions/TranscriptPane'
import {
  type SessionMeta,
  type SessionMsg,
  type ProviderFilter,
  type GroupId,
  PROVIDERS,
  GROUP_LABEL,
  keyOf,
  groupOf,
  foldGroup
} from '../components/sessions/types'
import '../components/sessions/sessions.css'

const GROUP_ORDER: GroupId[] = ['live', 'today', 'yesterday', 'earlier']

interface Office { slug: string; id: number; name: string }
type TermState = { id: string; cwd: string; command?: string; name?: string }

/**
 * 2d — Sessions. Grouped, named sessions (never a wall of "(untitled)"): a
 * 352px session list on the left (live-count header, search, provider Pills,
 * LIVE NOW / EARLIER TODAY / YESTERDAY sections, duplicate-run folding) and a
 * transcript pane on the right (STREAMING pill, Resume-here / Export, chat
 * bubbles + mono tool-lines, an "Interject" composer).
 *
 * Wires to the real sessions api: sessionsDiscover / sessionBacklog /
 * sessionOpen+Close + onSessionData (live claude tail). Resume-here binds a
 * claude session into a pixel office (officeConnectSession) and streams it as a
 * PTY; New session spawns an interactive PTY (ptySpawn via TerminalPane).
 */
export function SessionsView({ active = true }: { active?: boolean } = {}): JSX.Element {
  const [list, setList] = useState<SessionMeta[]>([])
  const [filter, setFilter] = useState<ProviderFilter>('all')
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState<SessionMeta | null>(null)
  const [msgs, setMsgs] = useState<SessionMsg[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [term, setTerm] = useState<TermState | null>(null)
  // Whether the selected session's cwd is a writable AutoDev workspace — gates
  // Interject (queues into TODO.md) and Export (needs .autodev/settings.json).
  const [workspace, setWorkspace] = useState<{ exists: boolean } | null>(null)
  // Transient export result surfaced in the transcript header.
  const [exportNote, setExportNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  // Resume-here (claude → office) inline connect bar state.
  const [connectOpen, setConnectOpen] = useState(false)
  const [offices, setOffices] = useState<Office[]>([])
  const [officeSel, setOfficeSel] = useState('')
  const [connectErr, setConnectErr] = useState('')
  const [connectBusy, setConnectBusy] = useState(false)

  const selFile = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    const l = (await window.api.sessionsDiscover()) as SessionMeta[]
    setList(l)
    setLoading(false)
  }, [])

  // Rescan on mount + every 5s. (This view stays mounted across tab switches so a
  // live Resume PTY survives — see CURRENT-APP §5.1 — hence the light poll.) The
  // poll is gated on `active` so a hidden tab stops rescanning the filesystem; we
  // still refresh immediately whenever the tab (re)activates.
  useEffect(() => {
    refresh()
    if (!active) return
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [refresh, active])

  // Live tail: append incoming lines for the currently-open transcript (claude).
  useEffect(() => {
    const off = window.api.onSessionData(({ file, msgs: incoming }: { file: string; msgs: SessionMsg[] }) => {
      if (file === selFile.current) {
        setMsgs((m) => {
          const next = [...m, ...incoming]
          return next.length > 1000 ? next.slice(-1000) : next
        })
      }
    })
    return off
  }, [])

  // Close any open live-tail when the view unmounts.
  useEffect(() => () => { if (selFile.current) window.api.sessionClose(selFile.current) }, [])

  const openSession = useCallback(async (s: SessionMeta) => {
    const prev = selFile.current
    selFile.current = s.provider === 'claude' ? s.file : null
    // NOTE: do NOT setTerm(null) here. The terminal and transcript are visually
    // mutually exclusive, but tearing down the TerminalPane runs its [id] cleanup
    // → window.api.ptyKill → the live Resume/New PTY dies. We keep the pane MOUNTED
    // (hidden via display:none while a transcript is shown, see the pane below) so
    // peeking another session never silently kills a running session.
    setSel(s)
    setMsgs([])
    setConnectOpen(false)
    setWorkspace(null)
    setExportNote(null)
    try {
      if (prev && prev !== selFile.current) await window.api.sessionClose(prev)
      setMsgs((await window.api.sessionBacklog({ file: s.file, provider: s.provider, id: s.id, cwd: s.cwd })) as SessionMsg[])
      if (s.provider === 'claude' && s.file) await window.api.sessionOpen(s.file)
    } catch (e) { console.error('[SessionsView.openSession]', e) }
    try {
      const info = (await window.api.workspaceInfo(s.cwd)) as { exists: boolean }
      setWorkspace({ exists: !!info?.exists })
    } catch { setWorkspace({ exists: false }) }
  }, [])

  // Return to a live terminal that's been hidden behind a peeked transcript.
  const backToTerminal = useCallback(async () => {
    if (selFile.current) { await window.api.sessionClose(selFile.current); selFile.current = null }
    setSel(null); setMsgs([]); setConnectOpen(false); setExportNote(null)
  }, [])

  const newSession = useCallback(async () => {
    const cwd = (await window.api.pickFolder()) as string | null
    if (!cwd) return
    // Replacing a live `term` remounts the TerminalPane (new key) → its [id]
    // cleanup runs ptyKill and the running session dies. Never do that silently:
    // gate the replacement behind the app's native destructive-confirm dialog.
    if (term && !(await window.api.confirmDialog(
      `End the live "${term.name ?? 'claude'}" session?`,
      `Starting a new session in\n${cwd}\nwill terminate the session running in\n${term.cwd}`
    ))) return
    if (selFile.current) { await window.api.sessionClose(selFile.current); selFile.current = null }
    setSel(null); setMsgs([])
    setTerm({ id: `pty-${Date.now()}`, cwd })
  }, [term])

  // Resume-here: claude sessions bind into a pixel office and resume live.
  const openResume = useCallback(async () => {
    if (!sel) return
    const st = await window.api.officeStatus()
    if (!st.connected) {
      const ok = await window.api.officeAutoConnect()
      if (!ok) { setConnectErr('Connect a pixel-office first (Office tab).'); setConnectOpen(true); return }
    }
    let offs: Office[] = []
    try {
      offs = (await window.api.officeOffices()) as Office[]
    } catch (e) {
      setConnectErr(String((e as Error)?.message ?? e) || 'Could not load your offices — reconnect.')
      setOffices([]); setConnectOpen(true); return
    }
    setOffices(offs); setOfficeSel(offs[0]?.slug ?? ''); setConnectErr(''); setConnectOpen(true)
  }, [sel])

  const confirmResume = useCallback(async () => {
    const off = offices.find((o) => o.slug === officeSel)
    if (!off || !sel) return
    // Resuming binds into a fresh Operate PTY that replaces `term`; if one is
    // already live, that remount would ptyKill it. Confirm before we do the
    // office side-effect, so a running session is never dropped silently.
    if (term && !(await window.api.confirmDialog(
      `End the live "${term.name ?? 'claude'}" session?`,
      `Resuming this session will terminate the session running in\n${term.cwd}`
    ))) return
    setConnectBusy(true); setConnectErr('')
    const r = (await window.api.officeConnectSession(off.slug, off.id, sel.cwd, sel.id, sel.title)) as {
      cwd: string; sessionId: string; agentName: string; error?: string
    }
    setConnectBusy(false)
    if (r?.error) { setConnectErr(r.error); return }
    setConnectOpen(false)
    if (selFile.current) { await window.api.sessionClose(selFile.current); selFile.current = null }
    setSel(null); setMsgs([])
    setTerm({ id: `op-${Date.now()}`, cwd: r.cwd, command: `claude --resume ${r.sessionId}`, name: `${r.agentName} · live` })
  }, [offices, officeSel, sel, term])

  const exportTrace = useCallback(async () => {
    if (!sel) return
    setExportNote(null)
    const out = (await window.api.saveFile(`${sel.provider}-${sel.id.slice(0, 8)}.trace.txt`)) as string | null
    if (!out) return
    // exportTrace keys off the workspace path (grok native trace / backup zip).
    const r = await window.api.exportTrace(sel.cwd, out)
    if ('error' in r) { setExportNote({ kind: 'error', text: r.error }); return }
    setExportNote({ kind: 'ok', text: r.note ? `Exported to ${r.output} — ${r.note}` : `Exported to ${r.output}` })
  }, [sel])

  const interject = useCallback(async (text: string): Promise<{ error?: string }> => {
    if (!sel) return { error: 'No session selected.' }
    // No api injects a message straight into a read transcript. The closest real
    // write is queuing a task into the session's workspace TODO.md
    // (sendAgentMessage); it rejects a non-AutoDev cwd, so surface that {error}
    // instead of discarding it (the live steer path needs an office agent id we
    // don't have from a bare SessionMeta).
    const r = (await window.api.sendAgentMessage(sel.cwd, text)) as { ok: true } | { error: string }
    if ('error' in r) return { error: r.error }
    return {}
  }, [sel])

  // ---- derived: filter + search + group + fold ----
  const liveCount = useMemo(() => list.filter((s) => s.live).length, [list])
  const providerCount = useCallback(
    (p: ProviderFilter) => (p === 'all' ? list.length : list.filter((s) => s.provider === p).length),
    [list]
  )

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list
      .filter((s) => filter === 'all' || s.provider === filter)
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
      .sort((a, b) => b.mtime - a.mtime)
  }, [list, filter, query])

  const groups = useMemo(() => {
    const map: Record<GroupId, SessionMeta[]> = { live: [], today: [], yesterday: [], earlier: [] }
    for (const s of shown) map[groupOf(s)].push(s)
    return map
  }, [shown])

  const selKey = sel ? keyOf(sel) : null

  return (
    <div className="sv-root">
      {/* ---------- session list ---------- */}
      <div className="sv-list">
        <div className="sv-list-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <strong style={{ fontSize: 'var(--fs-panel-title)', fontWeight: 700, color: 'var(--tx-hi)' }}>Sessions</strong>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>
              {list.length} · {liveCount} live
            </span>
            <div style={{ flex: 1 }} />
            <Button variant="primary" size="sm" onClick={newSession} title="Spawn a new interactive Claude session in a folder">
              <Icon name="plus" size={12} /> New session
            </Button>
          </div>
          <SearchInput
            width="100%"
            placeholder="Search prompts and output"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sessions"
          />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['all', ...PROVIDERS] as ProviderFilter[]).map((f) => {
              const active = filter === f
              const n = providerCount(f)
              return (
                <Pill
                  key={f}
                  variant={active ? 'accent' : 'neutral'}
                  selected={active}
                  onClick={() => setFilter(f)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilter(f) } }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  style={{ cursor: 'pointer' }}
                >
                  {f === 'all' ? 'All' : f}
                  <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.7, marginLeft: 4 }}>{n}</span>
                </Pill>
              )
            })}
          </div>
        </div>

        <div className="sv-list-scroll">
          {loading && <div className="sv-empty">Scanning sessions…</div>}
          {!loading && shown.length === 0 && (
            <div className="sv-empty">
              {list.length === 0 ? 'No sessions found on this machine.' : `No matching ${filter === 'all' ? '' : filter + ' '}sessions.`}
            </div>
          )}

          {!loading && GROUP_ORDER.map((gid) => {
            const items = groups[gid]
            if (items.length === 0) return null
            const listItems = foldGroup(items)
            return (
              <div key={gid}>
                <div className="sv-section">
                  <span>{GROUP_LABEL[gid]}</span>
                  <span className="sv-count">{items.length}</span>
                </div>
                {listItems.map((it) => {
                  if (it.kind === 'row') {
                    return (
                      <SessionRow
                        key={keyOf(it.session)}
                        session={it.session}
                        selected={selKey === keyOf(it.session)}
                        onSelect={openSession}
                      />
                    )
                  }
                  // folded duplicate-run group
                  const fkey = `fold:${gid}:${it.title}`
                  const isOpen = expanded.has(fkey)
                  return (
                    <div key={fkey}>
                      <button
                        type="button"
                        className="sv-fold"
                        aria-expanded={isOpen}
                        onClick={() => setExpanded((prev) => {
                          const next = new Set(prev)
                          if (next.has(fkey)) next.delete(fkey); else next.add(fkey)
                          return next
                        })}
                      >
                        <Icon name="caret" size={9} color="var(--tx-4)" style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }} />
                        <span className="sv-fold-label">{it.sessions.length} runs of “{it.title}”</span>
                        <span className="sv-fold-link">{isOpen ? 'collapse' : 'expand'}</span>
                      </button>
                      {isOpen && (
                        <div className="sv-fold-children">
                          {it.sessions.map((s) => (
                            <SessionRow key={keyOf(s)} session={s} selected={selKey === keyOf(s)} onSelect={openSession} />
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {/* ---------- transcript / terminal pane ---------- */}
      <div className="sv-pane">
        {/* The terminal stays MOUNTED whenever `term` is set — hidden (not
            unmounted) while a transcript is peeked, so the live PTY survives. */}
        {term && (
          <div style={{ display: sel ? 'none' : 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <div className="sv-pane-head">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="sv-pane-title">
                  <h2>{term.name ?? 'claude'}</h2>
                  <Pill variant="green" mono selected>LIVE</Pill>
                </div>
                <div className="sv-pane-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{term.cwd}</div>
              </div>
              <Button size="sm" danger onClick={() => setTerm(null)} title="End session & close pane">
                <Icon name="stop" size={11} /> Close
              </Button>
            </div>
            <div className="sv-term">
              <TerminalPane
                key={term.id}
                id={term.id}
                cwd={term.cwd}
                command={term.command ?? 'claude'}
                keepShell={term.command ? false : undefined}
                onExit={() => refresh()}
              />
            </div>
          </div>
        )}

        {!term && !sel && (
          <div className="sv-empty">
            Select a session to read its transcript
            <br />— or <b>New session</b> to start a fresh one.
          </div>
        )}

        {sel && (
          <>
            {term && (
              <button
                type="button"
                onClick={backToTerminal}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  padding: '7px 18px', border: 'none', borderBottom: '1px solid var(--bd-2)',
                  background: 'var(--st-running-wash)', color: 'var(--tx-2)',
                  fontSize: 'var(--fs-meta)', cursor: 'pointer'
                }}
                title="Return to the live session running in the background"
              >
                <Pill variant="green" mono selected>LIVE</Pill>
                <span>{term.name ?? 'claude'} is still running in the background — return</span>
                <Icon name="caret" size={9} color="var(--tx-4)" style={{ transform: 'rotate(-90deg)', marginLeft: 'auto' }} />
              </button>
            )}
            <TranscriptPane
              session={sel}
              msgs={msgs}
              onResume={openResume}
              resumeDisabled={sel.provider !== 'claude'}
              resumeTitle={sel.provider === 'claude'
                ? 'Bind this session to a pixel office and resume it live as an agent'
                : 'Resume live is supported for Claude sessions only'}
              onExport={exportTrace}
              exportDisabled={workspace ? !workspace.exists : false}
              exportTitle={workspace && !workspace.exists
                ? "Export needs an AutoDev workspace (.autodev/settings.json) — this session's folder isn't one"
                : "Export this session's trace"}
              onInterject={interject}
              interjectDisabled={workspace ? !workspace.exists : false}
              interjectHint={workspace && !workspace.exists
                ? "Read-only: this session's folder isn't an AutoDev workspace, so there's nowhere to queue a message."
                : undefined}
              notice={exportNote}
              connectSlot={connectOpen && (
              <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--bd-2)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', background: 'var(--bg-1)' }}>
                <span id="sv-resume-lbl" style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-3)' }}>Resume live as a character in:</span>
                <select
                  aria-labelledby="sv-resume-lbl"
                  value={officeSel}
                  onChange={(e) => setOfficeSel(e.target.value)}
                  style={{ fontSize: 'var(--fs-body)', padding: '5px 8px', background: 'var(--bg-input)', color: 'var(--tx-1)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)' }}
                >
                  {offices.length === 0 && <option value="">(no offices)</option>}
                  {offices.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
                </select>
                <Button variant="primary" size="sm" onClick={confirmResume} disabled={connectBusy || !officeSel}>
                  {connectBusy ? 'Connecting…' : 'Connect & resume'}
                </Button>
                <Button size="sm" onClick={() => setConnectOpen(false)}>Cancel</Button>
                {connectErr && <span role="alert" style={{ fontSize: 'var(--fs-meta)', color: 'var(--st-error)' }}>{connectErr}</span>}
              </div>
            )}
            />
          </>
        )}
      </div>
    </div>
  )
}

export default SessionsView
