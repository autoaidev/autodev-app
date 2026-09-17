import React, { useMemo, useRef, useState } from 'react'
import { Icon, StatusPill, AgentAvatar, ProviderChip } from '@renderer/ui'
import { ModelSelect } from '@renderer/components/ModelSelect'
import { AgentLifecycleControls } from '@renderer/components/agent/AgentLifecycleControls'
import { useModelCatalog, effectiveModelDisplay, modelsForFamily, type ModelCatalogEntry } from '@renderer/lib/providers'
import { providerAccent } from '@renderer/services/identity'
import {
  AgentState,
  agentHeadline,
  agentSlugId,
  anyRunning,
  fleetOffice,
  isAttention,
  stripTaskHash,
  tasksFraction,
  tasksLabel,
  washTone
} from './fleet-helpers'
import { agentStatus, needsUserAttention, isError } from '@renderer/services/model'

/**
 * A row's left spine color: STATE first (running → green, needs-you → amber,
 * failure → red), else a receding PROVIDER hue so an idle row still carries its
 * tool color and no row is ever fully grey. Mirrors the Agents-rail AgentRow spine
 * logic exactly — a crashed/interrupted row reads red (an error), NOT amber
 * "needs you" (which is reserved for agents genuinely awaiting the user).
 */
function rowSpine(a: AgentState): string {
  if (a.running || a.activity === 'working') return 'var(--st-running-spine)'
  if (needsUserAttention(a)) return 'var(--st-needsyou)'
  if (isError(a)) return 'var(--st-error)'
  return providerAccent(a.provider).ring
}

/**
 * Grid template shared by the header row and every data row. The ELAPSED column is
 * dropped when nothing is running (it would be all "—"); MODEL + ELAPSED are also
 * dropped in Basic (they're expert columns), so the template is derived from
 * `showModel` + `showElapsed`.
 */
function gridFor(showCheck: boolean, showModel: boolean, showElapsed: boolean): string {
  // [checkbox] · AGENT · OFFICE · STATE · [MODEL] · CURRENT TASK · TASKS · [ELAPSED] · ACTION
  // The bulk-select checkbox is an expert workflow — dropped in Basic (Advanced only).
  const cols = showCheck ? ['14px'] : []
  // STATE widened to 116px so the tint-pair pill (e.g. "NEEDS AUTH") never clips.
  cols.push('180px', '112px', '116px')
  if (showModel) cols.push('132px')
  cols.push('minmax(0,1fr)', '84px')
  if (showElapsed) cols.push('72px')
  // ACTION — widened to fit the explicit lifecycle cluster (Start/Stop + Restart)
  // ahead of the contextual action (Add task / ··· menu).
  cols.push('132px')
  return cols.join(' ')
}
const COL_GAP = 14
// Denser rows (~57px → ~42px) so 12+ agents fit a 1456×759 viewport without a
// page-level scroll — the fleet is a scan surface, matching Sessions' density (ADD 1,
// R3: 8px→7px vertical shaves ~2px/row on top of the summary-strip trim).
const ROW_PAD = '7px 18px'

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

/** STATE cell — the beautifui.dev tint-pair StatusPill (dot + label on a soft tint),
 *  driven by the SHARED status map (agentStatus): working → good, needs-you → warn,
 *  crashed/stalled → crit, idle/stopped → neutral. So a WORKING row now reads as a
 *  live green pill instead of a bare word indistinguishable from an idle one. */
function StateBadge({ a }: { a: AgentState }): React.JSX.Element {
  const { variant, label } = agentStatus(a)
  // Breathe the dot only while the agent is actively producing output (working);
  // idle/stopped/error rows stay static.
  return <StatusPill variant={variant} label={label} size="sm" live={a.activity === 'working'} />
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
  // Data-viz color: done → green (--st-done), in-progress → blue (--st-active),
  // empty → grey track. Attention states override with amber/red.
  const fill =
    tone === 'red'
      ? 'var(--st-error)'
      : tone === 'amber'
        ? 'var(--st-needsyou)'
        : complete
          ? 'var(--st-done)' // all tasks closed — green
          : running
            ? 'var(--st-active)' // in-progress — blue
            : total > 0
              ? 'var(--st-done)' // partial-but-idle done portion still reads green
              : 'var(--st-track)' // no tasks — bare grey track
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
          fontFeatureSettings: 'var(--fvn-tabular)',
          color: total === 0 ? 'var(--tx-ghost)' : complete ? 'var(--accent-ink)' : 'var(--tx-3)'
        }}
      >
        {tasksLabel(a.tasks)}
      </span>
    </span>
  )
}

