import React from 'react'
import { StatusDot, DotStatus, Icon } from '@renderer/ui'
import { rowMeta, isDim } from '@renderer/services/model'
import type { AgentState, MetaTone } from '@renderer/services/model'

/**
 * AgentRow — one row of the Agents rail (2a). The row only carries what DIFFERS
 * between agents: a check, a state dot, the name, ONE dim mono meta line (or a
 * coloured state line), and the single number that matters (tasks left). Office
 * / provider repetition lives on the group header.
 *
 * The shared fleet model + derived-state helpers now live in
 * `@renderer/services/model` (the single source of truth). They are re-exported
 * here so every existing `import { … } from '.../AgentRow'` keeps resolving.
 */

export type { Activity, AgentState, MetaTone } from '@renderer/services/model'
export {
  ACTIVITY_LABEL,
  ATTENTION_STATES,
  pillVariantFor,
  stateLabel,
  providerShort,
  agentIdHash,
  shortPath,
  rowMeta,
  isDim
} from '@renderer/services/model'

const META_COLOR: Record<MetaTone, string> = {
  default: 'var(--tx-ghost)',
  amber: 'var(--st-needsyou)',
  red: 'var(--st-error)',
  idle: 'var(--tx-dim)'
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
        {meta.text && (
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
        )}
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
