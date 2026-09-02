/**
 * providers.ts — the SINGLE source of provider vocabulary for the app.
 *
 * Before this, the provider list + model-key mapping + slugify helper were
 * copy-pasted (and DRIFTED) across MakeAppView, SpawnTeamModal, SettingsView2,
 * FleetView and AgentConfigModal — "OpenCode — headless" vs "OpenCode — CLI" vs
 * "OpenCode — SDK" for the same id. This module is the one place they agree.
 *
 * A provider id is `<vendor>-<variant>` (e.g. `claude-tui`, `opencode-cli`) and
 * is what the CLI's `-p`/`--provider` flag consumes. The per-vendor model config
 * key (`claudeModel`, `grokModel`, …) is what `autodev config set` writes.
 */

import { useEffect, useState } from 'react'

export interface ProviderOption {
  id: string
  label: string
}
export interface ProviderGroup {
  vendor: string
  options: ProviderOption[]
}

/** The canonical grouped provider list (vendor → interactive/headless/SDK variants). */
export const PROVIDER_GROUPS: ProviderGroup[] = [
  {
    vendor: 'Claude',
    options: [
      { id: 'claude-tui', label: 'Claude — interactive' },
      { id: 'claude-cli', label: 'Claude — headless CLI' }
    ]
  },
  {
    vendor: 'GitHub Copilot',
    options: [
      { id: 'copilot-cli', label: 'Copilot — CLI' },
      { id: 'copilot-sdk', label: 'Copilot — SDK' }
    ]
  },
  {
    vendor: 'OpenCode',
    options: [
      { id: 'opencode-cli', label: 'OpenCode — CLI' },
      { id: 'opencode-sdk', label: 'OpenCode — SDK' }
    ]
  },
  {
    vendor: 'Grok',
    options: [
      { id: 'grok-cli', label: 'Grok — CLI' },
      { id: 'grok-tui', label: 'Grok — interactive' }
    ]
  }
]

/** Flat list of every provider id (for validation / lookups). */
export const ALL_PROVIDER_IDS: string[] = PROVIDER_GROUPS.flatMap((g) => g.options.map((o) => o.id))

/** Human label for a provider id, falling back to the id itself. */
export function providerLabel(id: string): string {
  for (const g of PROVIDER_GROUPS) {
    const o = g.options.find((x) => x.id === id)
    if (o) return o.label
  }
  return id
}

/** The vendor (`claude`, `grok`, `opencode`, `copilot`) for a provider id. */
export const vendorOf = (p: string): string => p.split('-')[0]

/** Per-vendor `autodev config set` model key. */
export const MODEL_KEY: Record<string, string> = {
  claude: 'claudeModel',
  opencode: 'opencodeModel',
  copilot: 'copilotModel',
  grok: 'grokModel'
}
export const modelKeyFor = (p: string): string => MODEL_KEY[vendorOf(p)] ?? 'claudeModel'

/**
 * Suggested model ids per vendor, surfaced as a <datalist> next to the free-text
 * model field so a user gets sensible defaults instead of guessing (a typo only
 * fails at runtime today). Free text is still allowed — these are hints, and an
 * empty value always means "provider default". Only vendors with well-known,
 * stable ids are listed; the rest fall back to free text (no wrong suggestions).
 */
export const MODEL_SUGGESTIONS: Record<string, string[]> = {
  claude: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
  grok: ['grok-4', 'grok-code-fast-1']
}
export const modelSuggestionsFor = (p: string): string[] => MODEL_SUGGESTIONS[vendorOf(p)] ?? []

// ---------------------------------------------------------------------------
// Model catalog — the REAL, per-family model list sourced from the bundled CLI
// (`autodev models --json`, exposed as window.api.listModels()). This is the
// source of truth for the model pickers; MODEL_SUGGESTIONS above is now only the
// OFFLINE fallback for an older CLI that lacks the `models` command.
// ---------------------------------------------------------------------------

/** One model the picker can offer (contextLimit is optional for fallback ids). */
export interface ModelInfo {
  id: string
  label: string
  contextLimit?: number
}
/** One provider family's catalog (mirrors the CLI `models --json` shape). */
export interface ModelCatalogEntry {
  family: string
  default: string
  models: ModelInfo[]
}

