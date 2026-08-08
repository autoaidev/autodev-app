import React from 'react'
import { StatusDot } from '@renderer/ui'
import { AgentState, ACTIVITY_LABEL, dotStatus, providerFamily } from './fleet-helpers'

/** Uppercase section label shared by all three tiles. */
function SectionLabel({
  children,
  tone = 'default',
  right
}: {
  children: React.ReactNode
  tone?: 'default' | 'amber'
  right?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        marginBottom: 11
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--fs-section)',
          fontWeight: 700,
          letterSpacing: 'var(--ls-section)',
          textTransform: 'uppercase',
          color: tone === 'amber' ? 'var(--st-needsyou)' : 'var(--tx-4)'
        }}
      >
        {children}
      </span>
      {right}
    </div>
  )
}

const tileBase: React.CSSProperties = {
  background: 'var(--bg-panel)',
  border: '1px solid var(--bd-nav)',
  borderRadius: 'var(--r-screen)',
  padding: '13px 15px'
}

/* --------------------------------- NEEDS YOU -------------------------------- */

export interface AttentionAction {
  label: string
  onClick: () => void
}

export interface NeedsYouTileProps {
  agents: AgentState[]
  actionFor: (a: AgentState) => AttentionAction
}

export function NeedsYouTile({ agents, actionFor }: NeedsYouTileProps): React.JSX.Element {
  // Empty state: collapse to a slim, non-growing reassurance strip so THROUGHPUT
  // and PROVIDERS split the freed width evenly instead of leaving half the band
  // reserved for "nothing needs you".
  if (agents.length === 0) {
    return (
      <div
        style={{
          ...tileBase,
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '10px 14px',
          border: '1px solid var(--bd-nav)',
          background: 'var(--bg-panel)'
        }}
      >
        <StatusDot status="idle" />
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-meta)',
            color: 'var(--tx-4)',
            whiteSpace: 'nowrap'
          }}
        >
          Nothing needs you right now
        </span>
      </div>
    )
  }
  return (
    <div
      style={{
        ...tileBase,
        // Dominant but capped — grows twice as fast as the two info tiles rather
        // than swallowing the whole band.
        flex: 2,
        minWidth: 0,
        border: `1px solid var(--st-needsyou-bd)`,
        background: 'var(--st-needsyou-wash)'
      }}
    >
      <SectionLabel tone="amber">
        Needs you · {agents.length}
      </SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {agents.slice(0, 4).map((a) => {
            const act = actionFor(a)
            return (
              <div
                key={a.path}
                style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}
              >
                <StatusDot status={dotStatus(a)} />
                <span
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 'var(--fs-meta)',
                    fontWeight: 600,
                    color: 'var(--tx-1)',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {a.name}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: 'var(--font-sans)',
                    fontSize: 'var(--fs-desc)',
                    color: 'var(--tx-4)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                  title={a.error || ACTIVITY_LABEL[a.activity]}
                >
                  {a.error || ACTIVITY_LABEL[a.activity]}
                </span>
                <button
                  type="button"
                  className="fleet-linkbtn"
                  style={{ fontSize: 'var(--fs-desc)', flex: 'none' }}
                  onClick={act.onClick}
                >
                  {act.label}
                </button>
              </div>
            )
          })}
          {agents.length > 4 && (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-tiny)',
                color: 'var(--tx-ghost)'
              }}
            >
              +{agents.length - 4} more below
            </div>
          )}
        </div>
    </div>
  )
}

/* -------------------------------- THROUGHPUT ------------------------------- */

export interface ThroughputTileProps {
  /** 10 sampled values (oldest → newest) of cumulative closed tasks. */
  bars: number[]
  closed: number
}

export function ThroughputTile({ bars, closed }: ThroughputTileProps): React.JSX.Element {
  const max = Math.max(1, ...bars)
  const n = bars.length
  return (
    <div style={{ ...tileBase, flex: '1 1 224px', minWidth: 200 }}>
      <SectionLabel>Throughput · 24h</SectionLabel>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 3,
          height: 34,
          marginBottom: 9
        }}
        aria-hidden
      >
        {bars.map((v, i) => {
          const recent = i >= n - 3
          const h = Math.max(3, Math.round((v / max) * 34))
          return (
            <div
              key={i}
              style={{
                flex: 1,
                height: h,
                borderRadius: 'var(--r-checkbox)',
                background: recent ? 'var(--accent)' : 'var(--bd-panel-sel)'
              }}
            />
          )
        })}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-tiny)',
          fontWeight: 500,
          color: 'var(--tx-4)'
        }}
      >
        {closed} closed
      </div>
    </div>
  )
}

/* -------------------------------- PROVIDERS ------------------------------- */

export interface ProvidersTileProps {
  agents: AgentState[]
}

export function ProvidersTile({ agents }: ProvidersTileProps): React.JSX.Element {
  const counts = new Map<string, number>()
  for (const a of agents) {
    const fam = providerFamily(a.provider)
    counts.set(fam, (counts.get(fam) ?? 0) + 1)
  }
  const rows = Array.from(counts.entries()).sort((x, y) => y[1] - x[1])

  return (
    <div style={{ ...tileBase, flex: '1 1 224px', minWidth: 200 }}>
      <SectionLabel>Providers</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {rows.length === 0 && (
          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-4)' }}>No agents</div>
        )}
        {rows.map(([fam, count]) => (
          <div
            key={fam}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-meta)',
                color: 'var(--tx-2)',
                textTransform: 'capitalize'
              }}
            >
              {fam}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-meta)',
                fontWeight: 500,
                color: 'var(--tx-hi)'
              }}
            >
              {count}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
