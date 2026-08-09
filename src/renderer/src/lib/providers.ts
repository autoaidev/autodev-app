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
