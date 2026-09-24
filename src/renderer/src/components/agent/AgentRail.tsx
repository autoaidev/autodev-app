import React from 'react'
import {
  SearchInput,
  Pill,
  Toolbar,
  IconButton,
  Button,
  ContextMenu,
  ContextMenuEntry,
  StatusDot,
  DotStatus,
  Icon
} from '@renderer/ui'
import {
  AgentState,
  Activity,
  needsUserAttention,
  providerShort,
  ACTIVITY_LABEL,
  Checkbox,
  AgentRow
} from './AgentRow'
import { useAppActions } from '@renderer/services/appActions'
import { useAdvancedMode } from '@renderer/services/advancedMode'
import { useModelCatalog, modelLabel } from '@renderer/lib/providers'

/**
 * AgentRail — the 262px left rail of the Agent-detail screen (2a): a live filter
 * over the whole fleet, three status pills, a group-by control, a bulk-select
 * toolbar (revealed when rows are checked), office group folders, the AgentRow
 * list, a "+ New agent" footer, and the right-click ContextMenu.
 */

export type AgentAction =
  | 'openFolder'
  | 'openEditor'
  | 'openTerminal'
  | 'copyPath'
  | 'stop'
  | 'restart'
  | 'watch'
  | 'setup'
  | 'remove'

export type BulkAction = 'start' | 'stop' | 'restart' | 'add' | 'model' | 'mcp'

type Filter = 'all' | 'running' | 'attention'
type GroupBy = 'office' | 'role' | 'provider' | 'state' | 'model'

export interface AgentRailProps {
  agents: AgentState[]
  selectedPath?: string
  onSelect: (path: string) => void
  checked: Set<string>
  onCheckedChange: (next: Set<string>) => void
  /** Add ONE local agent (opens the single-agent create modal). */
  onNewAgent: () => void
  /** Open the describe→team wizard (Make-app funnel) — a distinct action. */
  onGenerateTeam: () => void
  onAction: (action: AgentAction, agent: AgentState) => void
  onBulk: (action: BulkAction) => void
  /** Folder group header: start every not-already-running agent in the group. */
  onRunFolder: (agents: AgentState[]) => void
  /** Folder group header: open the new-agent modal pre-scoped to `folderDir`
   *  (the directory that contains the group's agent workspaces). */
  onSpawnInFolder: (folderDir: string) => void
}

/** The directory that CONTAINS a group's agent workspaces (path minus its last
 *  segment) — the folder a "Spawn new agent" lands its new workspace inside. */
function containingDir(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  parts.pop()
  return parts.join('/')
}

/** Worst state in a group drives the header dot. */
const RANK: Record<Activity, number> = {
  crashed: 5,
  stalled: 4,
  'needs-auth': 4,
  'rate-limited': 4,
  working: 3,
  idle: 1,
  stopped: 0
}
function worst(agents: AgentState[]): DotStatus {
  let best: Activity = 'stopped'
  for (const a of agents) if (RANK[a.activity] > RANK[best]) best = a.activity
  return best
}

function parentFolderName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : 'workspace'
}

/**
 * The mono office/path label shown as the header `sub`. The office slug is used
 * here ONLY (never as a grouping key). When there's no bound office we fall back
 * to the two path segments above the workspace so the header still locates the
 * folder.
 */
function officePathLabel(a: AgentState): string {
  if (a.officeSlug) return `offices/${a.officeSlug}`
  const parts = a.path.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts.slice(-3, -1).join('/') || parentFolderName(a.path)
}

/** A semantic role for the Role partition — the office character slug, else the
 *  agent name with its trailing id hash stripped. */
function roleOf(a: AgentState): string {
  if (a.officeAgentSlug) return a.officeAgentSlug
  const stripped = a.name.replace(/[-_][0-9a-f]{4,12}$/i, '').trim()
  return stripped || a.name
}

