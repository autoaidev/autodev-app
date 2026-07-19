/**
 * Pull a URL out of whatever the user pasted into a connect/bind field.
 *
 * The pixel-office web UI hands users a whole shell command to copy, e.g.
 *   autodev --setup-url='https://…/api/cli/setup/80080e…'
 *   autodev start --setup-url="https://…"
 *   autodev connect --url=wss://host/ws?token=…&endpoint=…
 * …but the app only needs the URL. Rather than make people hand-strip the
 * command, these helpers extract the URL from a full command OR accept a bare
 * URL as-is. They are pure so they can be unit-tested (see test/urlExtract.test.mts).
 */

/**
 * Given `raw` (a bare URL or a full `autodev … <flag>=<url>` command), return the
 * URL for the named flag (e.g. '--setup-url' or '--url'), or the first URL-looking
 * token if the flag isn't present. Strips surrounding whitespace and single/double
 * quotes and ignores other flags. Returns null when nothing URL-like is found.
 */
export function extractFlagUrl(raw: string, flag: string): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  // 1. Prefer the value of the named flag when the whole command was pasted.
  //    Handles `--flag=VALUE`, `--flag VALUE`, and single/double/no quotes.
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const flagMatch = s.match(new RegExp(esc + `[=\\s]+['"]?([^'"\\s]+)`))
  if (flagMatch && flagMatch[1]) return flagMatch[1]
  // 2. Otherwise pull the first http(s)/ws(s) URL token out of the string. This
  //    covers a bare pasted URL, or a command using a differently-named flag.
  const urlMatch = s.match(/(?:https?|wss?):\/\/[^\s'"]+/)
  if (urlMatch) return urlMatch[0]
  return null
}

/**
 * Extract a signed setup URL from a pasted `autodev --setup-url=…` command or a
 * bare URL. Returns null when no URL is present.
 */
export function extractSetupUrl(input: string): string | null {
  return extractFlagUrl(input, '--setup-url')
}