/**
 * MODEL cell (#10) — the agent's effective model, click-to-edit in place. At rest
 * it's a text button (effectiveModelDisplay: a set model with its context, else
 * "Provider default (…)"). Clicking swaps in the shared ModelSelect for that row's
 * provider; choosing a value persists via the SAME `config set <vendorKey>` path as
 * Setup, then collapses back. Only the row being edited mounts a select, so a
 * 42-agent table stays light. stopPropagation keeps a click off the row's onOpen.
 */
function ModelCell({
  a,
  catalog,
  onSet
}: {
  a: AgentState
  catalog: ModelCatalogEntry[]
  onSet: (a: AgentState, id: string) => Promise<void> | void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  // A local draft while editing so a controlled ModelSelect reflects typing at once
  // (the persisted `a.model` only updates on the next store poll). A discrete pick
  // (a catalog option or "Provider default") saves + collapses immediately; a typed
  // Custom id saves on a short debounce and on blur, so we neither spam `config set`
  // per keystroke nor collapse mid-type.
  const [draft, setDraft] = useState('')
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const vendor = a.provider || ''
  const known = useMemo(() => new Set(modelsForFamily(catalog, vendor).map((m) => m.id)), [catalog, vendor])

  const commit = async (id: string, collapse: boolean): Promise<void> => {
    setSaving(true)
    await onSet(a, id)
    setSaving(false)
    if (collapse) setEditing(false)
  }

  if (editing) {
    return (
      <div
        style={{ minWidth: 0 }}
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => {
          // Focus left the whole picker → flush any pending custom save + collapse.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          if (debounce.current) {
            clearTimeout(debounce.current)
            debounce.current = null
            void onSet(a, draft)
          }
          setEditing(false)
        }}
      >
        <ModelSelect
          compact
          vendor={vendor}
          value={draft}
          onChange={(id) => {
            setDraft(id)
            if (debounce.current) {
              clearTimeout(debounce.current)
              debounce.current = null
            }
            // '' (Provider default) or a known catalog id is a discrete pick.
            if (id === '' || known.has(id)) void commit(id, true)
            else debounce.current = setTimeout(() => void commit(id, false), 500)
          }}
        />
      </div>
    )
  }
  return (
    <button
      type="button"
      className="fleet-linkbtn"
      title="Change model"
      disabled={saving}
      onClick={(e) => {
        e.stopPropagation()
        setDraft(a.model || '')
        setEditing(true)
      }}
      style={{
        display: 'block',
        width: '100%',
        minWidth: 0,
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        padding: '2px 4px',
        borderRadius: 'var(--r-tiny)',
        color: a.model ? 'var(--tx-2)' : 'var(--tx-5)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--fs-meta)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        cursor: 'pointer'
      }}
    >
      {effectiveModelDisplay(catalog, vendor, a.model || '')}
    </button>
  )
}

/* ---------------------------------- header -------------------------------- */

function headCols(showCheck: boolean, showModel: boolean, showElapsed: boolean): string[] {
  const base = showCheck ? [''] : []
  base.push('AGENT', 'OFFICE', 'STATE')
  if (showModel) base.push('MODEL')
  base.push('CURRENT TASK', 'TASKS')
  if (showElapsed) base.push('ELAPSED')
  base.push('')
  return base
}

