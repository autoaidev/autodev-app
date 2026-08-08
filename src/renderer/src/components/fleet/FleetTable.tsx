import React from 'react'
import { Icon, StatusDot } from '@renderer/ui'
import {
  AgentState,
  STATE_LABEL,
  agentHeadline,
  agentSlugId,
  anyRunning,
  dotStatus,
  fleetOffice,
  isAttention,
  stripTaskHash,
  tasksFraction,
  tasksLabel,
  washTone
} from './fleet-helpers'

/**
 * Grid template shared by the header row and every data row. The ELAPSED column
 * is dropped entirely when nothing is running (it would be all "—"), so the
 * template is derived from `showElapsed`.
 */
function gridFor(showElapsed: boolean): string {
  return showElapsed
    ? '14px 190px 130px 110px minmax(0,1fr) 88px 78px 60px'
    : '14px 190px 130px 110px minmax(0,1fr) 88px 60px'
}
const COL_GAP = 14
const ROW_PAD = '10px 12px'

/** A row's trailing action: a "···" more-menu, or a coloured verb link. */
export interface RowAction {
  kind: 'more' | 'verb'
  label: string
  onClick: (e: React.MouseEvent) => void
}

/* ---------------------------------- atoms --------------------------------- */

function Checkbox({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: () => void
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onChange()
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 'var(--sz-checkbox)',
        height: 'var(--sz-checkbox)',
        padding: 0,
        borderRadius: 'var(--r-checkbox)',
        background: checked ? 'var(--accent)' : 'transparent',
        border: `1px solid ${checked ? 'var(--accent)' : 'var(--bd-idle-box)'}`,
        cursor: 'pointer',
        flex: 'none'
      }}
    >
      {checked && <Icon name="check" size={9} color="var(--tx-onaccent)" strokeWidth={2} />}
    </button>
  )
}

/** Inline STATE badge — dot + mono uppercase label, no pill background. */
function StateBadge({ a }: { a: AgentState }): React.JSX.Element {
  const attn = isAttention(a)
  const tone = washTone(a)
  const color =
    tone === 'red'
      ? 'var(--st-error)'
      : tone === 'amber'
        ? 'var(--st-needsyou)'
        : 'var(--tx-3)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
      <StatusDot status={dotStatus(a)} />
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-tiny)',
          fontWeight: 500,
          letterSpacing: 'var(--ls-state)',
          color: attn ? color : 'var(--tx-2)',
          whiteSpace: 'nowrap'
        }}
      >
        {STATE_LABEL[a.activity]}
      </span>
    </span>
  )
}

/**
 * 34px mini progress + "n/m" mono. The fill is proportional to done/total and
 * status-coloured, so a fully-done idle agent (252/252, accent) reads distinctly
 * from an empty one (0/0, bare track) instead of both rendering identical grey.
 */
function TasksCell({ a }: { a: AgentState }): React.JSX.Element {
  const total = a.tasks.total
  const frac = tasksFraction(a.tasks)
  const running = a.running || a.activity === 'working'
  const tone = washTone(a)
  const complete = total > 0 && a.tasks.done >= total
  const fill =
    tone === 'red'
      ? 'var(--st-error)'
      : tone === 'amber'
        ? 'var(--st-needsyou)'
        : running
          ? 'var(--st-running)'
          : complete
            ? 'var(--accent)' // all done, idle — distinct from running green (R7)
            : 'var(--st-track)' // partial idle progress
  // Proportional fill; an empty TODO (no tasks) leaves the bare track visible.
  const width = total === 0 ? '0%' : `${Math.round(frac * 100)}%`
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          position: 'relative',
          width: 34,
          height: 4,
          borderRadius: 'var(--r-bar)',
          background: 'var(--st-track-bg)',
          overflow: 'hidden',
          flex: 'none'
        }}
        aria-hidden
      >
        <span
          style={{
            position: 'absolute',
            inset: 0,
            width,
            borderRadius: 'var(--r-bar)',
            background: fill
          }}
        />
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-tiny)',
          fontWeight: 500,
          color: total === 0 ? 'var(--tx-ghost)' : complete ? 'var(--accent-ink)' : 'var(--tx-3)'
        }}
      >
        {tasksLabel(a.tasks)}
      </span>
    </span>
  )
}

/* ---------------------------------- header -------------------------------- */

function headCols(showElapsed: boolean): string[] {
  const base = ['', 'AGENT', 'OFFICE', 'STATE', 'CURRENT TASK', 'TASKS']
  return showElapsed ? [...base, 'ELAPSED', ''] : [...base, '']
}

function HeaderRow({ showElapsed }: { showElapsed: boolean }): React.JSX.Element {
  return (
    <div
      role="row"
      style={{
        display: 'grid',
        gridTemplateColumns: gridFor(showElapsed),
        columnGap: COL_GAP,
        alignItems: 'center',
        padding: '9px 12px',
        borderBottom: '1px solid var(--bd-row)'
      }}
    >
      {headCols(showElapsed).map((h, i) => (
        <span
          key={i}
          role="columnheader"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-tiny)',
            fontWeight: 500,
            letterSpacing: '.1em',
            color: 'var(--tx-dim)',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
            overflow: 'hidden'
          }}
        >
          {h}
        </span>
      ))}
    </div>
  )
}

/* ----------------------------------- row ---------------------------------- */