function groupKeyFor(a: AgentState, by: GroupBy, modelName?: string): { key: string; label: string; sub: string } {
  if (by === 'provider') {
    const p = providerShort(a.provider)
    return { key: `p:${p}`, label: p, sub: 'provider' }
  }
  if (by === 'model') {
    // Partition by the resolved model (friendly label); every default-model agent
    // collapses into one "Provider default" bucket. Key on the raw id so two
    // vendors' models never merge under a shared label.
    const raw = a.model || ''
    return { key: `m:${a.provider?.split('-')[0] || ''}:${raw || 'default'}`, label: modelName || 'Provider default', sub: 'model' }
  }
  if (by === 'state') {
    return { key: `s:${a.activity}`, label: ACTIVITY_LABEL[a.activity], sub: 'state' }
  }
  if (by === 'role') {
    const r = roleOf(a)
    return { key: `r:${r.toLowerCase()}`, label: r.replace(/[-_]/g, ' '), sub: 'role' }
  }
  // office folder: key on the CONTAINING SUBFOLDER first, so each real subfolder
  // (director/, editor/, gaffer/, architect/…) becomes its own group. The office
  // slug is ONLY the header's mono path label — never the grouping key. Keying on
  // the slug/wsUrl is exactly what collapsed the whole fleet into one "Office"
  // bucket before, nullifying the "office lives on the header" premise.
  const folder = parentFolderName(a.path)
  const label =
    folder && folder !== 'workspace'
      ? folder.replace(/[-_]/g, ' ')
      : a.officeSlug
        ? a.officeSlug.replace(/[-_]/g, ' ')
        : 'workspace'
  return { key: `f:${folder}`, label, sub: officePathLabel(a) }
}

/** A small action button on the folder band (Run all / Spawn new agent). On the
 *  actions ROW it carries a visible `text` label beside its icon so each control
 *  clearly belongs to the folder; without `text` it renders as a bare 18px glyph.
 *  Stops propagation so it never toggles the header's fold state. */
function HeaderAction({
  icon,
  label,
  text,
  color,
  disabled,
  onClick
}: {
  icon: 'play' | 'plus'
  label: string
  /** Optional visible label (rendered on the actions row); `label` stays the
   *  full aria/title text for a11y even when `text` is a shorter caption. */
  text?: string
  color?: string
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled) onClick()
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: text ? 4 : 0,
        width: text ? 'auto' : 18,
        height: 18,
        padding: text ? '0 7px' : 0,
        flex: 'none',
        borderRadius: 'var(--r-tiny)',
        background: 'var(--bg-input)',
        border: '1px solid var(--bd-track)',
        color: disabled ? 'var(--tx-faint)' : color ?? 'var(--tx-3)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--fs-micro)',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1
      }}
    >
      <Icon name={icon} size={11} color={disabled ? 'var(--tx-faint)' : color} />
      {text && <span>{text}</span>}
    </button>
  )
}

