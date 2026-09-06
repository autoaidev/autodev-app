import React from 'react'
import { providerHue } from '@renderer/services/identity'

/**
 * Chip — the beautifui.dev compact pill for identity metadata: ids, tool/provider
 * names, model labels, counts. Smaller and quieter than a StatusPill (which is
 * reserved for live STATE). A `provider` chip is tinted with the provider's BRAND
 * hue from the single `--prov-*` map (claude=coral · grok=violet · opencode=teal ·
 * copilot=magenta — see services/identity `providerHue`), the SAME hue the avatar
 * ring / ProviderChip use, so "which tool" reads in colour at a glance and can
 * never be confused with a semantic state colour.
 *
 * Variants:
 *   neutral  — plain metadata chip (resting surface)
 *   provider — provider hue tint (pass `provider`)
 *   good/warn/crit/info/violet — explicit status-hue tint
 */
export type ChipVariant = 'neutral' | 'provider' | 'good' | 'warn' | 'crit' | 'info' | 'violet'

interface Tone {
  ink: string
  tint: string
}

const TONE: Record<Exclude<ChipVariant, 'provider' | 'neutral'>, Tone> = {
  good: { ink: 'var(--st-good-ink)', tint: 'var(--st-good-tint)' },
  warn: { ink: 'var(--st-warn-ink)', tint: 'var(--st-warn-tint)' },
  crit: { ink: 'var(--st-crit-ink)', tint: 'var(--st-crit-tint)' },
  info: { ink: 'var(--st-info-ink)', tint: 'var(--st-info-tint)' },
  violet: { ink: 'var(--st-violet-ink)', tint: 'var(--st-violet-tint)' }
}

const NEUTRAL: Tone = { ink: 'var(--tx-section)', tint: 'var(--bg-chip-idle)' }

const hairline = (ink: string): string => `color-mix(in srgb, ${ink} 30%, transparent)`

function toneFor(variant: ChipVariant, provider?: string): { tone: Tone; neutral: boolean } {
  if (variant === 'neutral') return { tone: NEUTRAL, neutral: true }
  if (variant === 'provider') {
    // Provider colour comes straight from the --prov-* brand map (severed from the
    // semantic --st-* palette) so it reads as "which tool", never as a state.
    const t = providerHue(provider)
    if (t.neutral) return { tone: NEUTRAL, neutral: true }
    return { tone: { ink: t.ink, tint: t.tint }, neutral: false }
  }
  return { tone: TONE[variant], neutral: false }
}

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: ChipVariant
  /** provider id (grok-tui / claude-cli / …) when variant="provider" */
  provider?: string
  /** monospace text — for ids / tool names / counts */
  mono?: boolean
  /** optional leading node (icon / dot) */
  leading?: React.ReactNode
  children: React.ReactNode
}

export function Chip({
  variant = 'neutral',
  provider,
  mono = false,
  leading,
  className,
  style,
  children,
  ...rest
}: ChipProps): React.JSX.Element {
  const { tone, neutral } = toneFor(variant, provider)
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        // Content-sized: hug the text, never stretch to fill a grid/flex cell
        // (a grid item defaults to justify-self:stretch). fit-content + justify-self:start
        // keep a provider/model/id chip exactly as wide as its label, left-aligned.
        width: 'fit-content',
        maxWidth: '100%',
        justifySelf: 'start',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 'var(--r-pill)',
        background: tone.tint,
        border: `1px solid ${neutral ? 'var(--bd-1)' : hairline(tone.ink)}`,
        color: tone.ink,
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: 'var(--fs-micro)',
        fontWeight: 600,
        letterSpacing: mono ? 'var(--ls-state)' : undefined,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        ...style
      }}
      {...rest}
    >
      {leading}
      {children}
    </span>
  )
}

export default Chip
