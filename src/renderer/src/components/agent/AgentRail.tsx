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
  ATTENTION_STATES,
  providerShort,
  ACTIVITY_LABEL,
  Checkbox,
  AgentRow
} from './AgentRow'

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
  | 'connect'
  | 'setup'
  | 'duplicate'
  | 'remove'

export type BulkAction = 'start' | 'stop' | 'restart' | 'add'

type Filter = 'all' | 'running' | 'attention'
type GroupBy = 'office' | 'provider' | 'status'

export interface AgentRailProps {
  agents: AgentState[]
  selectedPath?: string
  onSelect: (path: string) => void
  checked: Set<string>
  onCheckedChange: (next: Set<string>) => void
  onNewAgent: () => void
  onAction: (action: AgentAction, agent: AgentState) => void
  onBulk: (action: BulkAction) => void
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

function groupKeyFor(a: AgentState, by: GroupBy): { key: string; label: string; sub: string } {
  if (by === 'provider') {
    const p = providerShort(a.provider)
    return { key: `p:${p}`, label: p, sub: 'provider' }
  }
  if (by === 'status') {
    return { key: `s:${a.activity}`, label: ACTIVITY_LABEL[a.activity], sub: 'status' }
  }
  // office: prefer the bound office slug, else the containing folder
  if (a.officeSlug) return { key: `o:${a.officeSlug}`, label: a.officeSlug.replace(/-/g, ' '), sub: `offices/${a.officeSlug}` }
  if (a.wsUrl || a.officeAgentSlug) return { key: 'o:bound', label: 'Office', sub: 'connected' }
  const folder = parentFolderName(a.path)
  if (!folder || folder === 'workspace') return { key: 'o:none', label: 'No office', sub: 'unbound' }
  return { key: `f:${folder}`, label: folder.replace(/[-_]/g, ' '), sub: folder }
}

function GroupHeader({
  label,
  sub,
  agents,
  expanded,
  onToggleExpand,
  groupChecked,
  onToggleCheck
}: {
  label: string
  sub: string
  agents: AgentState[]
  expanded: boolean
  onToggleExpand: () => void
  groupChecked: 'none' | 'some' | 'all'
  onToggleCheck: () => void
}): React.JSX.Element {
  const running = agents.filter((a) => a.running).length
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 7px 7px' }}>
      <Checkbox
        checked={groupChecked === 'all'}
        indeterminate={groupChecked === 'some'}
        onChange={onToggleCheck}
        label={`Select ${label}`}
      />
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 12,
          height: 12,
          padding: 0,
          background: 'transparent',
          border: 'none',
          color: 'var(--tx-4)',
          cursor: 'pointer',
          transform: expanded ? 'rotate(90deg)' : 'none',
          transition: 'transform .12s ease'
        }}
      >
        <Icon name="caret" size={9} />
      </button>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 7 }}>
        <span
          style={{
            fontSize: 'var(--fs-section)',
            fontWeight: 700,
            letterSpacing: 'var(--ls-group)',
            color: 'var(--tx-4)',
            textTransform: 'uppercase',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-micro)',
            color: 'var(--tx-ghost)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {sub}
        </span>
      </div>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)', color: 'var(--tx-dim)' }}>
          {running}/{agents.length}
        </span>
        <StatusDot status={worst(agents)} size={5} />
      </span>
    </div>
  )
}

const GROUP_OPTIONS: { id: GroupBy; label: string }[] = [
  { id: 'office', label: 'Office folder' },
  { id: 'provider', label: 'Provider' },
  { id: 'status', label: 'Status' }
]