function HeaderRow({ showCheck, showModel, showElapsed }: { showCheck: boolean; showModel: boolean; showElapsed: boolean }): React.JSX.Element {
  return (
    <div
      role="row"
      style={{
        display: 'grid',
        gridTemplateColumns: gridFor(showCheck, showModel, showElapsed),
        columnGap: COL_GAP,
        alignItems: 'center',
        padding: '6px 18px',
        borderBottom: '1px solid var(--bd-row)',
        // Sticky column header — stays put as the fleet scrolls. Opaque stage fill
        // so rows never bleed through under it.
        position: 'sticky',
        top: 0,
        zIndex: 1,
        background: 'var(--surface-stage)'
      }}
    >
      {headCols(showCheck, showModel, showElapsed).map((h, i) => (
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
  /** Advanced only — the leading bulk-select checkbox column + the provider chip /
   *  slug-hash sub-line (redundant with the avatar ring in Basic). */
  showCheck: boolean
  showModel: boolean
  showElapsed: boolean
  elapsed: string
  elapsedColor: string
  action: RowAction
  catalog: ModelCatalogEntry[]
  onSetModel: (a: AgentState, id: string) => Promise<void> | void
  onToggleSelect: () => void
  onOpen: () => void
  /** Manager lifecycle — Start the agent loop (stopped → running). */
  onStart: (path: string) => void
  /** Stop the agent loop (running → stopped). */
  onStop: (path: string) => void
  /** Restart (stop then start) — available whenever the agent has a workspace. */
  onRestart: (path: string) => void
}

function FleetRow({
  agent,
  selected,
  showCheck,
  showModel,
  showElapsed,
  elapsed,
  elapsedColor,
  action,
  catalog,
  onSetModel,
  onToggleSelect,
  onOpen,
  onStart,
  onStop,
  onRestart
}: FleetRowProps): React.JSX.Element {
  // Running truth for the lifecycle control: a live loop OR actively working.
  const running = agent.running || agent.activity === 'working'
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
        gridTemplateColumns: gridFor(showCheck, showModel, showElapsed),
        columnGap: COL_GAP,
        alignItems: 'center',
        padding: ROW_PAD,
        borderBottom: '1px solid var(--bd-row)',
        // State/provider spine (inline so it survives, overriding the CSS selected
        // spine); selected adds a hairline ring on top so identity color is kept.
        boxShadow:
          `inset var(--spine-w) 0 0 ${rowSpine(agent)}` +
          (selected ? ', inset 0 0 0 1px var(--bd-panel-sel)' : ''),
        cursor: 'pointer'
      }}
    >
      {showCheck && <Checkbox checked={selected} onChange={onToggleSelect} label={`Select ${agent.name}`} />}

      {/* AGENT: colored identity avatar (same hue + provider ring the agent carries
          in the rail & its detail header) + human headline + a provider chip. The
          avatar turns the column from a grey name-list into recognizable objects. */}
      <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
        <AgentAvatar
          name={agentHeadline(agent)}
          idKey={agent.path}
          provider={agent.provider}
          size={22}
          dim={!(agent.running || agent.activity === 'working' || isAttention(agent))}
          // Live office character → its real pixel-art face; else initials monogram.
          avatarUrl={agent.officeAvatarUrl}
          avatarColor={agent.officeColor}
          online={agent.online}
          title={agent.name}
        />
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
          {/* Provider chip + slug-hash sub-line — Basic-hidden: the avatar's provider
              ring already carries the tool, and the hash is machine noise. Advanced
              restores both (support/bug-report identifiers). */}
          {showCheck && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                minWidth: 0
              }}
            >
              <ProviderChip provider={agent.provider} compact />
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-micro)',
                  color: 'var(--tx-ghost)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {agentSlugId(agent)}
              </span>
            </div>
          )}
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

      {/* MODEL (click-to-edit) — Advanced only */}
      {showModel && <ModelCell a={agent} catalog={catalog} onSet={onSetModel} />}

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

      {/* ACTION — explicit manager lifecycle (Start when stopped, Stop when running;
          Restart always, since the agent has a workspace) ahead of the contextual
          action (Add task / ··· menu). Retry/Re-auth on attention rows is itself a
          restart, so the Restart button covers it too. */}
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
        <AgentLifecycleControls
          running={running}
          name={agent.name}
          size={22}
          iconSize={11}
          style={{ gap: 6 }}
          onStart={() => onStart(agent.path)}
          onStop={() => onStop(agent.path)}
          onRestart={() => onRestart(agent.path)}
        />
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
  /** Advanced mode — reveals the expert MODEL + ELAPSED columns. */
  advanced?: boolean
  elapsedFor: (a: AgentState) => { text: string; color: string }
  actionFor: (a: AgentState) => RowAction
  /** Persist a row's model (#10) — same `config set <vendorKey>` path as Setup. */
  onSetModel: (a: AgentState, id: string) => Promise<void> | void
  onToggleSelect: (path: string) => void
  onOpen: (path: string) => void
  /** Manager lifecycle actions per row — Start / Stop / Restart the agent loop. */
  onStart: (path: string) => void
  onStop: (path: string) => void
  onRestart: (path: string) => void
}

export function FleetTable({
  agents,
  selected,
  advanced = false,
  elapsedFor,
  actionFor,
  onSetModel,
  onToggleSelect,
  onOpen,
  onStart,
  onStop,
  onRestart
}: FleetTableProps): React.JSX.Element {
  // MODEL + ELAPSED are expert columns — Advanced only. ELAPSED additionally drops
  // when nothing is running (else a full column of "—"). The bulk-select checkbox
  // column + the provider-chip/slug-hash sub-line are Advanced-only too.
  const showCheck = advanced
  const showModel = advanced
  const showElapsed = advanced && anyRunning(agents)
  // One shared catalog fetch for the whole table (resolves each row's model label).
  const { catalog } = useModelCatalog()
  return (
    <div role="table" aria-label="Fleet agents" style={{ minWidth: 0 }}>
      <HeaderRow showCheck={showCheck} showModel={showModel} showElapsed={showElapsed} />
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
              showCheck={showCheck}
              showModel={showModel}
              showElapsed={showElapsed}
              elapsed={el.text}
              elapsedColor={el.color}
              action={actionFor(a)}
              catalog={catalog}
              onSetModel={onSetModel}
              onToggleSelect={() => onToggleSelect(a.path)}
              onOpen={() => onOpen(a.path)}
              onStart={onStart}
              onStop={onStop}
              onRestart={onRestart}
            />
          )
        })
      )}
    </div>
  )
}

export default FleetTable
