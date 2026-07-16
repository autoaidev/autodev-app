/**
 * Turn Node/undici's opaque fetch failures into something a person can act on.
 *
 * Node's fetch collapses every DNS/TLS/connection failure into the message
 * "fetch failed", with the real reason hidden on `error.cause.code`. The app's
 * first screen is "connect to your office" and its first failure is usually a
 * wrong URL or no network — so surfacing those two words is a dead end for a new
 * user. This maps the common causes to a legible message that names the host.
 *
 * Kept dependency-free (no Electron imports) so it is unit-testable on its own.
 */
export function humanizeFetchError(e: unknown, url: string): Error {
  const err = e as Error & { cause?: { code?: string; message?: string } }
  // Already legible (e.g. our own timeout message) — leave it.
  if (err?.message && err.message !== 'fetch failed') return err

  let host = url
  try { host = new URL(url).host } catch { /* not a URL — fall back to the raw string */ }

  const code = err?.cause?.code
  const msg = ((): string => {
    switch (code) {
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return `Can't find ${host} — check the office URL and your connection`
      case 'ECONNREFUSED':
        return `${host} refused the connection — is the office URL right?`
      case 'ECONNRESET':
        return `Connection to ${host} was reset — try again`
      case 'ETIMEDOUT':
        return `${host} didn't respond — check your connection`
      case 'CERT_HAS_EXPIRED':
      case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      case 'SELF_SIGNED_CERT_IN_CHAIN':
        return `${host} has an invalid TLS certificate`
      default:
        return `Couldn't reach ${host}${code ? ` (${code})` : ''} — check the office URL and your connection`
    }
  })()

  return new Error(msg)
}
