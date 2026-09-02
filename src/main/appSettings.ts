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

interface AppSettings { officeBaseUrl?: string; defaultModels?: Record<string, string> }

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

/** Always-resolved settings for the renderer (never returns undefined fields). */
export function getSettings(): { officeBaseUrl: string; defaultModels: Record<string, string> } {
  return { officeBaseUrl: getOfficeBaseUrl(), defaultModels: getDefaultModels() }
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
  patch: { officeBaseUrl?: string; defaultModels?: Record<string, string> }
): { ok: true; officeBaseUrl: string; defaultModels: Record<string, string> } | { error: string } {
  if (patch && typeof patch === 'object') {
    if ('officeBaseUrl' in patch) {
      const r = setOfficeBaseUrl(patch.officeBaseUrl ?? '')
      if ('error' in r) return r
    }
    if ('defaultModels' in patch && patch.defaultModels && typeof patch.defaultModels === 'object') {
      setDefaultModels(patch.defaultModels)
    }
  }
  return { ok: true, officeBaseUrl: getOfficeBaseUrl(), defaultModels: getDefaultModels() }
}