// Cache the single catalog fetch process-wide — the catalog is static per CLI
// version, so every picker shares one round-trip.
let _catalogPromise: Promise<ModelCatalogEntry[]> | null = null
export function fetchModelCatalog(): Promise<ModelCatalogEntry[]> {
  if (!_catalogPromise) {
    const call = window.api?.listModels?.()
    _catalogPromise = (call ? Promise.resolve(call) : Promise.resolve([]))
      .then((c) => (Array.isArray(c) ? (c as ModelCatalogEntry[]) : []))
      .catch(() => [])
  }
  return _catalogPromise
}

/** React hook: the full catalog (empty until loaded / on older CLI). */
export function useModelCatalog(): { catalog: ModelCatalogEntry[]; loading: boolean } {
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    void fetchModelCatalog().then((c) => {
      if (!live) return
      setCatalog(c)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [])
  return { catalog, loading }
}

/**
 * The models to offer for a vendor/family, resolved from the live catalog with a
 * graceful fallback to the offline MODEL_SUGGESTIONS (ids only) so the picker is
 * never empty on an older CLI.
 */
export function modelsForFamily(catalog: ModelCatalogEntry[], vendor: string): ModelInfo[] {
  const fam = vendorOf(vendor)
  const entry = catalog.find((e) => e.family === fam)
  if (entry && entry.models.length) return entry.models
  return modelSuggestionsFor(fam).map((id) => ({ id, label: id }))
}

/** Compact context-window hint, e.g. 256000 → "256k", 1_000_000 → "1M". Empty for 0/undefined. */
export function fmtCtx(n?: number): string {
  if (!n) return ''
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`
}

/**
 * The friendly label for a raw model id within a vendor family, e.g.
 * (`grok`, `grok-4`) → "Grok 4". Falls back to the raw id when the catalog is
 * empty (older CLI) or the id is a Custom… value not in the catalog, so a real
 * setting is never dropped. `withCtx` appends the context hint ("Grok 4 · 256k").
 */
export function modelLabel(catalog: ModelCatalogEntry[], vendor: string, id: string, withCtx = false): string {
  if (!id) return ''
  const m = modelsForFamily(catalog, vendor).find((x) => x.id === id)
  if (!m) return id
  return withCtx && m.contextLimit ? `${m.label} · ${fmtCtx(m.contextLimit)}` : m.label
}

/** The provider's own default model as a friendly label (from `ModelCatalogEntry.default`),
 *  or '' when the catalog doesn't name one. */
export function providerDefaultLabel(catalog: ModelCatalogEntry[], vendor: string): string {
  const entry = catalog.find((e) => e.family === vendorOf(vendor))
  if (!entry?.default) return ''
  return entry.models.find((x) => x.id === entry.default)?.label ?? entry.default
}

/**
 * The EFFECTIVE model stated in plain words for an at-a-glance value line:
 *   - a set model  → "Grok 4 · 256k" (friendly label + context)
 *   - empty (default) → "Provider default (Grok 4)" when the catalog names one,
 *                       else a bare "Provider default".
 */
export function effectiveModelDisplay(catalog: ModelCatalogEntry[], vendor: string, value: string): string {
  if (value) return modelLabel(catalog, vendor, value, true)
  const def = providerDefaultLabel(catalog, vendor)
  return def ? `Provider default (${def})` : 'Provider default'
}

/**
 * How you authenticate each vendor's CLI on THIS machine. The app cannot yet probe
 * a provider's signed-in state (there is no such IPC), so onboarding/pre-flight
 * surfaces show this as an honest advisory — the exact command to run — rather than
 * asserting a login it can't verify. `label` is the vendor's display name.
 */
export interface ProviderAuth {
  label: string
  cmd: string
}
export const PROVIDER_AUTH: Record<string, ProviderAuth> = {
  claude: { label: 'Claude', cmd: 'claude' },
  grok: { label: 'Grok', cmd: 'grok' },
  opencode: { label: 'OpenCode', cmd: 'opencode auth login' },
  copilot: { label: 'GitHub Copilot', cmd: 'copilot' }
}
export const providerAuthFor = (p: string): ProviderAuth =>
  PROVIDER_AUTH[vendorOf(p)] ?? { label: vendorOf(p) || p, cmd: vendorOf(p) || p }

/** Folder-safe slug from an agent name, with a stable per-index fallback. */
export const slugify = (s: string, i: number): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || `agent-${i + 1}`
