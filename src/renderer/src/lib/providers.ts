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
      // NOTE: grok-cli stays options[0] — it is the Grok family default that
      // defaultProviderIdForFamily('grok') resolves to; do not reorder.
      { id: 'grok-cli', label: 'Grok — CLI' },
      { id: 'grok-tui', label: 'Grok — interactive' },
      { id: 'grok-acp', label: 'Grok — ACP (persistent)' }
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

/**
 * A short RUN-MODE tag for a provider id — HOW it actually drives, not which
 * vendor. This is what makes `grok-acp` (a persistent ACP loop, driven by the CLI
 * task loop over JSON-RPC stdio) visibly distinct from `grok-tui` (an interactive
 * TUI in a PTY pane): the family badge says "Grok" for both, this says the engine.
 * Empty string for a bare family id with no variant suffix.
 */
export function runModeLabel(id: string): string {
  const s = String(id || '').toLowerCase()
  if (s.endsWith('-acp')) return 'ACP loop'
  if (s.endsWith('-tui')) return 'TUI'
  if (s.endsWith('-cli')) return 'CLI'
  if (s.endsWith('-sdk')) return 'SDK'
  return ''
}

/** The vendor (`claude`, `grok`, `opencode`, `copilot`) for a provider id. */
export const vendorOf = (p: string): string => p.split('-')[0]

/**
 * The default full provider id for a vendor FAMILY — the family's first grouped
 * variant, e.g. `grok` → `grok-cli`, `claude` → `claude-tui`. Used when a family
 * choice (as the office API stores it) must persist as a CONCRETE provider id the
 * local CLI expects (`autodev config set provider <id>`, the same ids Fleet's
 * provider picker writes). Falls back to the family itself if unrecognized.
 */
export const defaultProviderIdForFamily = (family: string): string => {
  // Idempotent for a CONCRETE provider id (e.g. `grok-tui`, `claude-cli`): the bulk
  // engine-switcher now passes exact variant ids, and re-collapsing one to its
  // family default would silently swap `grok-tui`→`grok-cli`. Pass those through.
  if (ALL_PROVIDER_IDS.includes(family)) return family
  const fam = vendorOf(family)
  const g = PROVIDER_GROUPS.find((grp) => vendorOf(grp.options[0].id) === fam)
  return g?.options[0].id ?? family
}

/**
 * The provider FAMILIES the bulk engine-switcher offers, in the canonical grouped
 * order — `{ family: 'grok', label: 'Grok' }`, one per vendor in PROVIDER_GROUPS
 * (Claude / GitHub Copilot / OpenCode / Grok). The `family` is what the office API
 * (`updateCharacter({ provider })`) and `modelKeyFor` consume; `label` is the
 * vendor display name.
 */
export const ENGINE_FAMILIES: { family: string; label: string }[] = PROVIDER_GROUPS.map((g) => ({
  family: vendorOf(g.options[0].id),
  label: g.vendor
}))

/** Per-vendor `autodev config set` model key. */
export const MODEL_KEY: Record<string, string> = {
  claude: 'claudeModel',
  opencode: 'opencodeModel',
  copilot: 'copilotModel',
  grok: 'grokModel',
  dummy: 'dummyModel'
}
export const modelKeyFor = (p: string): string => MODEL_KEY[vendorOf(p)] ?? 'claudeModel'

// ---------------------------------------------------------------------------
// Model catalog — the REAL, per-family model list sourced from the bundled CLI
// (`autodev models --json`, exposed as window.api.listModels()). This is the SOLE
// source of truth for the model pickers. There is deliberately NO hand-written
// model-id list here: a hardcoded fallback drifted (`claude-sonnet-5` vs the real
// `claude-sonnet-4-5`, `grok-code-fast-1` vs `grok-code`) and was removed. main's
// `models:list` already falls back to a GENERATED model-catalog.json shipped with
// the bundled CLI, so this catalog is populated even offline; the `.length`
// fallbacks below degrade to "provider default / Custom…" only if it is ever empty.
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
 * The models to offer for a vendor/family, from the catalog. Empty when the
 * catalog has no entry for the family (older CLI with no `models` command AND no
 * generated fallback) — callers then degrade to "provider default / Custom…"
 * rather than showing stale, possibly-wrong hardcoded ids.
 */
export function modelsForFamily(catalog: ModelCatalogEntry[], vendor: string): ModelInfo[] {
  const fam = vendorOf(vendor)
  const entry = catalog.find((e) => e.family === fam)
  return entry && entry.models.length ? entry.models : []
}

/**
 * True when a non-empty Custom model id isn't in the vendor's catalog — the single
 * signal behind every picker's "Not a known … model" warning (per-agent ModelSelect,
 * the Fleet inline editor and the bulk Set-model modal, all via ModelSelect). Empty
 * ('' = provider default) and known catalog ids are fine. Warn-not-block: an unlisted
 * id is still allowed (power users need models the catalog doesn't yet list).
 */
export function isUnknownModel(catalog: ModelCatalogEntry[], vendor: string, value: string): boolean {
  const v = value.trim()
  if (!v) return false
  return !modelsForFamily(catalog, vendor).some((m) => m.id === v)
}

// ---------------------------------------------------------------------------
// Default-model preference — a per-vendor model id the new-agent flows pre-select
// so a fleet inherits a house model without editing each agent. Persisted app-side
// (main `app-settings.json`, via window.api.get/setSettings); '' for a vendor means
// "provider default" (today's behavior). This is a SEED only — the app writes the
// resolved model per workspace at create time; it never mutates an existing agent.
// ---------------------------------------------------------------------------

/** The persisted per-vendor default-model map (`{}` on an older main / read error). */
export function fetchDefaultModels(): Promise<Record<string, string>> {
  const call = window.api?.getSettings?.()
  return (call ? Promise.resolve(call) : Promise.resolve(undefined))
    .then((s) => {
      const dm = (s as { defaultModels?: Record<string, string> } | undefined)?.defaultModels
      return dm && typeof dm === 'object' ? dm : {}
    })
    .catch(() => ({}))
}

/** React hook: the per-vendor default-model map + a `reload` to re-read after a Save. */
export function useDefaultModels(): { defaults: Record<string, string>; loading: boolean; reload: () => void } {
  const [defaults, setDefaults] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    void fetchDefaultModels().then((d) => {
      if (!live) return
      setDefaults(d)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [tick])
  return { defaults, loading, reload: () => setTick((t) => t + 1) }
}

/** The configured default model id for a vendor/provider ('' = none / provider default). */
export function defaultModelFor(defaults: Record<string, string>, vendor: string): string {
  return defaults[vendorOf(vendor)] ?? ''
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
