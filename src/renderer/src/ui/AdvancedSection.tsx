import React from 'react'
import { Icon } from './Icon'
import { useAdvancedMode } from '@renderer/services/advancedMode'

/**
 * AdvancedSection — the shared "Advanced ▸" disclosure used to group expert
 * controls inside modals under the DECLUTTER disclosure contract.
 *
 * It is ALWAYS present (never removed from the DOM), so the controls it wraps are
 * reachable even in Basic mode: one click on the header opens them. When the
 * app-wide Advanced flag is ON the section defaults to expanded (and re-expands
 * if the flag is flipped on while the modal is open); when OFF it defaults
 * collapsed but still opens in a single click. The user can also fold/unfold it
 * locally regardless of the flag.
 *
 * Purely presentational chrome (tokens only) — the guarding decision (hide vs.
 * collapse) lives in each caller; this component only provides the collapse.
 */
export interface AdvancedSectionProps {
  /** Header label. Defaults to "Advanced". */
  label?: string
  /** Optional one-line hint shown under the label when expanded. */
  hint?: string
  children: React.ReactNode
  style?: React.CSSProperties
}

export function AdvancedSection({
  label = 'Advanced',
  hint,
  children,
  style
}: AdvancedSectionProps): React.JSX.Element {
  const { advanced } = useAdvancedMode()
  const [open, setOpen] = React.useState(advanced)
  // Follow the app-wide flag: turning Advanced ON expands every open modal's
  // section (the "defaults expanded" contract); turning it OFF collapses them.
  React.useEffect(() => {
    setOpen(advanced)
  }, [advanced])

  return (
    <div style={{ borderTop: '1px solid var(--bd-card)', marginTop: 4, paddingTop: 10, ...style }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          width: '100%',
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          padding: '2px 0',
          cursor: 'pointer',
          color: 'var(--tx-3)'
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 12,
            height: 12,
            flex: 'none',
            color: 'var(--tx-3)',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform .12s ease'
          }}
        >
          <Icon name="caret" size={10} />
        </span>
        <span
          style={{
            fontSize: 'var(--fs-section)',
            fontWeight: 600,
            letterSpacing: 'var(--ls-section)',
            textTransform: 'uppercase',
            color: 'var(--tx-dim)'
          }}
        >
          {label}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          {hint && (
            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginBottom: 10 }}>{hint}</div>
          )}
          {children}
        </div>
      )}
    </div>
  )
}

export default AdvancedSection
