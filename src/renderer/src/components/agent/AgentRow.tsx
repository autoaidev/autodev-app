import React from 'react'
import { StatusDot, DotStatus, Icon, AgentAvatar } from '@renderer/ui'
import { rowMeta, isDim, agentHeadline, ATTENTION_STATES } from '@renderer/services/model'
import { providerAccent } from '@renderer/services/identity'
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
  const running = agent.running || agent.activity === 'working'
  const attention = ATTENTION_STATES.has(agent.activity)
  const glow = (selected && agent.running) || attention

  // Colored row spine (STATE first, then a receding PROVIDER hue so an idle row is
  // never fully grey): running → green, needs-you → amber, else the provider's
  // faint ring hue. Identity + provider also live in the avatar tile, so state and
  // identity never fight for the same pixel.
  const spine = running
    ? 'var(--st-running-spine)'
    : attention
      ? 'var(--st-needsyou)'
      : providerAccent(agent.provider).ring
  // Selection = brighter background + a hairline inset ring; the spine stays state/
  // provider-colored so selecting a row never erases its identity.
  const bg = selected
    ? 'var(--bg-selected)'
    : attention
      ? 'var(--st-needsyou-wash)'
      : 'transparent'
  const boxShadow =
    `inset var(--spine-w) 0 0 ${spine}` + (selected ? ', inset 0 0 0 1px var(--bd-panel-sel)' : '')

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
        padding: '6px 8px 6px 10px',
        borderRadius: 'var(--r-button)',
        background: bg,
        boxShadow,
        cursor: 'pointer'
      }}
    >
      <Checkbox checked={checked} onChange={onToggleCheck} label={`Select ${agent.name}`} />
      {/* identity tile — stable hue + initials (IDENTITY) with a provider-accent
          ring (which tool); state is carried by the spine + the dot on the right. */}
      <AgentAvatar
        name={agentHeadline(agent)}
        idKey={agent.path}
        provider={agent.provider}
        size={22}
        dim={dim}
        title={agent.name}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-body)',
            // name is the bold scan anchor of the row (meta below is demoted)
            fontWeight: 'var(--fw-selected)',
            color: dim ? 'var(--tx-3)' : selected ? 'var(--tx-hi)' : 'var(--tx-1)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
          title={agent.path}
        >
          {agentHeadline(agent)}
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
        {/* state dot — the one place STATE color lives on the right; needs-you /
            running glow so attention rows shout while identity stays in the tile. */}
        <StatusDot status={dot} glow={glow} />
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