export interface FleetRowProps {
  agent: AgentState
  selected: boolean
  showElapsed: boolean
  elapsed: string
  elapsedColor: string
  action: RowAction
  onToggleSelect: () => void
  onOpen: () => void
}

function FleetRow({
  agent,
  selected,
  showElapsed,
  elapsed,
  elapsedColor,
  action,
  onToggleSelect,
  onOpen
}: FleetRowProps): React.JSX.Element {
  const tone = washTone(agent)
  const office = fleetOffice(agent)
  const cls = [
    'fleet-row',
    selected ? 'is-selected' : '',
    tone === 'amber' ? 'wash-amber' : tone === 'red' ? 'wash-red' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const nameColor =
    agent.running || agent.activity === 'working' || isAttention(agent)
      ? 'var(--tx-hi)'
      : 'var(--tx-3)'

  return (
    <div
      role="row"
      className={cls}
      onClick={onOpen}
      style={{
        display: 'grid',
        gridTemplateColumns: gridFor(showElapsed),
        columnGap: COL_GAP,
        alignItems: 'center',
        padding: ROW_PAD,
        borderBottom: '1px solid var(--bd-row)',
        cursor: 'pointer'
      }}
    >
      <Checkbox checked={selected} onChange={onToggleSelect} label={`Select ${agent.name}`} />

      {/* AGENT: canonical human headline (agentHeadline) + dim mono slug-hash meta,
          applied identically here and in the Agents rail so the list never mixes
          human names with slug-hash folder ids. */}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-body)',
            fontWeight: 600,
            color: nameColor,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
          title={agent.name}
        >
          {agentHeadline(agent)}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-micro)',
            color: 'var(--tx-ghost)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {agent.provider ? `${agent.provider} · ${agentSlugId(agent)}` : agentSlugId(agent)}
        </div>
      </div>

      {/* OFFICE — same subfolder/slug derivation as the Agents rail; only "—"
          when there is genuinely no office/folder to show. */}
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--fs-meta)',
          color: office ? 'var(--tx-3)' : 'var(--tx-ghost)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
        title={office || undefined}
      >
        {office || '—'}
      </span>

      {/* STATE */}
      <StateBadge a={agent} />

      {/* CURRENT TASK (ellipsis) */}
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--fs-meta)',
          color: agent.currentTask ? 'var(--tx-2)' : 'var(--tx-ghost)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0
        }}
        title={agent.currentTask ? stripTaskHash(agent.currentTask) : undefined}
      >
        {agent.currentTask
          ? stripTaskHash(agent.currentTask)
          : agent.tasks.total === 0
            ? 'TODO empty'
            : 'no active task'}
      </span>

      {/* TASKS */}
      <TasksCell a={agent} />

      {/* ELAPSED — only rendered while something is running (else all "—") */}
      {showElapsed && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-tiny)',
            fontWeight: 500,
            color: elapsedColor,
            whiteSpace: 'nowrap'
          }}
        >
          {elapsed}
        </span>
      )}

      {/* ACTION */}
      <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {action.kind === 'more' ? (
          <button
            type="button"
            className="fleet-morebtn"
            aria-label={`Actions for ${agent.name}`}
            title={action.label}
            onClick={(e) => {
              e.stopPropagation()
              action.onClick(e)
            }}
          >
            <Icon name="more" size={12} />
          </button>
        ) : (
          <button
            type="button"
            className="fleet-linkbtn fleet-verbbtn"
            style={{
              fontSize: 'var(--fs-desc)',
              padding: '3px 6px',
              borderRadius: 'var(--r-tiny)'
            }}
            onClick={(e) => {
              e.stopPropagation()
              action.onClick(e)
            }}
          >
            {action.label}
          </button>
        )}
      </span>
    </div>
  )
}

/* ---------------------------------- table --------------------------------- */

export interface FleetTableProps {
  agents: AgentState[]
  selected: Set<string>
  elapsedFor: (a: AgentState) => { text: string; color: string }
  actionFor: (a: AgentState) => RowAction
  onToggleSelect: (path: string) => void
  onOpen: (path: string) => void
}

export function FleetTable({
  agents,
  selected,
  elapsedFor,
  actionFor,
  onToggleSelect,
  onOpen
}: FleetTableProps): React.JSX.Element {
  // Drop the ELAPSED column entirely when nothing is running — otherwise it's a
  // full column of "—". It reappears the moment any agent starts working.
  const showElapsed = anyRunning(agents)
  return (
    <div role="table" aria-label="Fleet agents" style={{ minWidth: 0 }}>
      <HeaderRow showElapsed={showElapsed} />
      {agents.length === 0 ? (
        <div
          style={{
            padding: '40px 12px',
            textAlign: 'center',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-meta)',
            color: 'var(--tx-4)'
          }}
        >
          No agents match.
        </div>
      ) : (
        agents.map((a) => {
          const el = elapsedFor(a)
          return (
            <FleetRow
              key={a.path}
              agent={a}
              selected={selected.has(a.path)}
              showElapsed={showElapsed}
              elapsed={el.text}
              elapsedColor={el.color}
              action={actionFor(a)}
              onToggleSelect={() => onToggleSelect(a.path)}
              onOpen={() => onOpen(a.path)}
            />
          )
        })
      )}
    </div>
  )
}

export default FleetTable
