import React from 'react'
import { Button, StatusDot, Pill, Icon } from '@renderer/ui'
import { AgentState, providerShort } from './AgentRow'
import { isAttention, attentionSummary } from '@renderer/services/model'
import { useOfficeConnection, deriveOfficeLinkStatus } from '@renderer/services/officeService'
import { useAppActions } from '@renderer/services/appActions'
import { useSessionActions } from '@renderer/services/sessionsService'
import type { SessionMeta } from '@renderer/components/sessions/types'
import type { TodoItem, AgentTasks } from './useAgentTasks'
import { ModelSelect } from '@renderer/components/ModelSelect'
import { useModelCatalog, effectiveModelDisplay } from '@renderer/lib/providers'
import { actions } from '@renderer/services/agentStore'
import { useAdvancedMode } from '@renderer/services/advancedMode'

/**
 * Inspector — the fixed 308px right panel of the Agent-detail screen (2a). Three
 * stacked sections that never co-scroll with the activity stream:
 *   1. TODO.MD   — the checkable task list + progress (from `status --all`)
 *   2. SESSION   — the live provider session card (from sessionsDiscover)
 *   3. SETUP     — provider / model / office / MCP / files key-value rows
 *
 * Config lives behind an Edit… affordance (AgentConfigModal / McpEditorModal),
 * demoted to a modal per the redesign thesis.
 */

const MODEL_KEY: Record<string, string> = {
  claude: 'claudeModel',
  opencode: 'opencodeModel',
  copilot: 'copilotModel',
  grok: 'grokModel',
  dummy: 'dummyModel'
}
function modelKeyFor(provider?: string): string {
  return MODEL_KEY[(provider || '').split('-')[0]] ?? 'claudeModel'
}

// SessionMeta is the shared Sessions-screen type (imported above) — reusing it
// (rather than a local subset) lets the discovered session flow straight into
// the Sessions service's open() without a field mismatch (it carries `project`).

/* --------------------------------------------------------------- primitives */

function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <span
        style={{
          fontSize: 'var(--fs-section)',
          fontWeight: 700,
          letterSpacing: 'var(--ls-section)',
          color: 'var(--tx-section)',
          textTransform: 'uppercase'
        }}
      >
        {children}
      </span>
      {right && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>{right}</div>}
    </div>
  )
}

function LinkBtn({ children, onClick }: { children: React.ReactNode; onClick?: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ all: 'unset', cursor: 'pointer', color: 'var(--accent)', fontSize: 'var(--fs-desc)' }}
    >
      {children}
    </button>
  )
}

