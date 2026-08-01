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
 * Shape is intentionally extensible (`{ officeBaseUrl?: string }`) but only the
 * base URL is stored today. A tiny in-memory cache is busted on every write.
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { isSecureBaseUrl } from './officeSanitize'
import { DEFAULT_OFFICE_BASE } from './pixelOffice'

interface AppSettings { officeBaseUrl?: string }

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

/** Always-resolved settings for the renderer (never returns undefined fields). */
export function getSettings(): { officeBaseUrl: string } {
  return { officeBaseUrl: getOfficeBaseUrl() }
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
