import React from 'react'
import { Button } from '@renderer/ui'
import { useAgents } from '@renderer/services/agentStore'
import { officeCountOf } from './fleet-helpers'

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

  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
  // The hero number (agent count) is pulled out as the view's ONE focal metric, so
  // the subtitle carries only the remaining context.
  const subtitle = [
    plural(offices, 'office'),
    `${openTasks} open`,
    `${closedToday} closed today`
  ].join(' · ')

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
              color: 'var(--tx-hi)',
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
            marginTop: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-desc)',
            fontWeight: 500,
            color: 'var(--tx-dim)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {subtitle}
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
