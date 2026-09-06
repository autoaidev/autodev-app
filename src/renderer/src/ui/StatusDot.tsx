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

// Aligned to the beautifui.dev STATUS TINT INKS (theme.css --st-*-ink) so a dot and
// its StatusPill/Chip read the exact same hue for a given state, in both themes.
const COLOR: Record<DotStatus, string> = {
  running: 'var(--st-good-ink)',
  working: 'var(--st-good-ink)',
  'needs-you': 'var(--st-warn-ink)',
  stalled: 'var(--st-warn-ink)',
  'needs-auth': 'var(--st-warn-ink)',
  'rate-limited': 'var(--st-warn-ink)',
  error: 'var(--st-crit-ink)',
  crashed: 'var(--st-crit-ink)',
  idle: 'var(--st-idle)',
  stopped: 'var(--st-idle)',
  accent: 'var(--st-info-ink)'
}

// needs-you is the ONE state allowed to shout: it gets the loud glowing amber ring
// (--st-needsyou-glow) so an agent asking for you is impossible to miss, while
// running keeps a calm green halo. The soft attention aliases share the loud glow.
const GLOW: Partial<Record<DotStatus, string>> = {
  running: '0 0 0 3px rgba(78,203,156,.16)',
  working: '0 0 0 3px rgba(78,203,156,.16)',
  'needs-you': 'var(--st-needsyou-glow)',
  'needs-auth': 'var(--st-needsyou-glow)',
  'rate-limited': 'var(--st-needsyou-glow)',
  stalled: 'var(--st-needsyou-glow)',
  error: '0 0 0 3px rgba(242,117,108,.16)',
  crashed: '0 0 0 3px rgba(242,117,108,.16)'
}

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: DotStatus
  /** px diameter (default 6) */
  size?: number
  /** render the soft focus ring for the active row */
  glow?: boolean
  /** LIVE/active (working, streaming) — the dot gently breathes. Set only while
   *  the state is live; disabled under prefers-reduced-motion. */
  live?: boolean
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
  live = false,
  className,
  style,
  ...rest
}: StatusDotProps): React.JSX.Element {
  const hollow = HOLLOW.has(status)
  // Breathe only when live AND solid — a hollow idle/stopped ring never animates.
  const cls = [live && !hollow ? 'ad-live-dot' : '', className].filter(Boolean).join(' ') || undefined
  return (
    <span
      role="img"
      aria-label={status}
      className={cls}
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
