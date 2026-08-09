/**
 * services/identity.ts — the SINGLE source for per-agent COLOR IDENTITY and
 * per-provider ACCENTS in the renderer.
 *
 * This is the de-monotony "color with meaning" layer: it turns 29 identical grey
 * rows into recognizable colored objects and answers "which tool" at a glance.
 * It is intentionally pure (no React, no window.api) and reuses what already
 * exists rather than inventing a parallel scheme:
 *   - `initials()` is re-exported from the office identity system (officeTypes),
 *     the SAME helper CharacterCard uses on the office side — one initials rule
 *     app-wide.
 *   - the hue tiles resolve to the `--id-1..8` palette tokens in theme.css
 *     (--id-1/--id-2 ARE the existing role blue/violet), so the avatar tiles are
 *     an EXTENSION of the office role colors, not a second palette.
 *   - the provider accents resolve to the `--prov-*` tokens in theme.css.
 *
 * Color is deployed with MEANING: the hue tile = stable per-agent IDENTITY, the
 * ring/chip = PROVIDER, and STATE color is layered on top separately (spine /
 * dot) so identity and state never collide.
 */
import { providerFamily } from './model'
import { initials } from '@renderer/components/office/officeTypes'

export { initials }

/* ------------------------------------------------------------- identity hue -- */

/** How many identity hue tiles exist in the palette (theme.css --id-1..8). */
export const IDENTITY_HUES = 8

/**
 * Deterministic 1..IDENTITY_HUES bucket for a stable key (an agent's workspace
 * path, or an office character id). Same key → same hue for the life of the app,
 * so a given agent is the SAME color in the rail, the Fleet table, and its detail
 * header. A djb2-style hash keeps the distribution even across short slug keys.
 */
export function identityHue(key: string): number {
  const s = String(key ?? '')
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return (h % IDENTITY_HUES) + 1
}

export interface IdentityTokens {
  /** tile background var, e.g. `var(--id-3-bg)` */
  bg: string
  /** tile foreground (initials) var, e.g. `var(--id-3-fg)` */
  fg: string
  /** the 1..8 index (exposed for callers that want the raw bucket) */
  index: number
}

/** Resolve a stable key to its `--id-N-bg` / `--id-N-fg` token pair. */
export function identityTokens(key: string): IdentityTokens {
  const index = identityHue(key)
  return { bg: `var(--id-${index}-bg)`, fg: `var(--id-${index}-fg)`, index }
}

/* ---------------------------------------------------------- provider accent -- */

export type ProviderFamily = 'claude' | 'grok' | 'opencode' | 'copilot' | 'unknown'

/** The four first-class providers, in a stable display order. */
export const PROVIDER_FAMILIES: Exclude<ProviderFamily, 'unknown'>[] = [
  'claude',
  'grok',
  'opencode',
  'copilot'
]

const PROVIDER_LABEL: Record<ProviderFamily, string> = {
  claude: 'Claude',
  grok: 'Grok',
  opencode: 'OpenCode',
  copilot: 'Copilot',
  unknown: 'Local'
}

export interface ProviderAccent {
  family: ProviderFamily
  /** canonical display label (Claude / Grok / OpenCode / Copilot / Local) */
  label: string
  /** brand hue — spine / avatar-ring / dot (graphical, ≥3:1): `var(--prov-*)` */
  fg: string
  /** lightened label text, AA on the matching tint chip: `var(--prov-*-ink)` */
  ink: string
  /** chip / wash background: `var(--prov-*-tint)` */
  tint: string
  /** tinted avatar-ring stroke: `var(--prov-*-ring)` */
  ring: string
}

/** Neutral accent for an unknown / local provider — never a colored brand hue,
 *  so "which tool" color stays truthful (grey = we don't know the tool). */
const NEUTRAL_ACCENT: ProviderAccent = {
  family: 'unknown',
  label: PROVIDER_LABEL.unknown,
  fg: 'var(--tx-4)',
  ink: 'var(--tx-3)',
  tint: 'var(--bg-input)',
  ring: 'var(--bd-1)'
}

/** Coerce any provider id (`grok-tui`, `claude-cli`, `opencode`, …) to a family. */
export function providerFamilyOf(provider?: string): ProviderFamily {
  const fam = providerFamily(provider)
  return (PROVIDER_FAMILIES as string[]).includes(fam) ? (fam as ProviderFamily) : 'unknown'
}

/** The provider accent token bundle for a provider id (neutral when unknown). */
export function providerAccent(provider?: string): ProviderAccent {
  const family = providerFamilyOf(provider)
  if (family === 'unknown') return NEUTRAL_ACCENT
  return {
    family,
    label: PROVIDER_LABEL[family],
    fg: `var(--prov-${family})`,
    ink: `var(--prov-${family}-ink)`,
    tint: `var(--prov-${family}-tint)`,
    ring: `var(--prov-${family}-ring)`
  }
}

/** Canonical provider display label for any provider id. */
export function providerDisplayLabel(provider?: string): string {
  return PROVIDER_LABEL[providerFamilyOf(provider)]
}
