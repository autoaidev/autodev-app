import React from 'react'
import { Icon } from '@renderer/ui'

/**
 * NativeSelect — the SINGLE flat-select chrome shared by the model picker
 * (ModelSelect) and the Engine dropdown (AgentConfigModal). A bare
 * `appearance:none` <select> reads as a read-only text box, so this wraps the
 * native control with a trailing chevron and a hover/focus accent border so it
 * is obviously a dropdown. It stays a real <select> (native option menu,
 * keyboard + a11y intact) — only the resting/hover/focus skin is ours.
 */
export interface NativeSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Denser padding + smaller type for inline rows (the Inspector's Model row). */
  compact?: boolean
}

export function NativeSelect({ compact, style, children, onFocus, onBlur, onMouseEnter, onMouseLeave, ...rest }: NativeSelectProps): React.JSX.Element {
  // Border lights up on hover OR focus so the control invites a click at rest and
  // reads as focused while open. mouseleave keeps the border while still focused.
  const [active, setActive] = React.useState(false)

  const s: React.CSSProperties = {
    width: '100%',
    appearance: 'none',
    cursor: 'pointer',
    background: 'var(--bg-input)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--bd-1)'}`,
    borderRadius: 'var(--r-input)',
    color: 'var(--tx-1)',
    fontFamily: 'var(--font-sans)',
    fontSize: compact ? 'var(--fs-meta)' : 'var(--fs-body)',
    // extra right padding leaves room for the caret so a long label never runs under it
    padding: compact ? '4px 22px 4px 7px' : '7px 26px 7px 9px',
    outline: 'none',
    transition: 'border-color .12s ease',
    ...style
  }

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <select
        {...rest}
        style={s}
        onFocus={(e) => { setActive(true); onFocus?.(e) }}
        onBlur={(e) => { setActive(false); onBlur?.(e) }}
        onMouseEnter={(e) => { setActive(true); onMouseEnter?.(e) }}
        onMouseLeave={(e) => { if (document.activeElement !== e.currentTarget) setActive(false); onMouseLeave?.(e) }}
      >
        {children}
      </select>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          right: compact ? 8 : 10,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          alignItems: 'center',
          pointerEvents: 'none'
        }}
      >
        <Icon name="chevron" size={compact ? 9 : 10} color="var(--tx-4)" />
      </span>
    </div>
  )
}

export default NativeSelect
