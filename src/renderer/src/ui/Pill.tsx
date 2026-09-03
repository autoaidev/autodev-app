import React from 'react'

/**
 * Pill / Chip — the small rounded label used for filters, counts, badges and
 * state pills (WORKING / LIVE / READ-ONLY). Radius is fully rounded (999) by
 * default; pass `radius="chip"` for the 5px boxed transport-badge look.
 *
 * Variants map to the palette's reserved roles:
 *   accent  — selected filter / active (soft blue)
 *   neutral — unselected filter / plain chip
 *   green / amber / red — status pills (tinted background + matching text)
 */
export type PillVariant = 'accent' | 'neutral' | 'green' | 'amber' | 'red'

interface Style {
  bg: string
  bd: string
  fg: string
}

const V: Record<PillVariant, Style> = {
  accent: { bg: 'var(--bg-accent-soft)', bd: 'var(--bd-accent)', fg: 'var(--accent-ink)' },
  // Idle/neutral is no longer dead grey: a faint WARM chip + warm ink so a STOPPED
  // pill (0/N LIVE, READ-ONLY, unselected filters) reads as resting, not disabled.
  neutral: { bg: 'var(--bg-chip-idle)', bd: 'var(--bd-1)', fg: 'var(--tx-section)' },
  green: { bg: 'var(--st-running-soft)', bd: 'var(--st-running-bd)', fg: 'var(--st-running)' },
  amber: { bg: 'var(--st-needsyou-soft)', bd: 'var(--st-needsyou-bd)', fg: 'var(--st-needsyou)' },
  red: { bg: 'var(--st-error-soft)', bd: 'var(--st-error-bd)', fg: 'var(--st-error)' }
}

export interface PillProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: PillVariant
  /** fully-rounded pill (default) or the 5px boxed chip */
  radius?: 'pill' | 'chip'
  /** monospace text (ids, counts, state) */
  mono?: boolean
  /** emphasise text weight (selected filters, state badges) */
  selected?: boolean
  children: React.ReactNode
}

export function Pill({
  variant = 'neutral',
  radius = 'pill',
  mono = false,
  selected = false,
  className,
  style,
  children,
  ...rest
}: PillProps): React.JSX.Element {
  const v = V[variant]
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: radius === 'pill' ? '4px 9px' : '2px 6px',
        borderRadius: radius === 'pill' ? 'var(--r-pill)' : 'var(--r-chip)',
        background: v.bg,
        border: `1px solid ${v.bd}`,
        color: v.fg,
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: mono ? 'var(--fs-tiny)' : 'var(--fs-desc)',
        fontWeight: selected ? 600 : mono ? 500 : 400,
        letterSpacing: mono ? 'var(--ls-state)' : undefined,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        ...style
      }}
      {...rest}
    >
      {children}
    </span>
  )
}

export default Pill
