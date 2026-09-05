/**
 * Non-secret, plaintext app preferences persisted in `<userData>/app-settings.json`.
 *
 * Deliberately SEPARATE from `pixel-office.json` (the encrypted credential blob):
 *  - The office base URL is a preference, not a secret, and must be readable
 *    BEFORE any login (the login forms use it as their default) and even when the
 *    credential blob fails to decrypt.
 *  - `PixelOfficeClient.logout()` deletes `pixel-office.json` outright; keeping the
 *    base there would mean "log out → silently reset your configured server".
 *    A standalone file survives logout and account switches.
 *
 * Shape is intentionally extensible. Two preferences are stored today:
 *  - `officeBaseUrl` — the Pixel Office server URL (see above).
 *  - `defaultModels` — a per-vendor default model id (`{ claude: 'claude-opus-4-8',
 *    grok: 'grok-4', … }`) the new-agent flows pre-select so a fleet inherits a
 *    house model without editing each agent. Empty/absent for a vendor = the
 *    provider's own default (today's behavior). It is a UI seed only — the app
 *    writes the resolved model per workspace at create time; nothing here changes
 *    the CLI or an existing agent.
 * A tiny in-memory cache is busted on every write.
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { isSecureBaseUrl } from './officeSanitize'
import { DEFAULT_OFFICE_BASE } from './pixelOffice'

type ThemePref = 'system' | 'dark' | 'light'

/**
 * A default MCP server that SEEDS new agents (mirrors `defaultModels`, but a list
 * rather than a per-vendor map since MCP servers aren't one-per-vendor). `server`
 * is a raw `.mcp.json` entry (stdio via command/args/env OR remote via url/headers)
 * the create flow feeds to `autodev mcp add`. `kind` is the catalog origin for the
 * UI badge; `id` is the catalog id when it came from the catalog (absent for a
 * custom entry). It is a UI SEED only — nothing here mutates an existing agent.
 */
export interface DefaultMcpEntry {
  id?: string
  name: string
  server: {
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
    type?: string
    enabled?: boolean
  }
  kind?: 'builtin' | 'common' | 'creative' | 'custom'
}

interface AppSettings { officeBaseUrl?: string; defaultModels?: Record<string, string>; defaultMcp?: DefaultMcpEntry[]; advancedMode?: boolean; theme?: ThemePref }

const FILE = join(app.getPath('userData'), 'app-settings.json')
let cache: AppSettings | null = null

/** Read + memoize the settings file; a missing/corrupt file reads as empty. */
function load(): AppSettings {
  if (cache) return cache
  try {
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, 'utf8'))
      cache = raw && typeof raw === 'object' ? (raw as AppSettings) : {}
    } else {
      cache = {}
    }
  } catch {
    cache = {}
  }
  return cache
}

function persist(s: AppSettings): void {
  cache = s
  writeFileSync(FILE, JSON.stringify(s, null, 2), { mode: 0o600 })
  try { chmodSync(FILE, 0o600) } catch { /* best effort */ }
}

/** Strip a single trailing slash so origins compare/interpolate cleanly. */
function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** The configured Pixel Office base URL, or the built-in default when unset. */
export function getOfficeBaseUrl(): string {
  const v = load().officeBaseUrl
  return v && v.trim() ? trimUrl(v) : DEFAULT_OFFICE_BASE
}

/** The per-vendor default model map (a fresh copy; `{}` when none configured). */
export function getDefaultModels(): Record<string, string> {
  const m = load().defaultModels
  return m && typeof m === 'object' ? { ...m } : {}
}

/** The default-MCP seed list (a fresh copy; `[]` when none configured). */
export function getDefaultMcp(): DefaultMcpEntry[] {
  const m = load().defaultMcp
  return Array.isArray(m) ? m.map((e) => ({ ...e, server: { ...e.server } })) : []
}

/**
 * Replace the whole default-MCP seed list. Unlike `defaultModels` (a per-vendor
 * patch-merge), MCP defaults are a list the Settings UI owns end-to-end, so the
 * renderer sends the complete next array. Entries missing a name are dropped.
 */
export function setDefaultMcp(list: DefaultMcpEntry[]): DefaultMcpEntry[] {
  const clean = Array.isArray(list)
    ? list
        .filter((e) => e && typeof e === 'object' && String(e.name || '').trim())
        .map((e) => ({ id: e.id, name: String(e.name).trim(), server: { ...(e.server ?? {}) }, kind: e.kind }))
    : []
  persist({ ...load(), defaultMcp: clean })
  return getDefaultMcp()
}

