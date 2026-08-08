import React from 'react'
import { StatusDot, DotStatus, PillVariant, Icon } from '@renderer/ui'

/**
 * AgentRow — one row of the Agents rail (2a) plus the shared fleet model + the
 * derived-state helpers used across the whole Agent-detail screen. The row only
 * carries what DIFFERS between agents: a check, a state dot, the name, ONE dim
 * mono meta line (or a coloured state line), and the single number that matters
 * (tasks left). Office / provider repetition lives on the group header.
 *
 * The `AgentState` shape mirrors AgentManager.readState (see CURRENT-APP.md §2);
 * it is re-exported here so every Agent component shares one type.
 */

export type Activity =
  | 'working'
  | 'idle'
  | 'stopped'
  | 'stalled'
  | 'needs-auth'
  | 'rate-limited'
  | 'crashed'

export interface AgentState {
  path: string
  name: string
  provider?: string
  sessionName?: string
  wsUrl?: string
  running: boolean
  external?: boolean
  online?: boolean
  activity: Activity
  tasks: { total: number; remaining: number; done: number }
  currentTask?: string
  lastOutput?: string
  error?: string
  exitCode?: number | null
  officeAgentSlug?: string
  officeSlug?: string
  officeAgentId?: string
}

export const ACTIVITY_LABEL: Record<Activity, string> = {
  working: 'Working',
  idle: 'Idle',
  stopped: 'Stopped',
  stalled: 'Stalled',
  'needs-auth': 'Needs re-auth',
  'rate-limited': 'Rate-limited',
  crashed: 'Crashed'
}

export const ATTENTION_STATES = new Set<Activity>(['stalled', 'needs-auth', 'rate-limited', 'crashed'])

/** WORKING/IDLE/… pill variant reserved strictly for state. */
export function pillVariantFor(a: Activity): PillVariant {
  if (a === 'working') return 'green'
  if (a === 'crashed') return 'red'
  if (ATTENTION_STATES.has(a)) return 'amber'
  return 'neutral'
}

/** State-badge label (mono, uppercase) for a StatusPill. */
export function stateLabel(a: Activity): string {
  switch (a) {
    case 'working':
      return 'WORKING'
    case 'idle':
      return 'IDLE'
    case 'stopped':
      return 'STOPPED'
    case 'stalled':
      return 'STALLED'
    case 'needs-auth':
      return 'NEEDS AUTH'
    case 'rate-limited':
      return 'RATE LIMIT'
    case 'crashed':
      return 'TIMED OUT'
  }
}

export function providerShort(p?: string): string {
  return (p || '').split('-')[0] || 'local'
}

/** The trailing hash of a workspace basename, e.g. balance-analyst-d271e → d271e. */
export function agentIdHash(path: string): string {
  const base = path.replace(/\/+$/, '').split('/').filter(Boolean).pop() || ''
  const m = base.match(/-([0-9a-z]{4,12})$/i)
  return m ? m[1] : base
}

/** Last-two path segments — the compact rail/header label. */
export function shortPath(p?: string): string {
  if (!p) return ''
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts.slice(-2).join('/') || p
}

export type MetaTone = 'default' | 'amber' | 'red' | 'idle'

const META_COLOR: Record<MetaTone, string> = {
  default: 'var(--tx-ghost)',
  amber: 'var(--st-needsyou)',
  red: 'var(--st-error)',
  idle: 'var(--tx-dim)'
}

/**
 * The meta / state line under the name. Default rows show the dim mono
 * "provider · id"; attention rows replace it with a coloured human state line.
 */
