import React from 'react'
import { Pill, Button, Icon } from '@renderer/ui'
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
  /** Office agent ids that are actively WORKING right now (merged local + office
   *  signal from OfficeView). Their rail segment tick breathes in the running hue so
   *  the rail — not just the open office — shows something is happening. */
  workingIds?: ReadonlySet<string>
  /** The office has live characters but NONE are managed from this app (no local
   *  session, and same-host loop discovery matched none) — a neutral hint that it's
   *  watch-only here (not an assertion it's on another machine), so the user isn't
   *  surprised its characters can't be operated from this app. */
  liveElsewhere?: boolean
}

export function OfficeCard({
  group,
  selected,
  running,
  busy,
  onSelect,
  onSpawn,
  onStop,
  onOpenBrowser,
  workingIds,
  liveElsewhere = false
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

      {/* Online here, but none of this office's live characters are managed from this
          app (no local session, and same-host loop discovery matched none) — a quiet,
          neutral hint that it's watch-only from this PC (NOT an assertion it's on
          another machine). */}
      {liveElsewhere && (
        <div
          title="Online, but not managed from this app — watch-only here"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}
        >
          <Icon name="external" size={10} /> online · not managed here
        </div>
      )}

      {/* per-character segment ticks — Advanced only (the LIVE count conveys it) */}
      {advanced && (
        <div style={{ display: 'flex', gap: 3 }} aria-hidden>
          {group.agents.map((a) => {
            const working = !!workingIds?.has(a.id)
            const state = tickFor(a)
            return (
              <span
                key={a.id}
                title={`${a.name} — ${working ? 'working' : state}`}
                // A working seat breathes in the running hue (ad-live-dot, auto-stilled
                // under prefers-reduced-motion); otherwise the plain state tick.
                className={working ? 'ad-live-dot' : undefined}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 'var(--r-bar)',
                  background: working ? 'var(--st-running)' : tickColor(state, a.id)
                }}
              />
            )
          })}
          {total === 0 && (
            <span style={{ flex: 1, height: 4, borderRadius: 'var(--r-bar)', background: 'var(--st-track)' }} />
          )}
        </div>
      )}

      {/* footer half-buttons — BOTH show by state (mirrors OfficeView's header, the
          0.3.48 both-buttons fix): a running office can still spawn its offline
          characters, so "Spawn" is disabled only by the spawning-busy state, never
          by online>0. onSpawn already filters to offline agents. */}
      {/* WRAP + ~50% flex basis so the buttons never overflow the narrow sidebar:
          a lone button grows to fill the row, two split it 50/50, and a third
          ("Open map" in Advanced) wraps to a second line instead of being clipped.
          minWidth:0 lets each button's label shrink rather than push past the card. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} onClick={(e) => e.stopPropagation()}>
        {/* Stop + Spawn operate on loops running on THIS machine. When the office is
            online but not managed from this app (liveElsewhere), it's watch-only here
            — hide both so you can't try to stop or double-spawn an office this app
            doesn't run. A fully-offline office has liveElsewhere=false, so "Spawn
            office" to start it locally still shows. */}
        {running && !liveElsewhere && (
          <div style={{ flex: '1 1 calc(50% - 3px)', minWidth: 0 }}>
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
          </div>
        )}
        {online < total && !liveElsewhere && (
          <div style={{ flex: '1 1 calc(50% - 3px)', minWidth: 0 }}>
            <Button
              variant="primary"
              size="sm"
              block
              disabled={busy === 'spawning'}
              onClick={onSpawn}
              title={
                online > 0
                  ? `Start the ${total - online} offline character${total - online === 1 ? '' : 's'} in this office as tracked loops`
                  : 'Start every character in this office as a tracked loop'
              }
            >
              {busy === 'spawning' ? 'Spawning…' : online > 0 ? `Spawn ${total - online} more` : 'Spawn office'}
            </Button>
          </div>
        )}
        {/* "Open map" — Advanced only; in Basic the office's detail header carries the
            equivalent "Open in browser", so the card stays to ONE primary action. */}
        {advanced && (
          <div style={{ flex: '1 1 calc(50% - 3px)', minWidth: 0 }}>
            <Button variant="secondary" size="sm" block onClick={onOpenBrowser} title="Open this office in your browser">
              Open map
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

export default OfficeCard
