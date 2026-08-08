import { useEffect, useRef, useState } from 'react'
import { SearchInput, Pill, Button, Icon } from '@renderer/ui'
import TerminalPane from '../TerminalPane'
import { SessionRow } from '../components/sessions/SessionRow'
import { TranscriptPane } from '../components/sessions/TranscriptPane'
import {
  type SessionMeta,
  type ProviderFilter,
  PROVIDERS,
  GROUP_LABEL,
  keyOf,
  foldGroup
} from '../components/sessions/types'
import { useSessions, useSessionTranscript, useSessionActions } from '../services/sessionsService'
import { useAppActions } from '../services/appActions'
import '../components/sessions/sessions.css'

/**
 * 2d — Sessions. Grouped, named sessions (never a wall of "(untitled)"): a
 * 352px session list on the left (live-count header, search, provider Pills,
 * LIVE NOW / EARLIER TODAY / YESTERDAY sections, duplicate-run folding) and a
 * transcript pane on the right (STREAMING pill, Resume-here / Export, chat
 * bubbles + mono tool-lines, an "Interject" composer).
 *
 * S3 of the services refactor: this view is now a thin CONSUMER of
 * sessionsService — useSessions() owns discovery/list/provider-filter/grouping,
 * useSessionTranscript() owns the backlog fetch + claude live-tail + the
 * monotonic stale-open guard (so a session survives this view being hidden or
 * unmounted), and useSessionActions() owns newSession / Resume-into-office /
 * interject / exportTrace + the live interactive-PTY identity. The view keeps
 * only presentation state (provider filter, search query, expanded folds) and
 * still renders ONE MOUNTED <TerminalPane> (display:none while a transcript is
 * peeked) so the live PTY is never SIGKILLed by a remount.
 */
