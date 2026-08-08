import React from 'react'
import { Button, StatusDot, Pill } from '@renderer/ui'
import { AgentState, providerShort } from './AgentRow'

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
  grok: 'grokModel'
}
function modelKeyFor(provider?: string): string {
  return MODEL_KEY[(provider || '').split('-')[0]] ?? 'claudeModel'
}

interface TodoItem {
  state: 'done' | 'active' | 'pending'
  text: string
}

function parseTodo(raw: string): TodoItem[] {
  const out: TodoItem[] = []
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:[-*]\s*)?\[([ xX~])\]\s+(.*\S)\s*$/)
    if (!m) continue
    const flag = m[1].toLowerCase()
    out.push({ state: flag === 'x' ? 'done' : flag === '~' ? 'active' : 'pending', text: m[2] })
  }
  return out
}

interface SessionMeta {
  id: string
  provider: string
  file: string
  cwd: string
  title: string
  mtime: number
  sizeKb: number
  msgs: number
  live: boolean
}

/* --------------------------------------------------------------- primitives */

function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <span
        style={{
          fontSize: 'var(--fs-section)',
          fontWeight: 700,
          letterSpacing: 'var(--ls-section)',
          color: 'var(--tx-4)',
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
  return (
    <div style={{ display: 'flex', gap: 10, padding: '5px 0', fontSize: 'var(--fs-meta)' }}>
      <span style={{ flex: 'none', width: 74, color: 'var(--tx-dim)' }}>{k}</span>
      <span style={{ flex: 1, minWidth: 0, color: 'var(--tx-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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

function TodoSection({ agent }: { agent: AgentState }): React.JSX.Element {
  const [items, setItems] = React.useState<TodoItem[] | null>(null)
  // Optimistic local check overlay: there is no API to toggle a single TODO item
  // (sendAgentMessage only APPENDS). Clicks toggle the visual only.
  // TODO(redesign): expose a per-item TODO toggle in the CLI to persist this.
  const [localDone, setLocalDone] = React.useState<Set<number>>(new Set())

  React.useEffect(() => {
    setItems(null)
    setLocalDone(new Set())
    let live = true
    window.api
      .runCli(['status', agent.path, '--all'])
      .then((r: { stdout?: string; stderr?: string }) => {
        if (!live) return
        setItems(parseTodo((r.stdout || r.stderr || '').replace(/\x1b\[[0-9;]*m/g, '')))
      })
      .catch(() => live && setItems([]))
    return () => {
      live = false
    }
  }, [agent.path])

  const list = items ?? []
  const done = agent.tasks.done
  const total = agent.tasks.total || list.length
  const ratio = total > 0 ? done / total : 0

  return (
    <div style={{ padding: '13px 15px 11px', borderBottom: '1px solid var(--bd-2)' }}>
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
      <ProgressBar ratio={ratio} />
      <div style={{ marginTop: 10 }}>
        {items === null && <div style={{ color: 'var(--tx-5)', fontSize: 'var(--fs-meta)' }}>Loading…</div>}
        {items !== null && list.length === 0 && (
          <div style={{ color: 'var(--tx-5)', fontSize: 'var(--fs-meta)' }}>No tasks in TODO.md.</div>
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
    <div style={{ padding: '13px 15px', borderBottom: '1px solid var(--bd-2)' }}>
      <SectionLabel right={<LinkBtn>All sessions</LinkBtn>}>Session</SectionLabel>
      {session === undefined && <div style={{ color: 'var(--tx-5)', fontSize: 'var(--fs-meta)' }}>Loading…</div>}
      {session === null && (
        <div style={{ color: 'var(--tx-5)', fontSize: 'var(--fs-meta)' }}>No session discovered for this workspace yet.</div>
      )}
      {session && (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--bd-card)', borderRadius: 'var(--r-card)', padding: '10px 12px' }}>
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
            <Button size="sm" block onClick={() => window.api.openPath(session.file)}>
              Open trace
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function SetupSection({ agent, onEditSetup, onEditMcp }: { agent: AgentState; onEditSetup: () => void; onEditMcp: () => void }): React.JSX.Element {
  const [model, setModel] = React.useState('')
  const [fileBrowser, setFileBrowser] = React.useState<boolean | null>(null)
  const [mcp, setMcp] = React.useState<{ total: number; issues: number } | null>(null)

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
  }, [agent.path, agent.provider])

  const office = agent.officeSlug || (agent.wsUrl || agent.officeAgentSlug ? 'connected' : '—')

  return (
    <div style={{ padding: '13px 15px' }}>
      <SectionLabel right={<LinkBtn onClick={onEditSetup}>Edit…</LinkBtn>}>Setup</SectionLabel>
      <KeyValueRow k="Provider" v={providerShort(agent.provider)} />
      <KeyValueRow k="Model" v={model || <span style={{ color: 'var(--tx-5)' }}>provider default</span>} />
      <KeyValueRow k="Office" v={office} />
      <KeyValueRow
        k="MCP"
        v={
          mcp === null ? (
            <span style={{ color: 'var(--tx-5)' }}>—</span>
          ) : (
            <>
              <button type="button" onClick={onEditMcp} style={{ all: 'unset', cursor: 'pointer', color: 'var(--tx-1)' }}>
                {mcp.total} {mcp.total === 1 ? 'server' : 'servers'}
              </button>
            </>
          )
        }
        suffix={mcp && mcp.issues > 0 ? <span style={{ color: 'var(--st-error)' }}> · {mcp.issues} issue</span> : undefined}
      />
      <KeyValueRow
        k="Files"
        v={fileBrowser === null ? <span style={{ color: 'var(--tx-5)' }}>—</span> : fileBrowser ? 'browser on' : 'browser off'}
      />
    </div>
  )
}

export interface InspectorProps {
  agent: AgentState
  onEditSetup: () => void
  onEditMcp: () => void
  /** jump the center pane to the Terminal tab (Watch live) */
  onWatch: () => void
}

export function Inspector({ agent, onEditSetup, onEditMcp, onWatch }: InspectorProps): React.JSX.Element {
  return (
    <div
      style={{
        width: 'var(--w-inspector)',
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'auto',
        background: 'var(--bg-1)',
        borderLeft: '1px solid var(--bd-nav)'
      }}
    >
      <TodoSection agent={agent} />
      <SessionSection agent={agent} onWatch={onWatch} />
      <SetupSection agent={agent} onEditSetup={onEditSetup} onEditMcp={onEditMcp} />
    </div>
  )
}

export default Inspector
