import React from 'react'
import { Button, Pill, StatusDot } from '@renderer/ui'
import {
  groupCatalog,
  transportBadge,
  type McpCatalogServer,
  type McpListEntry
} from '@renderer/lib/mcp'

/**
 * McpCatalogList — the per-agent, one-click MCP surface (the primary interaction
 * in McpEditorModal). It cross-references the CLI catalog against the workspace's
 * current `.mcp.json` entries (mcpList) and renders each server with its live
 * present/enabled state plus the right action — Add / Enable / Disable / Remove —
 * every one routed back through the parent's `onApply` → window.api.mcpApply →
 * `autodev mcp <op>` (never writeMcp).
 *
 * State model (matches the CLI):
 *   - Built-in servers default ON. If absent from .mcp.json they are still active,
 *     so we show them present+enabled with a Disable action; the CLI manages
 *     built-ins via enable/disable only (no Remove).
 *   - Common / Creative servers are present only when in .mcp.json; absent → Add.
 *   - Any entry NOT in the catalog (a custom/office server) is listed under
 *     "Other servers" with Enable/Disable/Remove.
 */

const kindActions = (
  s: McpCatalogServer,
  st: { present: boolean; enabled: boolean }
): Array<'add' | 'enable' | 'disable' | 'remove'> => {
  const builtin = s.kind === 'builtin'
  if (!st.present) return ['add']
  const acts: Array<'add' | 'enable' | 'disable' | 'remove'> = st.enabled ? ['disable'] : ['enable']
  if (!builtin) acts.push('remove')
  return acts
}

function Row({
  name,
  transport,
  description,
  experimental,
  present,
  enabled,
  actions,
  busy,
  onAct
}: {
  name: string
  transport: string
  description?: string
  experimental?: boolean
  present: boolean
  enabled: boolean
  actions: Array<'add' | 'enable' | 'disable' | 'remove'>
  busy: boolean
  onAct: (op: 'add' | 'enable' | 'disable' | 'remove') => void
}): React.JSX.Element {
  const dot = !present ? 'idle' : enabled ? 'running' : 'idle'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 11px',
        background: 'var(--bg-elev)',
        border: '1px solid var(--bd-1)',
        borderRadius: 'var(--r-card)',
        opacity: present ? 1 : 0.9
      }}
    >
      <StatusDot status={dot} size={7} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 'var(--fs-body)', fontWeight: 600, color: 'var(--tx-1)' }}>{name}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--tx-4)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-chip)', padding: '0 4px' }}>{transport}</span>
          {experimental && <Pill variant="amber" radius="chip" mono>EXPERIMENTAL</Pill>}
          {present && (
            <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', color: enabled ? 'var(--st-running)' : 'var(--tx-dim)' }}>
              {enabled ? 'enabled' : 'disabled'}
            </span>
          )}
        </div>
        {description && (
          <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-4)', marginTop: 2, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{description}</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {actions.map((a) => (
          <Button
            key={a}
            size="sm"
            variant={a === 'add' || a === 'enable' ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() => onAct(a)}
          >
            {a === 'add' ? 'Add' : a === 'enable' ? 'Enable' : a === 'disable' ? 'Disable' : 'Remove'}
          </Button>
        ))}
      </div>
    </div>
  )
}

export function McpCatalogList({
  catalog,
  current,
  busyName,
  onApply
}: {
  catalog: McpCatalogServer[]
  current: McpListEntry[]
  /** the server name currently being mutated (disables its row's buttons). */
  busyName: string | null
  onApply: (op: 'add' | 'enable' | 'disable' | 'remove', name: string, server?: McpCatalogServer['server']) => void
}): React.JSX.Element {
  const byName = React.useMemo(() => {
    const m = new Map<string, McpListEntry>()
    for (const e of current) m.set(e.name, e)
    return m
  }, [current])
  const catalogIds = React.useMemo(() => new Set(catalog.flatMap((s) => [s.id, s.name])), [catalog])
  const groups = React.useMemo(() => groupCatalog(catalog), [catalog])

  const stateFor = (s: McpCatalogServer): { present: boolean; enabled: boolean } => {
    const e = byName.get(s.id) ?? byName.get(s.name)
    if (e) return { present: true, enabled: e.enabled !== false }
    if (s.kind === 'builtin') return { present: true, enabled: true } // built-ins default ON
    return { present: false, enabled: false }
  }

  // Entries present in .mcp.json that the catalog doesn't describe (custom/office).
  const others = current.filter((e) => !catalogIds.has(e.name))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {groups.map((g) => (
        <div key={g.kind}>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--tx-4)', margin: '2px 0 6px' }}>{g.label}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {g.servers.map((s) => {
              const st = stateFor(s)
              return (
                <Row
                  key={s.id}
                  name={s.name}
                  transport={transportBadge(s)}
                  description={s.description}
                  experimental={s.experimental}
                  present={st.present}
                  enabled={st.enabled}
                  actions={kindActions(s, st)}
                  busy={busyName === s.id || busyName === s.name}
                  onAct={(op) => onApply(op, s.id, op === 'add' ? s.server : undefined)}
                />
              )
            })}
          </div>
        </div>
      ))}

      {others.length > 0 && (
        <div>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--tx-4)', margin: '2px 0 6px' }}>Other servers</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {others.map((e) => {
              const enabled = e.enabled !== false
              const transport = typeof e.url === 'string' && e.url ? 'remote' : 'stdio'
              return (
                <Row
                  key={e.name}
                  name={e.name}
                  transport={transport}
                  present
                  enabled={enabled}
                  actions={enabled ? ['disable', 'remove'] : ['enable', 'remove']}
                  busy={busyName === e.name}
                  onAct={(op) => onApply(op, e.name)}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default McpCatalogList
