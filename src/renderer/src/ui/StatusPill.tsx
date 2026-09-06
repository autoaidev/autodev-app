import React from 'react'

/**
 * StatusPill — the beautifui.dev status chip: a tint-pair pill (soft tint fill +
 * ink label + an ink hairline) with a leading dot. It is the ONE consistent way to
 * render an agent's live state everywhere (Fleet STATE column, agent-card status
 * line, reauth / rate-limit badges), so the same state reads identically across
 * every surface.
 *
 * The status → variant mapping lives in the single-source domain model
 * (`services/model` → `statusVariant` / `agentStatus`), reusing the existing
 * needsUserAttention / activity buckets. This component is purely presentational:
 * pass the resolved `variant` + `label`.
 *
 * Variants map to the {ink, tint} tokens in theme.css:
 *   good   — online / working            (--st-good-*)
 *   warn   — needs-you / rate-limited     (--st-warn-*)
 *   crit   — error / interrupted          (--st-crit-*)
 *   info   — accent / awaiting-you        (--st-info-*)
 *   violet — copilot                      (--st-violet-*)
 *   neutral— idle / resting               (recedes; hollow dot)
 */
export type StatusVariant = 'good' | 'warn' | 'crit' | 'info' | 'violet' | 'neutral'

interface Tone {
  ink: string
  tint: string
}

const TONE: Record<StatusVariant, Tone> = {
  good: { ink: 'var(--st-good-ink)', tint: 'var(--st-good-tint)' },
  warn: { ink: 'var(--st-warn-ink)', tint: 'var(--st-warn-tint)' },
  crit: { ink: 'var(--st-crit-ink)', tint: 'var(--st-crit-tint)' },
  info: { ink: 'var(--st-info-ink)', tint: 'var(--st-info-tint)' },
  violet: { ink: 'var(--st-violet-ink)', tint: 'var(--st-violet-tint)' },
  // neutral recedes to the resting-chip surface + section ink (not a shouting hue).
  neutral: { ink: 'var(--tx-section)', tint: 'var(--bg-chip-idle)' }
}

// A crisp hairline derived from the ink, so a pill reads as tint-fill + ink-text +
// ink-hairline (the beautifui.dev elevation is hairline, not a heavy border).
const hairline = (ink: string): string => `color-mix(in srgb, ${ink} 34%, transparent)`

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant: StatusVariant
  label: React.ReactNode
  /** show the leading state dot (default true) */
  dot?: boolean
  /** monospace, letter-spaced uppercase state label (default true) */
  mono?: boolean
  /** compact (sm) vs default (md) sizing */
  size?: 'sm' | 'md'
  /**
   * LIVE/active state (working, streaming) — the leading dot gently breathes to
   * convey "active right now". Callers set this ONLY while the state is live (e.g.
   * activity === 'working'); it MUST be false at rest so the motion stops the
   * instant the agent is idle/stopped/error. Honoured off under prefers-reduced-motion.
   */
  live?: boolean
}

export function StatusPill({
  variant,
  label,
  dot = true,
  mono = true,
  size = 'md',
  live = false,
  className,
  style,
  ...rest
}: StatusPillProps): React.JSX.Element {
  const t = TONE[variant]
  const neutral = variant === 'neutral'
  const sm = size === 'sm'
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        // Content-sized: hug the label, never stretch to fill a grid/flex cell. A
        // grid item defaults to justify-self:stretch — fit-content + justify-self:start
        // keep the pill exactly as wide as its text, left-aligned (Fleet STATE column,
        // office cards). maxWidth:100% still guards a pathologically narrow cell.
        width: 'fit-content',
        maxWidth: '100%',
        justifySelf: 'start',
        gap: sm ? 5 : 6,
        padding: sm ? '2px 8px' : '3px 10px',
        borderRadius: 'var(--r-pill)',
        background: t.tint,
        border: `1px solid ${neutral ? 'var(--bd-1)' : hairline(t.ink)}`,
        color: t.ink,
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: sm ? 'var(--fs-micro)' : 'var(--fs-tiny)',
        fontWeight: mono ? 600 : 600,
        letterSpacing: mono ? 'var(--ls-state)' : undefined,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        ...style
      }}
      {...rest}
    >
      {dot && (
        <span
          aria-hidden
          // Breathe only when live AND the state is a solid (non-neutral) dot —
          // an idle/resting hollow ring never animates.
          className={live && !neutral ? 'ad-live-dot' : undefined}
          style={{
            width: sm ? 5 : 6,
            height: sm ? 5 : 6,
            borderRadius: '50%',
            flex: 'none',
            // Non-hue redundancy: neutral/resting renders a HOLLOW ring, live
            // states a SOLID ink dot — state stays legible by shape in greyscale.
            background: neutral ? 'transparent' : t.ink,
            boxShadow: neutral ? 'inset 0 0 0 1.5px var(--tx-faint)' : undefined
          }}
        />
      )}
      {label}
    </span>
  )
}

export default StatusPill