function GroupHeader({
  label,
  sub,
  agents,
  providerLabel,
  modelLabel,
  expanded,
  onToggleExpand,
  groupChecked,
  onToggleCheck,
  selectable = true,
  folderActions,
  onRunFolder,
  onSpawnInFolder
}: {
  label: string
  sub: string
  agents: AgentState[]
  /** Provider shared by every agent in the group — rendered once here so the
   *  rows never repeat it (R2). Undefined when the group is mixed, or when the
   *  list is already partitioned by provider (the label would be redundant). */
  providerLabel?: string
  /** Friendly model shared by every agent in the group (uniform-value pattern,
   *  mirroring providerLabel). Undefined when mixed, when a default model, or when
   *  already partitioning by model. */
  modelLabel?: string
  expanded: boolean
  onToggleExpand: () => void
  groupChecked: 'none' | 'some' | 'all'
  onToggleCheck: () => void
  /** Show the bulk-select checkbox on the header (Basic hides the bulk workflow). */
  selectable?: boolean
  /** Show the per-folder Run all / Spawn new agent controls (office grouping only). */
  folderActions: boolean
  onRunFolder: () => void
  onSpawnInFolder: () => void
}): React.JSX.Element {
  const running = agents.filter((a) => a.running).length
  const notRunning = agents.length - running
  const [hover, setHover] = React.useState(false)
  // The WHOLE band is the disclosure control (role=button + aria-expanded): a
  // leading chevron + folder glyph, the name in a readable weight, and the count
  // — so a user can click anywhere on the header to fold/unfold, and it can never
  // be mistaken for one of the Inspector's static uppercase SECTION captions.
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`${label} folder, ${agents.length} agents`}
      onClick={onToggleExpand}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggleExpand()
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        // Column: a top line (name + count + checkbox) and, for real folders, a
        // second actions line below it — so Run all / Spawn never overlap the name.
        flexDirection: 'column',
        gap: 5,
        padding: '7px 9px 7px 11px',
        // Section BAND: a filled group-header band with an inset accent tick on the
        // left (the warm office-identity accent) + a 1px top-highlight, so each
        // office folder reads as a distinct, slightly-lifted section header.
        background: hover ? 'var(--bg-hover)' : 'var(--bg-group-header)',
        border: '1px solid var(--bd-2)',
        borderRadius: 'var(--r-chip)',
        boxShadow: 'inset 3px 0 0 var(--accent-warm), inset 0 1px 0 rgba(255, 255, 255, .05)',
        cursor: 'pointer',
        transition: 'background .12s ease'
      }}
    >
      {/* Top line: chevron + glyphs + name/sub + provider·model + count + checkbox */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', minWidth: 0 }}>
        {/* disclosure chevron — leads, far left, higher-contrast, rotates on expand */}
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 12,
          height: 12,
          flex: 'none',
          color: 'var(--tx-2)',
          transform: expanded ? 'rotate(90deg)' : 'none',
          transition: 'transform .12s ease'
        }}
      >
        <Icon name="caret" size={10} />
      </span>
      {/* keep the folder glyph, plus a warm office glyph so a group reads as an
          office-of-agents (the warm accent mark) rather than a bare folder */}
      <Icon name="folder" size={14} color="var(--tx-3)" style={{ flex: 'none' }} />
      <Icon name="office" size={12} color="var(--accent-warm)" style={{ flex: 'none' }} />
      {/* The office name gets the whole first line + width priority; the repo-path
          `sub` is a smaller second line so the full "EPICMOVIES" always shows and
          the name ellipsizes last, only when truly too long. */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span
          style={{
            minWidth: 0,
            fontSize: 'var(--fs-office-label)',
            fontWeight: 'var(--fw-selected)',
            color: 'var(--tx-hi)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {label}
        </span>
        {sub && (
          <span
            style={{
              minWidth: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-micro)',
              color: 'var(--tx-faint)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {sub}
          </span>
        )}
      </div>
      <span style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 'none' }}>
        {(providerLabel || modelLabel) && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-micro)',
              color: 'var(--tx-4)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 96
            }}
          >
            {[providerLabel, modelLabel].filter(Boolean).join(' · ')}
          </span>
        )}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>
          {running}/{agents.length}
        </span>
        <StatusDot status={worst(agents)} size={5} />
        {/* checkbox kept as a separate nested control — it stops propagation so
            ticking a folder never also toggles its fold state. Hidden in Basic
            (the whole bulk-select workflow is Advanced-only). */}
        {selectable && (
          <Checkbox
            checked={groupChecked === 'all'}
            indeterminate={groupChecked === 'some'}
            onChange={onToggleCheck}
            label={`Select ${label}`}
          />
        )}
      </span>
      </div>
      {/* Actions row (office grouping only): Run all / Spawn new agent get their
          OWN line below the name so they can never overlap or truncate long folder
          names. ALWAYS visible (was hover/checked-gated) — the user wants the per-office
          controls persistently shown, not revealed on hover; buttons stop-propagate so
          the fold toggle still works. flex-wrap keeps them inside the rail on very
          narrow labels. */}
      {folderActions && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 6,
            // Indent past the chevron + folder glyph so the row visibly belongs to
            // the header content above it (aligns under the name area).
            paddingLeft: 19
          }}
        >
          <HeaderAction
            icon="play"
            color="var(--st-running)"
            disabled={notRunning === 0}
            label={notRunning === 0 ? 'All agents running' : `Run all (${notRunning})`}
            text={notRunning === 0 ? 'All running' : `Run all (${notRunning})`}
            onClick={onRunFolder}
          />
          <HeaderAction
            icon="plus"
            label="Spawn new agent in this folder"
            text="Spawn new agent"
            onClick={onSpawnInFolder}
          />
        </div>
      )}
    </div>
  )
}

