/**
 * A tiny, dependency-free cookie jar for driving `fetch` against a Laravel
 * (session-auth) backend. Kept in its own module — with NO electron imports —
 * so it can be unit-tested with plain `node` (see test/cookieJar.test.mts).
 *
 * Laravel sets several cookies across multiple `Set-Cookie` headers on login:
 * `XSRF-TOKEN` (URL-encoded), the session cookie (e.g. `autodevoffice-session`),
 * and, with `remember: true`, a long-lived `remember_web_*` token. The jar must
 * capture ALL of them, url-decode the XSRF value for the request header, and
 * survive persistence/reload so the session can be resumed on next launch.
 */

/**
 * Split a combined `Set-Cookie` header value (what `Headers.get('set-cookie')`
 * returns when the runtime lacks `getSetCookie()`) into individual cookie
 * strings. This is subtle because the `Expires=<date>` attribute contains a
 * comma (e.g. `Expires=Mon, 13 Jul 2026 20:22:49 GMT`). We only treat a comma
 * as a cookie boundary when it is immediately followed by `<name>=` where
 * `<name>` has no whitespace — a date continuation like ", 13 Jul 2026" does not
 * match because the segment before the next `=` contains spaces.
 */
export function splitSetCookie(combined: string): string[] {
  const out: string[] = []
  let start = 0
  for (let i = 0; i < combined.length; i++) {
    if (combined[i] !== ',') continue
    const rest = combined.slice(i + 1)
    const eq = rest.indexOf('=')
    if (eq < 0) continue
    const seg = rest.slice(0, eq).trim()
    // A real cookie name: non-empty and no whitespace (rules out date fragments).
    if (seg && !/\s/.test(seg)) {
      out.push(combined.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(combined.slice(start).trim())
  return out.filter(Boolean)
}

/** The minimal shape of a `fetch` Response's headers that the jar reads. */
export interface SetCookieHeaders {
  getSetCookie?: () => string[]
  get?: (name: string) => string | null
}

export class Jar {
  private c = new Map<string, string>()

  /** Absorb every `Set-Cookie` from a response, across multiple headers. */
  store(res: { headers: SetCookieHeaders }): void {
    const h = res.headers
    let lines: string[] = []
    if (typeof h.getSetCookie === 'function') lines = h.getSetCookie()
    else if (typeof h.get === 'function') {
      const raw = h.get('set-cookie')
      if (raw) lines = splitSetCookie(raw)
    }
    for (const line of lines) this.set(line)
  }

  /** Store a single `name=value; attr…` cookie line. */
  set(line: string): void {
    const pair = line.split(';', 1)[0]
    const i = pair.indexOf('=')
    if (i <= 0) return
    const name = pair.slice(0, i).trim()
    const value = pair.slice(i + 1).trim()
    if (!name) return
    // A server "deletes" a cookie by re-sending it with an empty/expired value.
    // Don't let such a delete wipe a still-good cookie we already hold, but do
    // accept genuine value updates.
    if (value === '' && this.c.has(name)) return
    this.c.set(name, value)
  }

  /** The `Cookie:` request header — every cookie sent back verbatim (raw). */
  header(): string {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** The `X-XSRF-TOKEN` request header value — url-decoded, as Laravel expects. */
  xsrf(): string {
    const v = this.c.get('XSRF-TOKEN')
    return v ? decodeURIComponent(v) : ''
  }

  dump(): [string, string][] {
    return [...this.c]
  }
  load(entries: [string, string][]): void {
    this.c = new Map(entries)
  }
  has(name: string): boolean {
    return this.c.has(name)
  }
  size(): number {
    return this.c.size
  }
}
