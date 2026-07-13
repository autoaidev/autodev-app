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
 * Validate an MCP endpoint URL supplied by the office server. Only accept an
 * http(s) URL whose origin matches the connected office base; otherwise the
 * caller should fall back to the derived default so a malicious response cannot
 * silently repoint the operated Claude session at an attacker endpoint.
 */
export function safeMcpUrl(url: unknown, base: string, fallback: string): string {
  if (typeof url !== 'string' || !url) return fallback
  let u: URL
  try { u = new URL(url) } catch { return fallback }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return fallback
  try {
    const b = new URL(base)
    if (u.origin !== b.origin) return fallback
  } catch { return fallback }
  return url
}