const GROUP_OPTIONS: { id: GroupBy; label: string }[] = [
  { id: 'office', label: 'Office folder' },
  { id: 'role', label: 'Role' },
  { id: 'provider', label: 'Provider' },
  { id: 'model', label: 'Model' },
  { id: 'state', label: 'State' }
]
// Basic offers the two human partitions (office folder + role); Provider / Model /
// State are expert partitions gated to Advanced.
const BASIC_GROUP_IDS: ReadonlySet<GroupBy> = new Set<GroupBy>(['office', 'role'])

export function AgentRail({
  agents,
  selectedPath,
  onSelect,
  checked,
  onCheckedChange,
  onNewAgent,
  onGenerateTeam,
  onAction,
  onBulk,
  onRunFolder,
  onSpawnInFolder
}: AgentRailProps): React.JSX.Element {
  const { openHelp } = useAppActions()
  // Advanced gates the bulk-select workflow (checkboxes + toolbar + Select-all), the
  // extra Group-by partitions, and the file-manager row actions. Basic = office
  // grouping, no bulk chrome.
  const { advanced } = useAdvancedMode()
  // The model catalog resolves each agent's raw model id into a friendly label
  // (one shared, process-cached fetch). Empty until it loads / on an older CLI, in
  // which case the raw id is shown — the fleet still surfaces the model.
  const { catalog } = useModelCatalog()
  const modelNameFor = React.useCallback(
    (a: AgentState): string => (a.model ? modelLabel(catalog, a.provider || '', a.model) : ''),
    [catalog]
  )
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState<Filter>('all')
  const [groupBy, setGroupBy] = React.useState<GroupBy>('office')
  // Basic allows office folder + Role; the expert partitions (provider/model/state)
  // collapse back to office when Advanced is off.
  const effectiveGroupBy: GroupBy = advanced ? groupBy : BASIC_GROUP_IDS.has(groupBy) ? groupBy : 'office'
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set())
  const [menu, setMenu] = React.useState<{ x: number; y: number; agent: AgentState } | null>(null)
  // Installed app version for the rail footer (main-process app:version IPC).
  // Rendered as `v<version>` so support/bug reports can name the exact build.
  const [version, setVersion] = React.useState<string>('')
  React.useEffect(() => {
    let live = true
    window.api
      .appVersion()
      .then((v) => {
        if (live && v) setVersion(`v${v}`)
      })
      .catch(() => {
        /* version is a nicety — a failed IPC just hides it */
      })
    return () => {
      live = false
    }
  }, [])

  const runningCount = agents.filter((a) => a.running).length
  // "Needs you" = agents genuinely awaiting the user (re-auth / rate-limit /
  // pending choice), NOT crashed/stalled failures — see needsUserAttention. The
  // chip count and its filter share this one predicate so they can't disagree.
  const needsCount = agents.filter(needsUserAttention).length

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return agents.filter((a) => {
      if (filter === 'running' && !a.running) return false
      if (filter === 'attention' && !needsUserAttention(a)) return false
      if (q && !(a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q) || (a.provider || '').includes(q)))
        return false
      return true
    })
  }, [agents, query, filter])

  const groups = React.useMemo(() => {
    const map = new Map<string, { label: string; sub: string; agents: AgentState[] }>()
    for (const a of filtered) {
      const g = groupKeyFor(a, effectiveGroupBy, modelNameFor(a))
      const cur = map.get(g.key)
      if (cur) cur.agents.push(a)
      else map.set(g.key, { label: g.label, sub: g.sub, agents: [a] })
    }
    return Array.from(map.entries())
  }, [filtered, effectiveGroupBy, modelNameFor])

  const toggleCheck = (path: string): void => {
    const next = new Set(checked)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    onCheckedChange(next)
  }
  const groupCheckState = (gAgents: AgentState[]): 'none' | 'some' | 'all' => {
    const n = gAgents.filter((a) => checked.has(a.path)).length
    return n === 0 ? 'none' : n === gAgents.length ? 'all' : 'some'
  }
  const toggleGroup = (gAgents: AgentState[]): void => {
    const state = groupCheckState(gAgents)
    const next = new Set(checked)
    if (state === 'all') gAgents.forEach((a) => next.delete(a.path))
    else gAgents.forEach((a) => next.add(a.path))
    onCheckedChange(next)
  }
  const selectAll = (): void => {
    if (checked.size === filtered.length) onCheckedChange(new Set())
    else onCheckedChange(new Set(filtered.map((a) => a.path)))
  }

  const openMenu = (e: React.MouseEvent, agent: AgentState): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, agent })
  }

  const menuItems = (a: AgentState): ContextMenuEntry[] => [
    // The ⌘⏎ hint is expert scaffolding — shown only in Advanced (Basic stays clean).
    { label: 'Open agent folder', icon: 'folder', ...(advanced ? { kbd: '⌘⏎' } : {}), active: true, onClick: () => onAction('openFolder', a) },
    // Open-in-editor / Open-terminal-here / Copy-path are power-user file actions —
    // Advanced only. Open folder, Stop, Restart, Setup, Remove stay in Basic.
    ...(advanced
      ? ([
          { label: 'Open in editor', icon: 'editor', onClick: () => onAction('openEditor', a) },
          { label: 'Open terminal here', icon: 'terminal', onClick: () => onAction('openTerminal', a) },
          { label: 'Copy path', icon: 'copy', onClick: () => onAction('copyPath', a) }
        ] as ContextMenuEntry[])
      : []),
    { separator: true },
    { label: 'Stop loop', icon: 'stop', disabled: !a.running, onClick: () => onAction('stop', a) },
    { label: 'Restart', icon: 'restart', onClick: () => onAction('restart', a) },
    // Watching the raw live session is an expert probe — Advanced only.
    ...(advanced
      ? ([{ label: 'Watch live session', icon: 'clock', onClick: () => onAction('watch', a) }] as ContextMenuEntry[])
      : []),
    { label: 'Setup…', icon: 'gear', onClick: () => onAction('setup', a) },
    // Hide the destructive Remove for a locally-operated office character — its
    // Remove would fold-delete the app-owned office scratch dir out from under a
    // live Operate session (Change 1). Stop already maps to closing that session.
    ...(a.officeOperate
      ? []
      : ([{ separator: true }, { label: 'Remove…', icon: 'trash', danger: true, onClick: () => onAction('remove', a) }] as ContextMenuEntry[]))
  ]

  return (
    <div
      style={{
        width: 'var(--w-agents-rail)',
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        // Lifted chrome rail (see the three-pane elevation model in theme.css): a
        // clearly-separated fill, a strong structural seam against the darker center
        // stage, and a 1px top inner highlight so the rail reads as raised.
        background: 'var(--bg-rail)',
        borderRight: '1px solid var(--bd-seam)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.03)'
      }}
    >
      {/* pane cap — titles the rail as the fleet list so it can't blur into its
          neighbour (every pane now carries a weighted, banded top edge) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 40,
          flex: 'none',
          padding: '0 14px',
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
          Agents
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-tiny)',
            color: 'var(--tx-dim)'
          }}
        >
          {agents.length}
        </span>
      </div>

      {/* filter header */}
      <div style={{ padding: '11px 12px 9px', borderBottom: '1px solid var(--bd-card)' }}>
        <SearchInput
          width="100%"
          placeholder={`Filter ${agents.length} agents`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
          <button type="button" onClick={() => setFilter('all')} style={{ all: 'unset', cursor: 'pointer' }}>
            <Pill variant={filter === 'all' ? 'accent' : 'neutral'} selected={filter === 'all'}>
              All {agents.length}
            </Pill>
          </button>
          <button type="button" onClick={() => setFilter('running')} style={{ all: 'unset', cursor: 'pointer' }}>
            <Pill variant={filter === 'running' ? 'accent' : 'neutral'} selected={filter === 'running'}>
              Running {runningCount}
            </Pill>
          </button>
          <button type="button" onClick={() => setFilter('attention')} style={{ all: 'unset', cursor: 'pointer' }}>
            <Pill variant={filter === 'attention' ? 'amber' : 'neutral'} selected={filter === 'attention'}>
              Needs you {needsCount}
            </Pill>
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <span style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-4)' }}>Group by</span>
          <select
            value={effectiveGroupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            style={{
              flex: 'none',
              padding: '4px 8px',
              borderRadius: 'var(--r-chip)',
              background: 'var(--bg-input)',
              border: '1px solid var(--bd-1)',
              color: 'var(--tx-hi)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-desc)',
              cursor: 'pointer'
            }}
          >
            {/* Basic offers office folder + Role; provider/model/state are Advanced. */}
            {(advanced ? GROUP_OPTIONS : GROUP_OPTIONS.filter((o) => BASIC_GROUP_IDS.has(o.id))).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          {/* Select-all is part of the Advanced bulk-select workflow. */}
          {advanced && (
            <button
              type="button"
              onClick={selectAll}
              style={{
                marginLeft: 'auto',
                all: 'unset',
                cursor: 'pointer',
                color: 'var(--accent)',
                fontSize: 'var(--fs-desc)'
              }}
            >
              {checked.size === filtered.length && filtered.length > 0 ? 'Clear' : `Select all ${filtered.length}`}
            </button>
          )}
        </div>
      </div>

      {/* bulk-select toolbar — Advanced only */}
      {advanced && checked.size > 0 && (
        <Toolbar count={checked.size}>
          <IconButton label="Start" icon="play" iconColor="var(--st-running)" onClick={() => onBulk('start')} />
          <IconButton label="Stop" iconColor="var(--st-error)" onClick={() => onBulk('stop')}>
            <Icon name="stop" size={10} color="var(--st-error)" />
          </IconButton>
          <IconButton label="Restart" icon="restart" onClick={() => onBulk('restart')} />
          <IconButton label="Set model" icon="settings" onClick={() => onBulk('model')} />
          <IconButton label="Set MCP" icon="sparkle" onClick={() => onBulk('mcp')} />
          <IconButton label="Add task" icon="plus" onClick={() => onBulk('add')} />
          <IconButton label="Clear selection" icon="close" onClick={() => onCheckedChange(new Set())} />
        </Toolbar>
      )}

      {/* list */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 6px 0' }}>
        {filtered.length === 0 &&
          (agents.length === 0 ? (
            // Genuinely empty fleet (first run) — guide the next action instead of a
            // bare "No agents match." (which only makes sense when a filter is on).
            <div
              style={{
                margin: '18px 8px 0',
                padding: '16px 14px',
                background: 'var(--bg-input)',
                border: '1px solid var(--bd-card)',
                borderRadius: 'var(--r-card)',
                textAlign: 'center'
              }}
            >
              <div style={{ fontSize: 'var(--fs-meta)', fontWeight: 600, color: 'var(--tx-hi)' }}>
                No agents yet
              </div>
              <div style={{ margin: '5px 0 12px', fontSize: 'var(--fs-desc)', color: 'var(--tx-dim)', lineHeight: 1.5 }}>
                Add a single agent in a folder — or generate a whole team from a description.
              </div>
              <Button variant="primary" size="sm" block onClick={onNewAgent}>
                <Icon name="plus" size={11} color="var(--tx-onaccent)" /> Create your first agent
              </Button>
              <Button variant="secondary" size="sm" block style={{ marginTop: 8 }} onClick={onGenerateTeam}>
                Generate a team…
              </Button>
              <button
                type="button"
                onClick={openHelp}
                style={{
                  all: 'unset',
                  marginTop: 9,
                  display: 'inline-block',
                  cursor: 'pointer',
                  fontSize: 'var(--fs-desc)',
                  color: 'var(--accent)'
                }}
              >
                Getting started guide
              </button>
            </div>
          ) : (
            <div style={{ padding: '18px 8px', color: 'var(--tx-5)', fontSize: 'var(--fs-meta)' }}>
              No agents match.
            </div>
          ))}
        {groups.map(([key, g]) => {
          const expanded = !collapsed.has(key)
          // Provider is carried once on the header (R2). Show it only when every
          // row in the group shares one provider AND we aren't already grouping
          // by provider (which would make the header label + this redundant).
          const provs = new Set(g.agents.map((a) => providerShort(a.provider)))
          const providerLabel = effectiveGroupBy !== 'provider' && provs.size === 1 ? [...provs][0] : undefined
          // Shared MODEL on the header when every agent in the group runs the same
          // non-default model (uniform-value pattern, mirroring providerLabel).
          // Suppressed while grouping by model (the header label already is it).
          const models = new Set(g.agents.map((a) => modelNameFor(a)))
          const onlyModel = models.size === 1 ? [...models][0] : ''
          const uniformModel = effectiveGroupBy !== 'model' && onlyModel ? onlyModel : undefined
          return (
            <div key={key} style={{ marginBottom: 4 }}>
              <GroupHeader
                label={g.label}
                sub={g.sub}
                agents={g.agents}
                providerLabel={providerLabel}
                modelLabel={uniformModel}
                expanded={expanded}
                onToggleExpand={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev)
                    if (next.has(key)) next.delete(key)
                    else next.add(key)
                    return next
                  })
                }
                groupChecked={groupCheckState(g.agents)}
                onToggleCheck={() => toggleGroup(g.agents)}
                selectable={advanced}
                // Run all / Spawn belong to real folder groups only (office
                // grouping). Under Role/Provider/State a "group" isn't a folder,
                // so a folder-scoped spawn would be meaningless.
                folderActions={effectiveGroupBy === 'office'}
                onRunFolder={() => onRunFolder(g.agents)}
                onSpawnInFolder={() => onSpawnInFolder(containingDir(g.agents[0].path))}
              />
              {expanded && (
                // Indent + a 1px guide line so the rows visibly nest INSIDE the
                // folder (the parent→child cue that makes it read as folder-of-agents).
                <div
                  style={{
                    marginLeft: 14,
                    paddingLeft: 6,
                    marginTop: 2,
                    borderLeft: '1px solid var(--bd-2)'
                  }}
                >
                  {g.agents.map((a) => (
                    <AgentRow
                      key={a.path}
                      agent={a}
                      selected={a.path === selectedPath}
                      checked={checked.has(a.path)}
                      onSelect={() => onSelect(a.path)}
                      onToggleCheck={() => toggleCheck(a.path)}
                      modelLabel={modelNameFor(a)}
                      showCheck={advanced}
                      onMenu={openMenu}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* footer */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '10px 12px',
          borderTop: '1px solid var(--bd-card)'
        }}
      >
        {/* Two DISTINCT add paths, honestly labeled: the primary adds ONE local
            agent (opens the single-agent create modal); the secondary opens the
            describe→team wizard. Previously "+ New agent" routed into the team
            wizard, so a user wanting one agent landed in team generation. */}
        <Button variant="primary" block onClick={onNewAgent}>
          <Icon name="plus" size={11} color="var(--tx-onaccent)" /> New agent
        </Button>
        <Button variant="secondary" block onClick={onGenerateTeam}>
          Generate team…
        </Button>
        {/* Build stamp: the installed app version, so the rail footer names the
            exact build. Hidden until the IPC resolves (never a bare "v"). */}
        {version && (
          <div
            style={{
              textAlign: 'center',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-micro)',
              color: 'var(--tx-faint)',
              letterSpacing: 'var(--ls-tight)'
            }}
          >
            {version}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          // The mono agent-id header is machine noise for Basic — Advanced only.
          header={advanced ? menu.agent.path.split('/').filter(Boolean).pop() : undefined}
          items={menuItems(menu.agent)}
          onClose={() => setMenu(null)}
          style={{ position: 'fixed', left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 360) }}
        />
      )}
    </div>
  )
}

export default AgentRail