export function AgentRail({
  agents,
  selectedPath,
  onSelect,
  checked,
  onCheckedChange,
  onNewAgent,
  onAction,
  onBulk
}: AgentRailProps): React.JSX.Element {
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState<Filter>('all')
  const [groupBy, setGroupBy] = React.useState<GroupBy>('office')
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set())
  const [menu, setMenu] = React.useState<{ x: number; y: number; agent: AgentState } | null>(null)

  const runningCount = agents.filter((a) => a.running).length
  const needsCount = agents.filter((a) => ATTENTION_STATES.has(a.activity)).length

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return agents.filter((a) => {
      if (filter === 'running' && !a.running) return false
      if (filter === 'attention' && !ATTENTION_STATES.has(a.activity)) return false
      if (q && !(a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q) || (a.provider || '').includes(q)))
        return false
      return true
    })
  }, [agents, query, filter])

  const groups = React.useMemo(() => {
    const map = new Map<string, { label: string; sub: string; agents: AgentState[] }>()
    for (const a of filtered) {
      const g = groupKeyFor(a, groupBy)
      const cur = map.get(g.key)
      if (cur) cur.agents.push(a)
      else map.set(g.key, { label: g.label, sub: g.sub, agents: [a] })
    }
    return Array.from(map.entries())
  }, [filtered, groupBy])

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
    { label: 'Open agent folder', icon: 'folder', kbd: '⌘⏎', active: true, onClick: () => onAction('openFolder', a) },
    { label: 'Open in editor', icon: 'editor', onClick: () => onAction('openEditor', a) },
    { label: 'Open terminal here', icon: 'terminal', onClick: () => onAction('openTerminal', a) },
    { label: 'Copy path', icon: 'copy', onClick: () => onAction('copyPath', a) },
    { separator: true },
    { label: 'Stop loop', icon: 'stop', disabled: !a.running, onClick: () => onAction('stop', a) },
    { label: 'Restart', icon: 'restart', onClick: () => onAction('restart', a) },
    { label: 'Watch live session', icon: 'clock', onClick: () => onAction('watch', a) },
    { label: 'Connect to office…', icon: 'office', onClick: () => onAction('connect', a) },
    { label: 'Setup…', icon: 'gear', onClick: () => onAction('setup', a) },
    { separator: true },
    { label: 'Duplicate', icon: 'duplicate', onClick: () => onAction('duplicate', a) },
    { label: 'Remove…', icon: 'trash', danger: true, onClick: () => onAction('remove', a) }
  ]

  return (
    <div
      style={{
        width: 'var(--w-agents-rail)',
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--bd-nav)'
      }}
    >
      {/* filter header */}
      <div style={{ padding: '11px 12px 9px', borderBottom: '1px solid var(--bd-2)' }}>
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
            value={groupBy}
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
            {GROUP_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
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
        </div>
      </div>

      {/* bulk-select toolbar */}
      {checked.size > 0 && (
        <Toolbar count={checked.size}>
          <IconButton label="Start" icon="play" iconColor="var(--st-running)" onClick={() => onBulk('start')} />
          <IconButton label="Stop" iconColor="var(--st-error)" onClick={() => onBulk('stop')}>
            <Icon name="stop" size={10} color="var(--st-error)" />
          </IconButton>
          <IconButton label="Restart" icon="restart" onClick={() => onBulk('restart')} />
          <IconButton label="Add task" icon="plus" onClick={() => onBulk('add')} />
          <IconButton label="More" icon="more" />
          <IconButton label="Clear selection" icon="close" onClick={() => onCheckedChange(new Set())} />
        </Toolbar>
      )}

      {/* list */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 6px 0' }}>
        {filtered.length === 0 && (
          <div style={{ padding: '18px 8px', color: 'var(--tx-5)', fontSize: 'var(--fs-meta)' }}>
            No agents match.
          </div>
        )}
        {groups.map(([key, g]) => {
          const expanded = !collapsed.has(key)
          return (
            <div key={key} style={{ marginBottom: 4 }}>
              <GroupHeader
                label={g.label}
                sub={g.sub}
                agents={g.agents}
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
              />
              {expanded &&
                g.agents.map((a) => (
                  <AgentRow
                    key={a.path}
                    agent={a}
                    selected={a.path === selectedPath}
                    checked={checked.has(a.path)}
                    onSelect={() => onSelect(a.path)}
                    onToggleCheck={() => toggleCheck(a.path)}
                    onMenu={openMenu}
                  />
                ))}
            </div>
          )
        })}
      </div>

      {/* footer */}
      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: '10px 12px',
          borderTop: '1px solid var(--bd-2)'
        }}
      >
        {/* Single entry to the add-agent flow. A second control here (previously a
            "More agent options" IconButton) routed to the exact same funnel with a
            different label, so it read as two distinct actions — de-duplicated. */}
        <Button variant="primary" block onClick={onNewAgent}>
          <Icon name="plus" size={11} color="var(--tx-onaccent)" /> New agent
        </Button>
      </div>

      {menu && (
        <ContextMenu
          header={menu.agent.path.split('/').filter(Boolean).pop()}
          items={menuItems(menu.agent)}
          onClose={() => setMenu(null)}
          style={{ position: 'fixed', left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 360) }}
        />
      )}
    </div>
  )
}

export default AgentRail
