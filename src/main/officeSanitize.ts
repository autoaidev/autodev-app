/**
 * Pure validation/sanitization helpers for the pixel-office boundary.
 *
 * These guard values that originate OUTSIDE the app's trust boundary — Claude
 * session ids derived from arbitrary on-disk filenames, and office/agent slugs +
 * MCP URLs returned by a remote (possibly compromised or multi-tenant) office
 * server — before they are interpolated into a shell command, a filesystem path,
 * or a spawned MCP config. Kept electron-free so they are unit-testable.
 */

/**
 * A Claude session id is a UUID-like transcript filename stem. Anything that
 * could act as a shell metacharacter (`;`, `$()`, backticks, spaces, quotes, …)
 * must be rejected — the id is interpolated into a `sh -lc` string downstream.
 */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

/**
 * Sanitize a single path segment that came from the office server (office slug,
 * agent slug, agent id). Strip everything but a conservative filename charset and
 * any leading dots, so it can never introduce a separator, `..` traversal, or a
 * hidden/dotfile. Never returns empty.
 */
export function safeSeg(s: unknown): string {
  return String(s ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^\.+/, '')
    .slice(0, 64) || 'x'
}

/**
 * A loopback host — the only place plain http is tolerated (local dev office),
 * since traffic never leaves the machine so there is nothing to intercept.
 */
export function isLocalhostHost(host: string): boolean {
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

/**
 * True when a URL string is safe to send credentials to / write into a spawned
 * MCP config: it must be https, except for a loopback host where plain http is
 * allowed (local dev). Anything non-http(s) or plain-http off-loopback is
 * rejected so passwords, durable tokens and the office API key are never sent
 * or persisted in cleartext.
 */
export function isSecureBaseUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol === 'https:') return true
  if (u.protocol === 'http:' && isLocalhostHost(u.host)) return true
  return false
}

/**
 * Validate an MCP endpoint URL supplied by the office server. Only accept a URL
 * whose origin matches the connected office base AND that is transport-secure
 * (https, or http to a loopback host for local dev); otherwise the caller should
 * fall back to the derived default so a malicious response cannot silently
 * repoint the operated Claude session at an attacker endpoint or downgrade the
 * office key to cleartext http.
 */
export function safeMcpUrl(url: unknown, base: string, fallback: string): string {
  if (typeof url !== 'string' || !url) return fallback
  let u: URL
  try { u = new URL(url) } catch { return fallback }
  if (!isSecureBaseUrl(url)) return fallback
  try {
    const b = new URL(base)
    if (u.origin !== b.origin) return fallback
  } catch { return fallback }
  return url
}
