import React from 'react'

/**
 * FleetStatusBar — the 30px bottom bar. Left: selection count (accent-ink) +
 * bulk-action verbs (active only when a selection exists). Right: the
 * "showing N of M" mono readout.
 */
export interface BulkVerb {
  label: string
  onClick: () => void
}

export interface FleetStatusBarProps {
  selectedCount: number
  verbs: BulkVerb[]
  showing: number
  total: number
}

export function FleetStatusBar({
  selectedCount,
  verbs,
  showing,
  total
}: FleetStatusBarProps): React.JSX.Element {
  const hasSel = selectedCount > 0
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        height: 'var(--h-statusbar)',
        flex: 'none',
        padding: '0 22px',
        background: 'var(--bg-topbar)',
        borderTop: '1px solid var(--bd-nav)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-desc)',
            fontWeight: 500,
            color: hasSel ? 'var(--accent-ink)' : 'var(--tx-dim)'
          }}
        >
          {selectedCount} selected
        </span>
        {hasSel &&
          verbs.map((v) => (
            <button
              key={v.label}
              type="button"
              onClick={v.onClick}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-desc)',
                fontWeight: 600,
                color: 'var(--tx-2)'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--tx-hi)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--tx-2)')}
            >
              {v.label}
            </button>
          ))}
      </div>

      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-desc)',
          color: 'var(--tx-dim)',
          whiteSpace: 'nowrap',
          flex: 'none'
        }}
      >
        showing {showing} of {total}
      </span>
    </div>
  )
}

export default FleetStatusBar
