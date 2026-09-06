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
        minHeight: 'var(--h-statusbar)',
        flex: 'none',
        padding: '5px 22px',
        // Selection turns the bar into a tinted ACTION bar (accent tint + accent
        // hairline top) that reads as "N selected — act on them"; with nothing
        // selected it recedes to the plain chrome status bar.
        background: hasSel ? 'var(--accent-tint)' : 'var(--bg-topbar)',
        borderTop: `1px solid ${hasSel ? 'var(--bd-accent)' : 'var(--bd-nav)'}`,
        transition: 'background .12s ease'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-desc)',
            fontWeight: 600,
            letterSpacing: 'var(--ls-state)',
            fontFeatureSettings: 'var(--fvn-tabular)',
            color: hasSel ? 'var(--accent-ink)' : 'var(--tx-dim)'
          }}
        >
          {selectedCount} selected
        </span>
        {hasSel &&
          verbs.map((v) => {
            const danger = /stop/i.test(v.label)
            return (
              <button
                key={v.label}
                type="button"
                onClick={v.onClick}
                style={{
                  background: 'transparent',
                  border: `1px solid ${danger ? 'var(--st-error-bd)' : 'var(--bd-accent)'}`,
                  borderRadius: 'var(--r-pill)',
                  padding: '3px 11px',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 'var(--fs-desc)',
                  fontWeight: 600,
                  color: danger ? 'var(--st-error)' : 'var(--accent-ink)',
                  transition: 'background .12s ease'
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = danger
                    ? 'var(--st-error-soft)'
                    : 'var(--bg-accent-soft)')
                }
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {v.label}
              </button>
            )
          })}
      </div>

      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-desc)',
          color: 'var(--tx-dim)',
          whiteSpace: 'nowrap',
          flex: 'none',
          fontFeatureSettings: 'var(--fvn-tabular)'
        }}
      >
        showing {showing} of {total}
      </span>
    </div>
  )
}

export default FleetStatusBar
