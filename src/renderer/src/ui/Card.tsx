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
  // A default card gets the top-lit CARD gradient; a toned (attention) card keeps
  // its flat status wash. Either way it now LIFTS off the surface behind it with
  // the composite card depth (inset top-highlight + drop shadow) — the same
  // reference elevation StatTiles established — so panels read as raised objects
  // instead of one flat sheet. `selected` prepends the cross-cutting accent rail.
  const depth = selected ? 'inset 2px 0 0 var(--accent), var(--depth-card)' : 'var(--depth-card)'
  return (
    <div
      className={className}
      style={{
        background: tone === 'default' ? 'var(--grad-card)' : TONE_BG[tone],
        border: `1px solid ${selected ? 'var(--bd-panel-sel)' : TONE_BD[tone]}`,
        borderRadius: 'var(--r-card)',
        boxShadow: depth,
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