export function rowMeta(a: AgentState): { text: string; tone: MetaTone; mono: boolean } {
  if (a.activity === 'needs-auth') return { text: 'waiting on you', tone: 'amber', mono: false }
  if (a.activity === 'rate-limited') return { text: a.error || 'rate-limited', tone: 'amber', mono: false }
  if (a.activity === 'stalled') return { text: a.error || 'stalled · no output', tone: 'amber', mono: false }
  if (a.activity === 'crashed') {
    const retry = a.tasks.total > 0 ? ' · retry 2/2' : ''
    return { text: (a.error || 'timed out') + retry, tone: 'red', mono: false }
  }
  if (a.activity === 'idle' && a.tasks.remaining === 0) return { text: 'idle · all done', tone: 'idle', mono: false }
  return { text: `${providerShort(a.provider)} · ${agentIdHash(a.path)}`, tone: 'default', mono: true }
}

/** Whether a row's name should be dimmed (idle / stopped, no live work). */
export function isDim(a: AgentState): boolean {
  return (a.activity === 'idle' || a.activity === 'stopped') && !a.running
}

/* ---------------------------------------------------------------- Checkbox -- */

export interface CheckboxProps {
  checked: boolean
  /** partial (some-of-group) state renders the filled dash look */
  indeterminate?: boolean
  onChange: () => void
  size?: number
  label?: string
}

export function Checkbox({ checked, indeterminate, onChange, size = 13, label }: CheckboxProps): React.JSX.Element {
  const on = checked || indeterminate
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onChange()
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        width: size,
        height: size,
        padding: 0,
        borderRadius: 'var(--r-checkbox)',
        background: on ? 'var(--accent)' : 'transparent',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--bd-idle-box)'}`,
        color: 'var(--tx-onaccent)',
        cursor: 'pointer'
      }}
    >
      {checked && <Icon name="check" size={size - 4} strokeWidth={2} />}
      {!checked && indeterminate && (
        <span style={{ width: size - 6, height: 2, background: 'var(--tx-onaccent)', borderRadius: 1 }} />
      )}
    </button>
  )
}

/* --------------------------------------------------------------- AgentRow -- */

export interface AgentRowProps {
  agent: AgentState
  selected: boolean
  checked: boolean
  onSelect: () => void
  onToggleCheck: () => void
  /** open the context menu at the cursor (right-click OR inline ···) */
  onMenu: (e: React.MouseEvent, agent: AgentState) => void
}

export function AgentRow({ agent, selected, checked, onSelect, onToggleCheck, onMenu }: AgentRowProps): React.JSX.Element {
  const meta = rowMeta(agent)
  const dim = isDim(agent)
  const dot: DotStatus = agent.activity
  const showCount = !(agent.activity === 'idle' && agent.tasks.remaining === 0)
  const glow = selected && agent.running

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onContextMenu={(e) => onMenu(e, agent)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 8px',
        borderRadius: 'var(--r-button)',
        background: selected ? 'var(--bg-selected)' : 'transparent',
        boxShadow: selected ? 'inset 2px 0 0 var(--accent)' : undefined,
        cursor: 'pointer'
      }}
    >
      <Checkbox checked={checked} onChange={onToggleCheck} label={`Select ${agent.name}`} />
      <StatusDot status={dot} glow={glow} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-body)',
            fontWeight: selected ? 600 : 400,
            color: dim ? 'var(--tx-3)' : selected ? 'var(--tx-hi)' : 'var(--tx-1)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
          title={agent.path}
        >
          {agent.name}
        </div>
        <div
          style={{
            marginTop: 1,
            fontFamily: meta.mono ? 'var(--font-mono)' : 'var(--font-sans)',
            fontSize: 'var(--fs-tiny)',
            color: META_COLOR[meta.tone],
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {meta.text}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
        {showCount && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-tiny)',
              fontWeight: selected ? 600 : 500,
              color: selected ? 'var(--accent)' : 'var(--tx-dim)'
            }}
          >
            {agent.tasks.remaining}
          </span>
        )}
        {selected && (
          <button
            type="button"
            aria-label={`Actions for ${agent.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onMenu(e, agent)
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              borderRadius: 'var(--r-tiny)',
              background: 'var(--bg-input)',
              border: '1px solid var(--bd-track)',
              color: 'var(--tx-3)',
              cursor: 'pointer'
            }}
          >
            <Icon name="more" size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

export default AgentRow