function ProgressBar({ ratio, tone = 'accent' }: { ratio: number; tone?: 'accent' | 'idle' }): React.JSX.Element {
  return (
    <div style={{ height: 'var(--h-progress)', borderRadius: 'var(--r-bar)', background: 'var(--st-track-bg)', overflow: 'hidden' }}>
      <div
        style={{
          width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`,
          height: '100%',
          background: tone === 'idle' ? 'var(--st-track)' : 'var(--accent)'
        }}
      />
    </div>
  )
}

function KeyValueRow({ k, v, suffix }: { k: string; v: React.ReactNode; suffix?: React.ReactNode }): React.JSX.Element {
  // Field name is the quieter tier by CASE + tracking (uppercase micro-label), the
  // value the emphasized tier (primary text) — so a scan separates key from value
  // at a glance rather than reading two same-size greys.
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 0' }}>
      <span
        style={{
          flex: 'none',
          width: 74,
          fontSize: 'var(--fs-section)',
          fontWeight: 500,
          letterSpacing: 'var(--ls-state)',
          textTransform: 'uppercase',
          color: 'var(--tx-section)'
        }}
      >
        {k}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 'var(--fs-meta)',
          color: 'var(--tx-hi)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {v}
        {suffix}
      </span>
    </div>
  )
}

/* ----------------------------------------------------------------- sections */

const TODO_GLYPH: Record<TodoItem['state'], { glyph: string; color: string }> = {
  active: { glyph: '◑', color: 'var(--accent)' },
  pending: { glyph: '○', color: 'var(--tx-faint)' },
  done: { glyph: '✓', color: 'var(--st-running)' }
}

function TodoSection({ agent, todo }: { agent: AgentState; todo: AgentTasks }): React.JSX.Element {
  // Optimistic local check overlay: there is no API to toggle a single TODO item
  // (sendAgentMessage only APPENDS). Clicks toggle the visual only.
  // TODO(redesign): expose a per-item TODO toggle in the CLI to persist this.
  const [localDone, setLocalDone] = React.useState<Set<number>>(new Set())
  React.useEffect(() => setLocalDone(new Set()), [agent.path])

  // The header count and the body derive from ONE reconciled truth (useAgentTasks),
  // shared with the AgentDetail header so the two counters can never disagree.
  const { items, loaded, done, total, ratio, remaining, inProgress, emptyDone } = todo
  const list = items ?? []
  // An interrupted / retry-exhausted / needs-you run must never read as calmly
  // "All tasks complete" — surface the attention reason instead (R4).
  const attention = isAttention(agent) ? attentionSummary(agent) : null

  return (
    <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--bd-card)' }}>
      <SectionLabel
        right={
          <>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>
              {done} / {total}
            </span>
            <LinkBtn onClick={() => window.api.openPath(`${agent.path}/TODO.md`)}>Open file</LinkBtn>
          </>
        }
      >
        TODO.md
      </SectionLabel>
      <ProgressBar ratio={ratio} tone={attention ? 'idle' : 'accent'} />
      <div style={{ marginTop: 10 }}>
        {!loaded && <div style={{ color: 'var(--tx-5)', fontSize: 'var(--fs-meta)' }}>Loading…</div>}
        {loaded && attention && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '5px 6px' }}>
            <span style={{ flex: 'none', width: 11, color: 'var(--st-needsyou)', fontSize: 'var(--fs-mono-code)', lineHeight: '17px' }}>
              !
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-meta)', lineHeight: 1.4, color: 'var(--st-needsyou)', fontWeight: 600 }}>
              {attention}
            </span>
          </div>
        )}
        {!attention && inProgress && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '5px 6px' }}>
            <span style={{ flex: 'none', width: 11, color: 'var(--accent)', fontSize: 'var(--fs-mono-code)', lineHeight: '17px' }}>
              ◑
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-meta)', lineHeight: 1.4, color: 'var(--tx-hi)', fontWeight: 600 }}>
              {remaining} task{remaining === 1 ? '' : 's'} in progress — see the Activity tab.
            </span>
          </div>
        )}
        {!attention && emptyDone && (
          <div style={{ color: 'var(--tx-5)', fontSize: 'var(--fs-meta)' }}>
            {done > 0 ? 'All tasks complete.' : 'No tasks in TODO.md.'}
          </div>
        )}
        {list.map((it, i) => {
          const shown: TodoItem['state'] = localDone.has(i) ? 'done' : it.state
          const g = TODO_GLYPH[shown]
          const active = shown === 'active'
          return (
            <button
              key={i}
              type="button"
              onClick={() =>
                setLocalDone((prev) => {
                  const next = new Set(prev)
                  if (next.has(i)) next.delete(i)
                  else next.add(i)
                  return next
                })
              }
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 9,
                width: '100%',
                textAlign: 'left',
                padding: '5px 6px',
                borderRadius: 'var(--r-chip)',
                border: 'none',
                background: active ? 'var(--bg-todo-active)' : 'transparent',
                cursor: 'pointer'
              }}
            >
              <span style={{ flex: 'none', width: 11, color: g.color, fontSize: 'var(--fs-mono-code)', lineHeight: '17px' }}>
                {g.glyph}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 'var(--fs-meta)',
                  lineHeight: 1.4,
                  color: shown === 'done' ? 'var(--tx-dim)' : active ? 'var(--tx-hi)' : 'var(--tx-2)',
                  fontWeight: active ? 600 : 400,
                  textDecoration: shown === 'done' ? 'line-through' : 'none',
                  textDecorationColor: 'var(--st-idle)'
                }}
              >
                {it.text}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SessionSection({ agent, onWatch }: { agent: AgentState; onWatch: () => void }): React.JSX.Element {
  const [session, setSession] = React.useState<SessionMeta | null | undefined>(undefined)
  // Route the SESSION links into the in-app Sessions screen rather than shelling
  // the raw .jsonl out to the OS (openPath on a trace file is a no-op / dumps
  // JSON into an editor). navigate('sessions') swaps the top-nav tab; open(s)
  // seeds the shared transcript store so SessionsView's TranscriptPane renders
  // THIS session (its `sel` derives from that store), not just the global latest.
  const { navigate } = useAppActions()
  const { open: openSession } = useSessionActions()

  const openInSessions = React.useCallback(
    (s: SessionMeta) => {
      navigate('sessions')
      void openSession(s)
    },
    [navigate, openSession]
  )

  React.useEffect(() => {
    let live = true
    setSession(undefined)
    window.api
      .sessionsDiscover()
      .then((all: SessionMeta[]) => {
        if (!live) return
        const mine = (all || [])
          .filter((s) => s.cwd && (s.cwd === agent.path || agent.path.startsWith(s.cwd) || s.cwd.startsWith(agent.path)))
          .sort((a, b) => b.mtime - a.mtime)
        setSession(mine[0] ?? null)
      })
      .catch(() => live && setSession(null))
    return () => {
      live = false
    }
  }, [agent.path])

  return (
    <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--bd-card)' }}>
      <SectionLabel right={<LinkBtn onClick={() => navigate('sessions')}>All sessions</LinkBtn>}>Session</SectionLabel>
      {session === undefined && <div style={{ color: 'var(--tx-5)', fontSize: 'var(--fs-meta)' }}>Loading…</div>}
      {session === null && (
        <div style={{ color: 'var(--tx-5)', fontSize: 'var(--fs-meta)' }}>No session discovered for this workspace yet.</div>
      )}
      {session && (
        <div style={{ background: 'var(--grad-card)', border: '1px solid var(--bd-card)', borderRadius: 'var(--r-card)', padding: '10px 12px', boxShadow: 'var(--depth-card)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusDot status={session.live ? 'running' : 'idle'} glow={session.live} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {session.provider}-{session.id.slice(0, 10)}
            </span>
            {session.live && (
              <Pill variant="green" mono>
                LIVE
              </Pill>
            )}
          </div>
          <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>
            {session.msgs} msgs · {session.sizeKb}kb
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <Button size="sm" block onClick={onWatch}>
              Watch live
            </Button>
            <Button size="sm" block onClick={() => openInSessions(session)}>
              Open trace
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function SetupSection({ agent, configRev, onEditSetup, onEditMcp }: { agent: AgentState; configRev: number; onEditSetup: () => void; onEditMcp: () => void }): React.JSX.Element {
  const [model, setModel] = React.useState('')
  const [modelBusy, setModelBusy] = React.useState(false)
  const [modelNote, setModelNote] = React.useState('')
  const [fileBrowser, setFileBrowser] = React.useState<boolean | null>(null)
  const [mcp, setMcp] = React.useState<{ total: number; issues: number } | null>(null)

  const running = !!(agent.running || agent.activity === 'working')
  // MCP + Files are expert setup rows — shown only in Advanced. Provider / Model /
  // Office (and Edit…) stay in Basic.
  const { advanced } = useAdvancedMode()

  // The live model catalog resolves the raw persisted id into the effective model
  // stated in plain words ("Grok 4 · 256k", or "Provider default (Grok 4)") — the
  // value line, so the current model is legible at a glance without decoding an id.
  const { catalog } = useModelCatalog()
  const effective = effectiveModelDisplay(catalog, agent.provider || '', model)

  // The transient note is a right-aligned micro-status, not a replacement for the
  // value line. Success fades after ~2s back to the "saves on select" hint;
  // "restart to apply" is the ONE sticky note (it stays until the live loop is
  // bounced). A timer ref lets a fresh change cancel a pending fade.
  const noteTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flashNote = React.useCallback((msg: string, sticky = false): void => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
    setModelNote(msg)
    if (msg && !sticky) noteTimer.current = setTimeout(() => setModelNote(''), 2000)
  }, [])
  React.useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current) }, [])

  // Inline 1-click model change. This is a deliberate quick-select control: picking
  // a model COMMITS immediately (the row carries a persistent "saves on select"
  // hint so this isn't a surprise), unlike the multi-field Setup modal which batches
  // behind an explicit Save. Since a model only takes effect on (re)start, we surface
  // an honest, sticky "restart to apply" + a Restart button when the loop is live.
  const changeModel = (v: string): void => {
    setModel(v)
    setModelBusy(true); flashNote('')
    void window.api
      .runCli(['config', 'set', modelKeyFor(agent.provider), v, agent.path])
      .then((r: { code?: number; stderr?: string }) => {
        if (r?.code !== 0) flashNote(r?.stderr || 'save failed')
        else if (running) flashNote('restart to apply', true)
        else flashNote('saved')
      })
      .catch(() => flashNote('save failed'))
      .finally(() => setModelBusy(false))
  }
  // Restart via the canonical store action (stop → settle gap → start). A raw
  // stopAgent+startAgent races: stop() is async, so an immediate start() sees the
  // still-live child and no-ops as `alreadyRunning`, never restarting. start() with
  // no `-p` re-reads the provider/model we just persisted.
  const restart = (): void => {
    setModelBusy(true); flashNote('')
    void actions
      .restart(agent.path)
      .then(() => flashNote('restarting — applies now'))
      .catch(() => flashNote('restart failed'))
      .finally(() => setModelBusy(false))
  }

  React.useEffect(() => {
    let live = true
    window.api
      .runCli(['config', 'get', modelKeyFor(agent.provider), agent.path])
      .then((r: { stdout?: string }) => live && setModel((r.stdout || '').trim()))
      .catch(() => {})
    window.api
      .runCli(['config', 'get', 'enableFileBrowser', agent.path])
      .then((r: { stdout?: string }) => live && setFileBrowser((r.stdout || '').trim() === 'true'))
      .catch(() => {})
    window.api
      .agentMcpStatus(agent.path)
      .then((r: { servers?: { status: string }[] }) => {
        if (!live) return
        const servers = r?.servers ?? []
        const issues = servers.filter((s) => s.status === 'unreachable' || s.status === 'missing').length
        setMcp({ total: servers.length, issues })
      })
      .catch(() => live && setMcp(null))
    return () => {
      live = false
    }
    // configRev bumps when the Setup modal closes, so a model/provider/file-browser
    // change made in the modal re-reads here — the inline row can never show a value
    // stale relative to a modal Save on the SAME agent (the `key` remount only
    // covers switching BETWEEN agents).
  }, [agent.path, agent.provider, configRev])

  // Reconcile the Office row with the ONE live session truth (R6) so SETUP can never
  // read "connected" while the detail header shows "office session expired". Mirrors
  // AgentDetail's derivation off the same store (deriveOfficeLinkStatus).
  const officeConn = useOfficeConnection()
  const officeLinked = !!(agent.officeAgentId || agent.officeAgentSlug)
  const officeStatus = deriveOfficeLinkStatus(officeLinked, !!agent.online, officeConn)
  const office: React.ReactNode = officeStatus === 'reconnecting' ? (
    // Non-blocking (R7): the local loop keeps running; this is a dim status, not an
    // alarm. Reconnect only matters for watching/steering with teammates.
    <span style={{ color: 'var(--tx-dim)' }}>reconnecting · local runs</span>
  ) : agent.officeSlug ? (
    officeStatus === 'connected' ? agent.officeSlug : `${agent.officeSlug} · offline`
  ) : agent.wsUrl || agent.officeAgentSlug ? (
    officeStatus === 'connected' ? 'connected' : 'linked · offline'
  ) : (
    '—'
  )

  return (
    <div style={{ padding: '18px 20px' }}>
      <SectionLabel right={<LinkBtn onClick={onEditSetup}>Edit…</LinkBtn>}>Setup</SectionLabel>
      <KeyValueRow k="Provider" v={providerShort(agent.provider)} />
      {/* MODEL — the value line ALWAYS states the effective model in plain words; the
          transient status (saved / restart to apply) sits to its right and never
          replaces it. A 1-click inline change lives in the dropdown below. */}
      <div style={{ padding: '8px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
          <span style={{ flex: 'none', width: 74, fontSize: 'var(--fs-section)', fontWeight: 500, letterSpacing: 'var(--ls-state)', textTransform: 'uppercase', color: 'var(--tx-section)' }}>Model</span>
          {/* value line — the effective model, always legible (never a status word) */}
          <span
            title={effective}
            style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-meta)', color: 'var(--tx-hi)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {effective}
          </span>
          {/* right-aligned micro-status: a real Restart button while running+unapplied,
              else the transient note, else the persistent auto-save hint. Basic shows
              Model as a plain read-only value (no inline editor / hints) — editing is
              one click away via Edit… (Setup modal); Advanced keeps the live status. */}
          {advanced &&
            (running && modelNote === 'restart to apply' ? (
              <span style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--st-needsyou)', whiteSpace: 'nowrap' }}>restart to apply</span>
                <Button size="sm" variant="secondary" onClick={restart} disabled={modelBusy}>Restart</Button>
              </span>
            ) : modelNote ? (
              <span style={{ flex: 'none', fontSize: 'var(--fs-tiny)', color: /fail/i.test(modelNote) ? 'var(--st-error)' : 'var(--tx-dim)', whiteSpace: 'nowrap' }}>
                {modelNote}
              </span>
            ) : (
              // Persistent affordance: make the auto-save explicit BEFORE interaction so
              // committing-on-select isn't a surprise (the Setup modal batches; this
              // inline control saves instantly).
              <span style={{ flex: 'none', fontSize: 'var(--fs-tiny)', color: 'var(--tx-faint)', whiteSpace: 'nowrap' }}>saves on select</span>
            ))}
        </div>
        {/* Inline model dropdown — Advanced only. In Basic the row above is the
            read-only effective value; Edit… (Setup modal) is the change path. */}
        {advanced && <ModelSelect vendor={agent.provider || ''} value={model} onChange={changeModel} compact />}
      </div>
      {/* Office link state is a teammate-collaboration detail — Advanced only. Provider
          + Model stay in Basic (the two setup facts a solo user cares about). */}
      {advanced && <KeyValueRow k="Office" v={office} />}
      {/* MCP + Files — expert rows, Advanced only (edit them via Setup… otherwise). */}
      {advanced && (
        <>
          <KeyValueRow
            k="MCP"
            v={
              mcp === null ? (
                <span style={{ color: 'var(--tx-5)' }}>—</span>
              ) : (
                // Obvious clickable affordance (UX-2): the ONLY way into the MCP
                // editor from here — accent-coloured, hover-underlined, with a
                // chevron + "Edit" hint so it doesn't read as static text.
                <button
                  type="button"
                  onClick={onEditMcp}
                  title="Edit MCP servers"
                  style={{ all: 'unset', cursor: 'pointer', color: 'var(--accent)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                  onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                >
                  {mcp.total} {mcp.total === 1 ? 'server' : 'servers'}
                  <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>Edit</span>
                  <Icon name="chevron" size={11} />
                </button>
              )
            }
            suffix={mcp && mcp.issues > 0 ? <span style={{ color: 'var(--st-error)' }}> · {mcp.issues} issue</span> : undefined}
          />
          <KeyValueRow
            k="Files"
            v={fileBrowser === null ? <span style={{ color: 'var(--tx-5)' }}>—</span> : fileBrowser ? 'browser on' : 'browser off'}
          />
        </>
      )}
    </div>
  )
}

export interface InspectorProps {
  agent: AgentState
  /** the ONE reconciled task truth (shared with the AgentDetail header) */
  todo: AgentTasks
  /** bumps whenever the Setup modal closes, so the inline Setup rows re-read the
   *  persisted config after a modal Save (the value can't go stale on this agent). */
  configRev: number
  onEditSetup: () => void
  onEditMcp: () => void
  /** jump the center pane to the Terminal tab (Watch live) */
  onWatch: () => void
}

export function Inspector({ agent, todo, configRev, onEditSetup, onEditMcp, onWatch }: InspectorProps): React.JSX.Element {
  // The live SESSION card (raw msgs·kb, Watch live, Open trace) is an expert probe —
  // Advanced only. Basic keeps the Inspector to TODO + Setup.
  const { advanced } = useAdvancedMode()
  return (
    <div
      style={{
        width: 'var(--w-inspector)',
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'auto',
        // Lifted chrome (mirror of the left rail): distinct fill, strong seam, and
        // a top inner highlight so it reads as raised over the darker center stage.
        background: 'var(--bg-inspector)',
        borderLeft: '1px solid var(--bd-seam)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.03)'
      }}
    >
      {/* pane cap — titles the column as the Inspector so it can't blur into the
          center stage (consistent with the rail's 'Agents' cap) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 40,
          flex: 'none',
          position: 'sticky',
          top: 0,
          zIndex: 1,
          padding: '0 15px',
          background: 'var(--bg-pane-cap)',
          borderBottom: '1px solid var(--bd-seam)'
        }}
      >
        <span
          style={{
            fontSize: 'var(--fs-panel-title)',
            fontWeight: 'var(--fw-selected)',
            color: 'var(--tx-hi)',
            letterSpacing: 'var(--ls-tight)'
          }}
        >
          Inspector
        </span>
      </div>
      <TodoSection agent={agent} todo={todo} />
      {advanced && <SessionSection agent={agent} onWatch={onWatch} />}
      <SetupSection agent={agent} configRev={configRev} onEditSetup={onEditSetup} onEditMcp={onEditMcp} />
    </div>
  )
}

export default Inspector
