import React from 'react'
import { SegmentedTabs, Button, Pill, StatusDot, Icon, AgentAvatar, ProviderChip } from '@renderer/ui'
import {
  AgentState,
  agentIdHash,
  pillVariantFor,
  stateLabelForAgent,
  isAttention,
  attentionTitle,
  attentionSummary
} from '@renderer/services/model'
import { useOfficeConnection, deriveOfficeLinkStatus } from '@renderer/services/officeService'
import { useAppActions } from '@renderer/services/appActions'
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
            background: 'var(--bg-detail)',
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
  // An attention state gets its demanding label ("INTERRUPTED" / "NEEDS AUTH") in
  // the state colour, never the calm "STOPPED" a retrying/interrupted run used to
  // show — so the header can't read complete while the agent needs you (R4).
  const attn = attentionTitle(agent)
  return (
    <Pill variant={pillVariantFor(agent.activity)} mono selected>
      <StatusDot status={agent.activity} size={6} />
      {attn ?? stateLabelForAgent(agent)}
    </Pill>
  )
}

export interface AgentDetailProps {
  agent: AgentState
  /**
   * workspace paths of every agent currently in the live fleet. Used only to prune
   * the keep-alive terminal hosts: an entry whose agent has left the fleet is dropped
   * so a NEW agent that later reuses the same workspace path gets a fresh terminal
   * host instead of colliding with the departed agent's stale `agent-term:<path>` PTY.
   * When omitted (or empty) NOTHING is pruned — a transient empty poll must never tear
   * down a live PTY.
   */
  livePaths?: string[]
  /**
   * The reconciled "done / total" from useAgentTasks — the SAME value the Inspector
   * TODO.md panel shows, so the two counters can never disagree (R8). Falls back to
   * `agent.tasks` when not provided (standalone use).
   */
  taskCount?: { done: number; total: number }
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
  livePaths,
  taskCount,
  tab,
  onTabChange,
  onStart,
  onStop,
  onRestart,
  onOpenFolder,
  onAddTask,
  onMenu
}: AgentDetailProps): React.JSX.Element {
  const { navigate } = useAppActions()
  const [follow, setFollow] = React.useState(true)
  const [raw, setRaw] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  // A per-agent dismiss for the (non-blocking) office-disconnected notice (R7).
  const [officeNoticeDismissed, setOfficeNoticeDismissed] = React.useState<string | null>(null)

  const count = taskCount ?? { done: agent.tasks.done, total: agent.tasks.total }
  const attnSummary = isAttention(agent) ? attentionSummary(agent) : null

  // Reconcile the office indicator with the ONE live session truth (R4 + R6): the
  // header, Chat, composer and Setup row all derive from deriveOfficeLinkStatus, so
  // they can never contradict (no "office connected" here while Chat says "not
  // connected"). `officeLinked` mirrors ChatTab's ref (officeAgentId||officeAgentSlug).
  const officeConn = useOfficeConnection()
  const officeLinked = !!(agent.officeAgentId || agent.officeAgentSlug)
  const officeStatus = deriveOfficeLinkStatus(officeLinked, !!agent.online, officeConn)

  // AgentDetail is intentionally NOT keyed on agent.path (keying would unmount the
  // terminal host and ptyKill live shells). But that means local composer state
  // persists across a selection change — a half-typed task would otherwise carry
  // over and Enter would send it to the newly-selected agent. Clear it on switch.
  // Also reset the per-agent view toggles: without this, turning Raw log on (or
  // Follow off) for agent A leaks into agent B's Activity when you switch, because
  // AgentDetail is deliberately not re-keyed/remounted on selection change.
  React.useEffect(() => {
    setDraft('')
    setRaw(false)
    setFollow(true)
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
  // Prune keep-alive hosts for agents that have left the live fleet. Without this the
  // set only grows, and if a NEW agent later reuses a departed agent's workspace path
  // the stable `agent-term:<path>` id would resolve to the stale host (and its dead
  // PTY). We ONLY drop paths that are absent from `livePaths` and are not the current
  // agent — a live agent's PTY (selected or not) is always kept. Guarded so a missing
  // or transiently-empty `livePaths` prunes nothing, never tearing down a live PTY.
  React.useEffect(() => {
    if (!livePaths || livePaths.length === 0) return
    const live = new Set(livePaths)
    live.add(agent.path)
    setTermPaths((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const p of prev) {
        if (live.has(p)) next.add(p)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [livePaths, agent.path])
  // Render a host for the current agent (so its Take-over chrome shows) plus every
  // live agent whose PTY must stay alive. Panes are never unmounted on agent-switch or
  // sub-tab-switch — only when their agent leaves the fleet (see the prune effect).
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
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--grad-stage)' }}>
      {/* header — the center pane's titled cap (agent name), on a lifted band with a
          strong seam so the stage announces itself as the primary work surface */}
      <div style={{ padding: '14px 18px 12px', background: 'var(--bg-detail-cap)', borderBottom: '1px solid var(--bd-seam)', overflow: 'hidden' }}>
        {/* min-width:0 lets the name column shrink+ellipsis; flexWrap lets the button
            cluster drop to a second line on a narrow window rather than overflowing and
            propagating a window-wide horizontal scrollbar. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flexWrap: 'wrap' }}>
          {/* identity avatar — same hue + provider ring this agent carries in the
              rail and the Fleet table, so the header is recognizably the same object */}
          <AgentAvatar name={agent.name} idKey={agent.path} provider={agent.provider} size={28} avatarUrl={agent.officeAvatarUrl} avatarColor={agent.officeColor} online={agent.online} title={agent.name} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--fs-agent-name)', fontWeight: 700, color: 'var(--tx-hi)', letterSpacing: 'var(--ls-tight)' }} title={agent.name}>
            {agent.name}
          </span>
          <StatusPill agent={agent} />
          {/* hero metric — the ONE big number for this view: NNNN/NNNN done, mono +
              tabular so the digits don't jitter as counters tick. */}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 6,
              marginLeft: 4
            }}
            title="Tasks done / total"
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-metric)',
                fontWeight: 'var(--fw-display)',
                lineHeight: 1,
                letterSpacing: 'var(--ls-display)',
                color: 'var(--tx-hi)',
                fontFeatureSettings: 'var(--fvn-tabular)'
              }}
            >
              {count.done}<span style={{ color: 'var(--tx-dim)' }}>/{count.total}</span>
            </span>
            <span style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-dim)' }}>done</span>
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* ONE primary CTA per view — Start is the accent-gradient hero; every
                other header action is demoted to ghost so the eye lands on Start. */}
            {agent.running ? (
              <Button size="sm" variant="secondary" onClick={onStop} disabled={agent.external}>
                <Icon name="stop" size={10} /> Stop
              </Button>
            ) : (
              <Button size="sm" variant="cta" onClick={onStart}>
                <Icon name="play" size={10} color="var(--tx-onaccent)" /> Start
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onRestart}>
              <Icon name="restart" size={11} /> Restart
            </Button>
            <Button size="sm" variant="ghost" onClick={onOpenFolder}>
              <Icon name="folder" size={12} /> Open folder
            </Button>
            <Button size="sm" variant="ghost" onClick={(e) => onMenu(e as unknown as React.MouseEvent, agent)} aria-label="More actions">
              <Icon name="more" size={12} />
            </Button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 9 }}>
          <PathChip agent={agent} onOpen={onOpenFolder} />
          <ProviderChip provider={agent.provider} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>
            {agentIdHash(agent.path)}
          </span>
          {officeLinked &&
            (officeStatus === 'reconnecting' ? (
              // Non-blocking (R7): the local loop keeps running while the Pixel Office
              // link is down, so this is a dim, dismissible note — not an orange error.
              // Reconnect only matters for watching/steering with teammates.
              officeNoticeDismissed === agent.path ? null : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <StatusDot status="idle" size={5} />
                  <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>
                    Pixel Office disconnected — local agent still runs
                  </span>
                  <button
                    type="button"
                    onClick={() => navigate('office')}
                    title="Reconnect to watch and steer with teammates"
                    style={{ all: 'unset', cursor: 'pointer', color: 'var(--accent)', fontSize: 'var(--fs-tiny)' }}
                  >
                    Reconnect
                  </button>
                  <button
                    type="button"
                    onClick={() => setOfficeNoticeDismissed(agent.path)}
                    aria-label="Dismiss office notice"
                    title="Dismiss"
                    style={{ all: 'unset', cursor: 'pointer', color: 'var(--tx-ghost)', fontSize: 'var(--fs-tiny)', lineHeight: 1 }}
                  >
                    ✕
                  </button>
                </span>
              )
            ) : officeStatus === 'connected' ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <StatusDot status="running" size={5} />
                <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--st-running)' }}>office connected</span>
              </span>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <StatusDot status="idle" size={5} />
                <span style={{ fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>office linked · offline</span>
              </span>
            ))}
        </div>
      </div>

      {/* Attention banner (R5): when the run failed / needs the operator, say WHAT
          went wrong right in the main pane — with the actions to resolve it — instead
          of leaving the idle "waiting for output" empty state as a dead-end. */}
      {attnSummary && (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            padding: '11px 18px',
            background: 'var(--st-needsyou-wash)',
            borderBottom: '1px solid var(--st-needsyou-bd)'
          }}
        >
          <StatusDot status="needs-you" size={6} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-meta)', color: 'var(--st-needsyou)', fontWeight: 600 }}>
            {attnSummary}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Button size="sm" variant="primary" onClick={onRestart}>
              <Icon name="restart" size={11} color="var(--tx-onaccent)" /> Retry
            </Button>
            {!agent.running && (
              <Button size="sm" onClick={onStart}>
                <Icon name="play" size={10} /> Start
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                onTabChange('activity')
                setRaw(true)
              }}
            >
              View log
            </Button>
          </div>
        </div>
      )}

      {/* sub-tab bar */}
      <div style={{ padding: '0 18px', borderBottom: '1px solid var(--bd-card)' }}>
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
          <ActivityStream
            path={agent.path}
            lastOutput={agent.lastOutput}
            follow={follow}
            raw={raw}
            active={tab === 'activity'}
            running={agent.running}
            tasksDone={agent.tasks.done}
            tasksTotal={agent.tasks.total}
            tasksRemaining={agent.tasks.remaining}
            onStart={onStart}
          />
          {/* Composer — appends "- [ ] text" to TODO.md (a queued task, not a live chat) */}
          <div style={{ padding: '10px 18px', borderTop: '1px solid var(--bd-card)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 12px',
                borderRadius: 'var(--r-card)',
                background: 'var(--bg-input)',
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
          {/* Key per agent so ChatTab remounts fresh on selection change — it holds NO
              PTY, so re-keying is safe (unlike TerminalTab). This guarantees stale
              resolvedId/msgs/error can never leak a steer to the previously-selected agent. */}
          <ChatTab key={agent.path} agentPath={agent.path} />
        </div>
        <div style={{ display: tab === 'terminal' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          {termHostPaths.map((p) => (
            <div
              key={p}
              style={{ display: p === agent.path ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}
            >
              <TerminalTab agentPath={p} onTakenOver={() => markTakenOver(p)} onStart={onStart} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default AgentDetail