export function SessionsView({ active = true }: { active?: boolean } = {}): JSX.Element {
  const { openAgent, newAgent, toast } = useAppActions()

  // "Open as agent" for a session whose folder isn't an AutoDev workspace. The old
  // path called openAgent({path}) — which only reveals an ALREADY-registered agent,
  // so it always failed with a misleading "runs remotely" toast and still yanked to
  // Agents. Instead: register the folder if it's already a workspace and reveal it;
  // otherwise route to the create-agent funnel seeded with the folder (no bounce).
  const openAsAgent = async (cwd: string): Promise<void> => {
    try {
      const r = (await window.api.addAgent(cwd)) as { error?: string; path?: string }
      if (r && typeof r === 'object' && 'error' in r && r.error) {
        newAgent({ path: cwd })
        return
      }
      openAgent({ path: cwd })
    } catch {
      toast('Could not open that folder as an agent.', true)
    }
  }
  const [filter, setFilter] = useState<ProviderFilter>('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // The user's selection intent; the service opens it and owns the transcript
  // state. `sel` (below) is the ACTUAL open session from the store — it can
  // diverge from `selRef` when a service action (newSession / confirmResume /
  // backToTerminal) deselects the transcript, hence the sync effect.
  const [selRef, setSelRef] = useState<SessionMeta | null>(null)

  const { shown, groups, groupOrder, liveCount, total, providerCount, loading, refresh } = useSessions({
    provider: filter,
    query,
    active
  })

  const transcript = useSessionTranscript(selRef)
  const sel = transcript.session
  const { messages: msgs, workspace } = transcript

  const {
    term,
    exportNote,
    connect,
    resume,
    confirmResume,
    cancelResume,
    setOfficeSel,
    newSession,
    interject,
    exportTrace,
    backToTerminal,
    closeTerm
  } = useSessionActions()

  // Keep the local selection intent in sync with the store: when a service
  // action deselects the transcript (newSession / confirmResume swap in a live
  // PTY, or backToTerminal), clear `selRef` so re-clicking the same row re-keys
  // useSessionTranscript and opens it again.
  useEffect(() => {
    if (!sel) setSelRef(null)
  }, [sel])

  // Auto-select the top (most-recent / live) session ONCE on first load so the
  // transcript pane opens populated instead of a void — the EmptyState is kept
  // only for a genuinely empty list or after the user closes everything. Guarded
  // by a ref so it never fights a later manual deselection (New session /
  // back-to-terminal leave `term` set, which also suppresses re-selection).
  const didAutoSelect = useRef(false)
  useEffect(() => {
    if (didAutoSelect.current || loading) return
    if (term || sel || selRef) return
    if (shown.length > 0) {
      didAutoSelect.current = true
      setSelRef(shown[0])
    }
  }, [loading, shown, term, sel, selRef])

  const selKey = sel ? keyOf(sel) : null

  return (
    <div className="sv-root">
      {/* ---------- session list ---------- */}
      <div className="sv-list">
        <div className="sv-list-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <strong style={{ fontSize: 'var(--fs-panel-title)', fontWeight: 700, color: 'var(--tx-hi)' }}>Sessions</strong>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>
              {total} · {liveCount} live
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
              const isActive = filter === f
              const n = providerCount(f)
              return (
                <Pill
                  key={f}
                  variant={isActive ? 'accent' : 'neutral'}
                  selected={isActive}
                  onClick={() => setFilter(f)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilter(f) } }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isActive}
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
              {total === 0 ? 'No sessions found on this machine.' : `No matching ${filter === 'all' ? '' : filter + ' '}sessions.`}
            </div>
          )}

          {!loading && groupOrder.map((gid) => {
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
                        onSelect={setSelRef}
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
                            <SessionRow key={keyOf(s)} session={s} selected={selKey === keyOf(s)} onSelect={setSelRef} />
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
              <Button size="sm" danger onClick={closeTerm} title="End session & close pane">
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
                onExit={() => void refresh()}
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
              onResume={() => resume(sel)}
              resumeDisabled={sel.provider !== 'claude'}
              resumeTitle={sel.provider === 'claude'
                ? 'Bind this session to a pixel office and resume it live as an agent'
                : 'Resume live is supported for Claude sessions only'}
              onExport={() => exportTrace(sel.cwd)}
              exportDisabled={workspace ? !workspace.exists : false}
              exportTitle={workspace && !workspace.exists
                ? "Export needs an AutoDev workspace (.autodev/settings.json) — this session's folder isn't one"
                : "Export this session's trace"}
              onInterject={(text) => interject(sel.cwd, text)}
              interjectDisabled={workspace ? !workspace.exists : false}
              interjectHint={workspace && !workspace.exists
                ? "This session ran in a folder that isn't set up as an agent workspace, so you can't send messages here. Open it as an agent to continue."
                : undefined}
              interjectAction={workspace && !workspace.exists
                ? {
                    label: 'Open as agent ↗',
                    onClick: () => void openAsAgent(sel.cwd)
                  }
                : undefined}
              notice={exportNote}
              connectSlot={connect.open && (
              <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--bd-2)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', background: 'var(--bg-1)' }}>
                <span id="sv-resume-lbl" style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-3)' }}>Resume live as a character in:</span>
                <select
                  aria-labelledby="sv-resume-lbl"
                  value={connect.officeSel}
                  onChange={(e) => setOfficeSel(e.target.value)}
                  style={{ fontSize: 'var(--fs-body)', padding: '5px 8px', background: 'var(--bg-input)', color: 'var(--tx-1)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)' }}
                >
                  {connect.offices.length === 0 && <option value="">(no offices)</option>}
                  {connect.offices.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
                </select>
                <Button variant="primary" size="sm" onClick={confirmResume} disabled={connect.busy || !connect.officeSel}>
                  {connect.busy ? 'Connecting…' : 'Connect & resume'}
                </Button>
                <Button size="sm" onClick={cancelResume}>Cancel</Button>
                {connect.err && <span role="alert" style={{ fontSize: 'var(--fs-meta)', color: 'var(--st-error)' }}>{connect.err}</span>}
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