/** Whether the UI runs in Advanced mode (expert controls shown). Defaults false. */
export function getAdvancedMode(): boolean {
  return load().advancedMode === true
}

/** Persist the Advanced-mode flag (a plain boolean UI preference). */
export function setAdvancedMode(on: boolean): boolean {
  persist({ ...load(), advancedMode: !!on })
  return getAdvancedMode()
}

/** The persisted theme preference (system | dark | light). Defaults 'system'. */
export function getTheme(): ThemePref {
  const t = load().theme
  return t === 'dark' || t === 'light' || t === 'system' ? t : 'system'
}

/** Persist the theme preference (a plain UI preference). */
export function setTheme(theme: ThemePref): ThemePref {
  const v: ThemePref = theme === 'dark' || theme === 'light' ? theme : 'system'
  persist({ ...load(), theme: v })
  return getTheme()
}

/** Always-resolved settings for the renderer (never returns undefined fields). */
export function getSettings(): { officeBaseUrl: string; defaultModels: Record<string, string>; defaultMcp: DefaultMcpEntry[]; advancedMode: boolean; theme: ThemePref } {
  return { officeBaseUrl: getOfficeBaseUrl(), defaultModels: getDefaultModels(), defaultMcp: getDefaultMcp(), advancedMode: getAdvancedMode(), theme: getTheme() }
}

/**
 * Persist the office base URL. An empty value resets to the built-in default.
 * Validation mirrors what `login()` enforces (https, or http only for localhost)
 * so the Settings page can never store a base the login flow would later reject.
 */
export function setOfficeBaseUrl(url: string): { ok: true; officeBaseUrl: string } | { error: string } {
  const trimmed = trimUrl(String(url ?? ''))
  if (!trimmed) {
    const next = { ...load() }
    delete next.officeBaseUrl
    persist(next)
    return { ok: true, officeBaseUrl: getOfficeBaseUrl() }
  }
  if (!isSecureBaseUrl(trimmed)) {
    return { error: 'Enter a valid https:// URL (http:// is allowed only for localhost).' }
  }
  persist({ ...load(), officeBaseUrl: trimmed })
  return { ok: true, officeBaseUrl: trimmed }
}

/**
 * Merge a per-vendor default-model patch. Each entry with a non-empty id SETS
 * that vendor's default; an empty/absent id CLEARS it (back to provider default).
 * Vendors not present in the patch are left untouched.
 */
export function setDefaultModels(patch: Record<string, string>): Record<string, string> {
  const cur = getDefaultModels()
  for (const [vendor, id] of Object.entries(patch ?? {})) {
    const v = String(vendor || '').trim()
    if (!v) continue
    const val = String(id ?? '').trim()
    if (val) cur[v] = val
    else delete cur[v]
  }
  persist({ ...load(), defaultModels: cur })
  return cur
}

/**
 * The single settings writer the renderer's `setSettings` IPC drives. Applies
 * ONLY the keys present in the patch — so saving default models never resets the
 * office URL, and vice versa (`'key' in patch` distinguishes "clear to default"
 * from "left untouched"). Returns the fully-resolved settings.
 */
export function updateSettings(
  patch: { officeBaseUrl?: string; defaultModels?: Record<string, string>; defaultMcp?: DefaultMcpEntry[]; advancedMode?: boolean; theme?: ThemePref }
): { ok: true; officeBaseUrl: string; defaultModels: Record<string, string>; defaultMcp: DefaultMcpEntry[]; advancedMode: boolean; theme: ThemePref } | { error: string } {
  if (patch && typeof patch === 'object') {
    if ('officeBaseUrl' in patch) {
      const r = setOfficeBaseUrl(patch.officeBaseUrl ?? '')
      if ('error' in r) return r
    }
    if ('defaultModels' in patch && patch.defaultModels && typeof patch.defaultModels === 'object') {
      setDefaultModels(patch.defaultModels)
    }
    if ('defaultMcp' in patch && Array.isArray(patch.defaultMcp)) {
      setDefaultMcp(patch.defaultMcp)
    }
    if ('advancedMode' in patch) {
      setAdvancedMode(patch.advancedMode === true)
    }
    if ('theme' in patch && patch.theme) {
      setTheme(patch.theme)
    }
  }
  return { ok: true, officeBaseUrl: getOfficeBaseUrl(), defaultModels: getDefaultModels(), defaultMcp: getDefaultMcp(), advancedMode: getAdvancedMode(), theme: getTheme() }
}
