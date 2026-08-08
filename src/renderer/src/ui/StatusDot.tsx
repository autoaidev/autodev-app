import React from 'react'

/**
 * StatusDot — the 5-6px state dot used everywhere a row/card carries live state.
 * Colour is reserved strictly for state (green running, amber needs-you, red
 * error, grey idle). `glow` adds the soft ring shown on the focused/active row.
 */
export type DotStatus =
  | 'running'
  | 'needs-you'
  | 'error'
  | 'idle'
  | 'accent'
  // AgentState.Activity aliases so callers can pass activity straight through:
  | 'working'
  | 'stalled'
  | 'needs-auth'
  | 'rate-limited'
  | 'crashed'
  | 'stopped'

const COLOR: Record<DotStatus, string> = {
  running: 'var(--st-running)',
  working: 'var(--st-running)',
  'needs-you': 'var(--st-needsyou)',
  stalled: 'var(--st-needsyou)',
  'needs-auth': 'var(--st-needsyou)',
  'rate-limited': 'var(--st-needsyou)',
  error: 'var(--st-error)',
  crashed: 'var(--st-error)',
  idle: 'var(--st-idle)',
  stopped: 'var(--st-idle)',
  accent: 'var(--accent)'
}

const GLOW: Partial<Record<DotStatus, string>> = {
  running: '0 0 0 3px rgba(70,177,123,.16)',
  working: '0 0 0 3px rgba(70,177,123,.16)',
  'needs-you': '0 0 0 3px rgba(216,165,74,.16)',
  error: '0 0 0 3px rgba(224,106,92,.16)'
}

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: DotStatus
  /** px diameter (default 6) */
  size?: number
  /** render the soft focus ring for the active row */
  glow?: boolean
}

// Non-hue redundancy (a11y): idle/stopped agents render as a HOLLOW ring while
// live states (running/needs-you/error/accent) render as a SOLID dot. State is
// then distinguishable by SHAPE, not colour alone — survives colour-blindness,
// greyscale, and a washed-out projector.
const HOLLOW = new Set<DotStatus>(['idle', 'stopped'])

export function StatusDot({
  status,
  size = 6,
  glow = false,
  className,
  style,
  ...rest
}: StatusDotProps): React.JSX.Element {
  const hollow = HOLLOW.has(status)
  return (
    <span
      role="img"
      aria-label={status}
      className={className}
      style={{
        display: 'inline-block',
        flex: 'none',
        width: size,
        height: size,
        borderRadius: '50%',
        background: hollow ? 'transparent' : COLOR[status],
        boxShadow: hollow
          ? 'inset 0 0 0 1.5px var(--tx-faint)'
          : glow
            ? GLOW[status]
            : undefined,
        ...style
      }}
      {...rest}
    />
  )
}

export default StatusDot
