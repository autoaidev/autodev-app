import React from 'react'

/**
 * Card / Panel — the bg-panel surface with a bd-card border and 8px radius used
 * for task cards, stat tiles, office cards, inspector boxes, etc.
 *
 * `selected` adds the cross-cutting left-accent inset rail (inset 2px 0 0) that
 * marks the active item everywhere in the app. `tone` washes the card with a
 * ≤7% status tint for attention rows (amber/red/green).
 */
export type CardTone = 'default' | 'amber' | 'red' | 'green'

const TONE_BG: Record<CardTone, string | undefined> = {
  default: 'var(--bg-panel)',
  amber: 'var(--st-needsyou-wash)',
  red: 'var(--st-error-wash)',
  green: 'var(--st-running-wash)'
}

const TONE_BD: Record<CardTone, string> = {
  default: 'var(--bd-nav)',
  amber: 'var(--st-needsyou-bd)',
  red: 'var(--st-error-bd)',
  green: 'var(--st-running-bd)'
}

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  selected?: boolean
  tone?: CardTone
  /** css padding shorthand (default '11px 12px') */
  pad?: string | number
  children?: React.ReactNode
}

export function Card({
  selected = false,
  tone = 'default',
  pad = '11px 12px',
  className,
  style,
  children,
  ...rest
}: CardProps): React.JSX.Element {
  return (
    <div
      className={className}
      style={{
        background: TONE_BG[tone],
        border: `1px solid ${selected ? 'var(--bd-panel-sel)' : TONE_BD[tone]}`,
        borderRadius: 'var(--r-card)',
        boxShadow: selected ? 'inset 2px 0 0 var(--accent)' : undefined,
        padding: pad,
        ...style
      }}
      {...rest}
    >
      {children}
    </div>
  )
}

export default Card
