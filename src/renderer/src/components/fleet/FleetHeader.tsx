import React from 'react'
import { Button } from '@renderer/ui'

/**
 * FleetHeader — the summary-band title row: page title + a mono one-line
 * subtitle ("29 agents · 3 offices · 118 open · 37 closed today") and the two
 * fleet-wide secondary actions on the right.
 */
export interface FleetHeaderProps {
  agentCount: number
  officeCount: number
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
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
  const subtitle = [
    plural(agentCount, 'agent'),
    plural(officeCount, 'office'),
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
            fontSize: 'var(--fs-page-title)',
            fontWeight: 700,
            color: 'var(--tx-hi)',
            letterSpacing: 'var(--ls-tight)'
          }}
        >
          Fleet
        </h1>
        <div
          style={{
            marginTop: 5,
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
        <Button variant="secondary" size="sm" onClick={onStartAllIdle} disabled={busy}>
          Start all idle
        </Button>
        <Button variant="secondary" size="sm" onClick={onStopAll} disabled={busy}>
          Stop all
        </Button>
      </div>
    </div>
  )
}

export default FleetHeader
