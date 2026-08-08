import React from 'react'
import { SegmentedTabs, Button, Pill, StatusDot, Icon } from '@renderer/ui'
import { AgentState, providerShort, agentIdHash, pillVariantFor, stateLabel } from './AgentRow'
import { ActivityStream } from './ActivityStream'
import { ChatTab } from './ChatTab'
import { TerminalTab } from './TerminalTab'

/**
 * AgentDetail — the center column of the Agent-detail screen (2a). One surface
 * for live work: a header (name + state pill + path chip + Stop/Restart/Open), a
 * sub-tab bar (Activity | Chat | Terminal) with a Follow toggle + Raw-log link,
 * and — on the Activity tab — the parsed ActivityStream plus a Composer that
 * appends a task to the agent's TODO.md.
 *
 * Chat and Terminal are rendered by sibling components (2f) via the shared
 * interface contract; they stay mounted (display toggle) so a live PTY inside
 * TerminalTab is never SIGKILLed by an unmount when switching tabs.
 */

export type DetailTab = 'activity' | 'chat' | 'terminal'

function FollowToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
    >
      <span style={{ fontSize: 'var(--fs-desc)', color: on ? 'var(--tx-2)' : 'var(--tx-4)' }}>Follow</span>
      <span
        style={{
          position: 'relative',
          width: 26,
          height: 15,
          borderRadius: 'var(--r-pill)',
          background: on ? 'var(--accent)' : 'var(--bg-input)',
          border: `1px solid ${on ? 'var(--accent)' : 'var(--bd-1)'}`,
          transition: 'background .12s ease'
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: on ? 12 : 1,
            width: 11,
            height: 11,
            borderRadius: '50%',
            background: 'var(--bg-0)',
            transition: 'left .12s ease'
          }}
        />
      </span>
    </button>
  )
}

function PathChip({ agent, onOpen }: { agent: AgentState; onOpen: () => void }): React.JSX.Element {
  const parts = agent.path.replace(/\/+$/, '').split('/').filter(Boolean)
  const base = parts[parts.length - 1] || agent.path
  const dir = parts.slice(0, -1).join('/')
  return (
    <button
      type="button"
      onClick={onOpen}
      title={agent.path}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: 392,
        padding: '3px 8px',
        borderRadius: 'var(--r-chip)',
        background: 'var(--bg-input)',
        border: '1px solid var(--bd-1)',
        cursor: 'pointer'
      }}
    >
      <Icon name="folder" size={12} color="var(--tx-dim)" />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)', direction: 'rtl', textAlign: 'left' }}>
        {dir}/
      </span>
      <span style={{ flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-1)' }}>{base}</span>
      <Icon name="external" size={11} color="var(--accent)" />
    </button>
  )
}

function StatusPill({ agent }: { agent: AgentState }): React.JSX.Element {
  return (
    <Pill variant={pillVariantFor(agent.activity)} mono selected>
      <StatusDot status={agent.activity} size={6} />
      {stateLabel(agent.activity)}
    </Pill>
  )
}

export interface AgentDetailProps {
  agent: AgentState
  getLog: () => string
  subscribeLog: (cb: () => void) => () => void
  tab: DetailTab
  onTabChange: (t: DetailTab) => void
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onOpenFolder: () => void
  onAddTask: (text: string) => void
  onMenu: (e: React.MouseEvent, agent: AgentState) => void
}

