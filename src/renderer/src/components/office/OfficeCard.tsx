import React from 'react'
import { Pill, Button } from '@renderer/ui'
import { identityTokens } from '@renderer/services/identity'
import { useAdvancedMode } from '@renderer/services/advancedMode'
import { OfficeGroup, tickFor, TickState } from './officeTypes'

/**
 * OfficeCard — one office in the 282px rail (2c).
 *
 * Shows the office name, a LIVE badge (`8/12 LIVE`), one 4px segment tick per
 * character (green live / amber needs-you / grey not-connected), and footer
 * half-buttons. Selected card = accent border + inset blue rail.
 */

// Live/needs-you carry STATE color; an idle seat is no longer dead grey — it
// takes the character's own IDENTITY hue (muted tile bg), so an office at rest
// still shows a row of distinct colored seats instead of a grey ladder.
const STATE_TICK: Record<Exclude<TickState, 'idle'>, string> = {
  live: 'var(--st-running)',
  'needs-you': 'var(--st-needsyou)'
}
function tickColor(state: TickState, id: string): string {
  return state === 'idle' ? identityTokens(id).bg : STATE_TICK[state]
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
  // Basic keeps the card to name + LIVE + ONE button: the per-character rainbow tick
  // strip is dropped (the LIVE count already conveys it) and "Open map" leaves the
  // footer (it lives in the selected office's detail header as "Open in browser").
  // Advanced restores both.
  const { advanced } = useAdvancedMode()

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
        padding: 'var(--pad-card)',
        borderRadius: 'var(--r-card)',
        // Lifted card (top-lit gradient + composite depth) so the office reads as a
        // raised object on the rail. At rest it carries a per-office identity hue on
        // its left edge (inset rail); selected swaps in the accent rail.
        background: 'var(--grad-card)',
        border: `1px solid ${selected ? 'var(--bd-panel-sel)' : 'var(--bd-card)'}`,
        boxShadow: selected
          ? 'inset 2px 0 0 var(--accent), var(--depth-card)'
          : `inset 3px 0 0 ${identityTokens(group.slug).fg}, var(--depth-card)`,
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

      {/* per-character segment ticks — Advanced only (the LIVE count conveys it) */}
      {advanced && (
        <div style={{ display: 'flex', gap: 3 }} aria-hidden>
          {group.agents.map((a) => (
            <span
              key={a.id}
              title={`${a.name} — ${tickFor(a)}`}
              style={{
                flex: 1,
                height: 4,
                borderRadius: 'var(--r-bar)',
                background: tickColor(tickFor(a), a.id)
              }}
            />
          ))}
          {total === 0 && (
            <span style={{ flex: 1, height: 4, borderRadius: 'var(--r-bar)', background: 'var(--st-track)' }} />
          )}
        </div>
      )}

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
        {/* "Open map" — Advanced only; in Basic the office's detail header carries the
            equivalent "Open in browser", so the card stays to ONE primary action. */}
        {advanced && (
          <Button variant="secondary" size="sm" block onClick={onOpenBrowser} title="Open this office in your browser">
            Open map
          </Button>
        )}
      </div>
    </div>
  )
}

export default OfficeCard
