import React from 'react'
import { Pill, Button } from '@renderer/ui'
import { OfficeGroup, tickFor, TickState } from './officeTypes'

/**
 * OfficeCard — one office in the 282px rail (2c).
 *
 * Shows the office name, a LIVE badge (`8/12 LIVE`), one 4px segment tick per
 * character (green live / amber needs-you / grey not-connected), and footer
 * half-buttons. Selected card = accent border + inset blue rail.
 */

const TICK_COLOR: Record<TickState, string> = {
  live: 'var(--st-running)',
  'needs-you': 'var(--st-needsyou)',
  idle: 'var(--st-track)'
}

export interface OfficeCardProps {
  group: OfficeGroup
  selected: boolean
  running: boolean
  busy: '' | 'spawning' | 'stopping'
  onSelect: () => void
  onSpawn: () => void
  onStop: () => void
  onOpenBrowser: () => void
}

export function OfficeCard({
  group,
  selected,
  running,
  busy,
  onSelect,
  onSpawn,
  onStop,
  onOpenBrowser
}: OfficeCardProps): React.JSX.Element {
  const total = group.agents.length
  const online = group.onlineCount
  // 8/12 green · 2/12 amber (partial) · 0/5 grey (none) — per spec.
  const badgeVariant = online === 0 ? 'neutral' : online >= total ? 'green' : 'amber'

  return (
    <div
      onClick={onSelect}
      role="button"
      aria-pressed={selected}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
        padding: '11px 12px',
        borderRadius: 'var(--r-card)',
        background: 'var(--bg-panel)',
        border: `1px solid ${selected ? 'var(--bd-panel-sel)' : 'var(--bd-nav)'}`,
        boxShadow: selected ? 'inset 2px 0 0 var(--accent)' : undefined,
        cursor: 'pointer'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 'var(--fs-office-label)',
            fontWeight: 700,
            color: selected ? 'var(--tx-hi)' : 'var(--tx-1)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {group.name}
        </div>
        <Pill variant={badgeVariant} mono>
          {online}/{total} LIVE
        </Pill>
      </div>

      {/* per-character segment ticks */}
      <div style={{ display: 'flex', gap: 3 }} aria-hidden>
        {group.agents.map((a) => (
          <span
            key={a.id}
            title={`${a.name} — ${tickFor(a)}`}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 'var(--r-bar)',
              background: TICK_COLOR[tickFor(a)]
            }}
          />
        ))}
        {total === 0 && (
          <span style={{ flex: 1, height: 4, borderRadius: 'var(--r-bar)', background: 'var(--st-track)' }} />
        )}
      </div>

      {/* footer half-buttons */}
      <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
        {running ? (
          <Button
            variant="secondary"
            size="sm"
            danger
            block
            disabled={busy === 'stopping'}
            onClick={onStop}
            title="Stop every tracked loop in this office"
          >
            {busy === 'stopping' ? 'Stopping…' : 'Stop office'}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            block
            disabled={busy === 'spawning' || online > 0}
            onClick={onSpawn}
            title={
              online > 0
                ? 'Blocked — some characters are already online'
                : 'Start every character in this office as a tracked loop'
            }
          >
            {busy === 'spawning' ? 'Spawning…' : 'Spawn office'}
          </Button>
        )}
        <Button variant="secondary" size="sm" block onClick={onOpenBrowser} title="Open this office in your browser">
          Open map
        </Button>
      </div>
    </div>
  )
}

export default OfficeCard