export function AgentDetail({
  agent,
  getLog,
  subscribeLog,
  tab,
  onTabChange,
  onStart,
  onStop,
  onRestart,
  onOpenFolder,
  onAddTask,
  onMenu
}: AgentDetailProps): React.JSX.Element {
  const [follow, setFollow] = React.useState(true)
  const [raw, setRaw] = React.useState(false)
  const [draft, setDraft] = React.useState('')

  // AgentDetail is intentionally NOT keyed on agent.path (keying would unmount the
  // terminal host and ptyKill live shells). But that means local composer state
  // persists across a selection change — a half-typed task would otherwise carry
  // over and Enter would send it to the newly-selected agent. Clear it on switch.
  React.useEffect(() => {
    setDraft('')
  }, [agent.path])

  // Keep-alive terminal host. A mounted <TerminalPane> === a live PTY, and its
  // [id] cleanup runs ptyKill on unmount. Switching agents must NOT kill a shell
  // the user took over, so every path whose terminal was taken over keeps a
  // mounted, stable-id TerminalTab; we only toggle display. Keying each host by
  // path also isolates TerminalTab's `takenOver` per agent, so selecting a fresh
  // agent never auto-spawns a shell it never asked for.
  const [termPaths, setTermPaths] = React.useState<Set<string>>(new Set())
  const markTakenOver = React.useCallback((p: string) => {
    setTermPaths((prev) => (prev.has(p) ? prev : new Set(prev).add(p)))
  }, [])
  // Render a host for the current agent (so its Take-over chrome shows) plus every
  // agent whose PTY must stay alive. This set only grows — panes are never unmounted
  // on agent-switch or sub-tab-switch.
  const termHostPaths = React.useMemo(() => {
    const s = new Set(termPaths)
    s.add(agent.path)
    return Array.from(s)
  }, [termPaths, agent.path])

  const submit = (): void => {
    const t = draft.trim()
    if (!t) return
    onAddTask(t)
    setDraft('')
  }

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-0)' }}>
      {/* header */}
      <div style={{ padding: '14px 18px 12px', borderBottom: '1px solid var(--bd-2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--fs-agent-name)', fontWeight: 700, color: 'var(--tx-hi)', letterSpacing: 'var(--ls-tight)' }} title={agent.name}>
            {agent.name}
          </span>
          <StatusPill agent={agent} />
          {/* TODO(redesign): AgentState has no task-elapsed timestamp — showing task progress instead of "14m in task". */}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>
            {agent.tasks.done}/{agent.tasks.total} done
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            {agent.running ? (
              <Button size="sm" onClick={onStop} disabled={agent.external}>
                <Icon name="stop" size={10} /> Stop
              </Button>
            ) : (
              <Button size="sm" onClick={onStart}>
                <Icon name="play" size={10} /> Start
              </Button>
            )}
            <Button size="sm" onClick={onRestart}>
              <Icon name="restart" size={11} /> Restart
            </Button>
            <Button size="sm" onClick={onOpenFolder}>
              <Icon name="folder" size={12} /> Open folder
            </Button>
            <Button size="sm" onClick={(e) => onMenu(e as unknown as React.MouseEvent, agent)} aria-label="More actions">
              <Icon name="more" size={12} />
            </Button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 9 }}>
          <PathChip agent={agent} onOpen={onOpenFolder} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>
            {providerShort(agent.provider)} · {agentIdHash(agent.path)}
          </span>
          {(agent.online || agent.wsUrl) && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <StatusDot status="running" size={5} />
              <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--st-running)' }}>office connected</span>
            </span>
          )}
        </div>
      </div>

      {/* sub-tab bar */}
      <div style={{ padding: '0 18px', borderBottom: '1px solid var(--bd-2)' }}>
        <SegmentedTabs
          tabs={[
            { id: 'activity', label: 'Activity' },
            { id: 'chat', label: 'Chat' },
            { id: 'terminal', label: 'Terminal' }
          ]}
          value={tab}
          onChange={(id) => onTabChange(id as DetailTab)}
          right={
            tab === 'activity' ? (
              <>
                <FollowToggle on={follow} onChange={setFollow} />
                <button
                  type="button"
                  onClick={() => setRaw((r) => !r)}
                  aria-pressed={raw}
                  style={{ all: 'unset', cursor: 'pointer', color: raw ? 'var(--accent)' : 'var(--tx-4)', fontSize: 'var(--fs-desc)' }}
                >
                  {raw ? 'Parsed' : 'Raw log'}
                </button>
              </>
            ) : undefined
          }
        />
      </div>

      {/* body — keep Chat/Terminal mounted (display toggle) so their PTYs survive tab switches */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: tab === 'activity' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <ActivityStream getText={getLog} subscribe={subscribeLog} follow={follow} raw={raw} />
          {/* Composer — appends "- [ ] text" to TODO.md (a queued task, not a live chat) */}
          <div style={{ padding: '10px 18px', borderTop: '1px solid var(--bd-2)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 12px',
                borderRadius: 'var(--r-card)',
                background: 'var(--bg-panel)',
                border: '1px solid var(--bd-1)'
              }}
            >
              <Icon name="plus" size={12} color="var(--tx-dim)" />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submit()
                  }
                }}
                placeholder="Add a task to this agent's TODO.md — or type / for commands"
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
              <span style={{ flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-ghost)' }}>
                ⏎ add · ⇧⏎ newline
              </span>
            </div>
          </div>
        </div>

        <div style={{ display: tab === 'chat' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <ChatTab agentPath={agent.path} />
        </div>
        <div style={{ display: tab === 'terminal' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          {termHostPaths.map((p) => (
            <div
              key={p}
              style={{ display: p === agent.path ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}
            >
              <TerminalTab agentPath={p} onTakenOver={() => markTakenOver(p)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default AgentDetail
