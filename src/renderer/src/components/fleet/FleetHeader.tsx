import React from 'react'
import { Button, Icon } from '@renderer/ui'
import type { IconName } from '@renderer/ui'
import { useAgents } from '@renderer/services/agentStore'
import { officeCountOf } from './fleet-helpers'

/**
 * A compact header stat: a small hairline-tinted icon tile + a tabular number and
 * its label. Replaces the flat mono subtitle string with scannable stat cards
 * (beautifui.dev), so office / open / closed each read as a small metric.
 */
function HeaderStat({
  icon,
  value,
  label,
  tone = 'default'
}: {
  icon: IconName
  value: number
  label: string
  tone?: 'default' | 'good'
}): React.JSX.Element {
  const ink = tone === 'good' ? 'var(--st-good-ink)' : 'var(--tx-dim)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: 'var(--r-tiny)',
          background: 'var(--bg-chip-idle)',
          border: '1px solid var(--bd-1)',
          color: ink,
          flex: 'none'
        }}
      >
        <Icon name={icon} size={11} />
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-desc)',
          fontWeight: 600,
          color: 'var(--tx-1)',
          fontFeatureSettings: 'var(--fvn-tabular)'
        }}
      >
        {value.toLocaleString()}
      </span>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-desc)', color: 'var(--tx-dim)' }}>
        {label}
      </span>
    </span>
  )
}

/**
 * FleetHeader — the summary-band title row: page title + a mono one-line
 * subtitle ("29 agents · 3 offices · 118 open · 37 closed today") and the two
 * fleet-wide secondary actions on the right.
 */
export interface FleetHeaderProps {
  agentCount: number
  /**
   * Pre-computed office count from the caller. Kept for compatibility, but the
   * subtitle prefers a count DERIVED from the grouped folders/slugs of the live
   * fleet (see `officeCountOf`) — the caller's `officeSlug`-only tally reads
   * "0 offices" next to 29 folder-grouped agents, which this fixes.
   */
  officeCount?: number
  openTasks: number
  closedToday: number
  onStartAllIdle: () => void
  onStopAll: () => void
  busy?: boolean
}

export function FleetHeader({
  agentCount,
  officeCount,
  openTasks,
  closedToday,
  onStartAllIdle,
  onStopAll,
  busy = false
}: FleetHeaderProps): React.JSX.Element {
  // Derive the office count the same way the rail groups agents (subfolder/slug),
  // so it can never read "0 offices" beside a screen full of grouped agents. The
  // store is the same live snapshot the Fleet view already renders — reading it
  // here is a subscribe, not a mutation, so it's keep-alive safe.
  const fleet = useAgents()
  const derivedOffices = officeCountOf(fleet)
  const offices = derivedOffices > 0 ? derivedOffices : (officeCount ?? 0)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-section)',
            fontWeight: 700,
            letterSpacing: 'var(--ls-section)',
            textTransform: 'uppercase',
            color: 'var(--tx-4)'
          }}
        >
          Fleet
        </h1>
        {/* HERO metric — the single focal number of the Fleet view (display tier,
            mono + tabular). */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginTop: 2 }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-display)',
              fontWeight: 'var(--fw-display)',
              lineHeight: 'var(--lh-display)',
              letterSpacing: 'var(--ls-display)',
              // Colored hero — the fleet count is the ONE thing that wins the blur
              // test on this view, in the reserved in-progress accent blue.
              color: 'var(--accent)',
              fontFeatureSettings: 'var(--fvn-tabular)'
            }}
          >
            {agentCount}
          </span>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)', color: 'var(--tx-dim)' }}>
            {agentCount === 1 ? 'agent' : 'agents'}
          </span>
        </div>
        <div
          style={{
            marginTop: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            flexWrap: 'wrap'
          }}
        >
          <HeaderStat icon="office" value={offices} label={offices === 1 ? 'office' : 'offices'} />
          <HeaderStat icon="clock" value={openTasks} label="open" />
          <HeaderStat icon="check" value={closedToday} label="closed today" tone="good" />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 'none' }}>
        {/* ONE primary CTA per view — Start all idle is the accent-gradient hero;
            Stop all is demoted to ghost. */}
        <Button variant="cta" size="sm" onClick={onStartAllIdle} disabled={busy}>
          Start all idle
        </Button>
        <Button variant="ghost" size="sm" onClick={onStopAll} disabled={busy}>
          Stop all
        </Button>
      </div>
    </div>
  )
}

export default FleetHeader
