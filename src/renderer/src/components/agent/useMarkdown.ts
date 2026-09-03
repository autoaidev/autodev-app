import { marked } from 'marked'
import DOMPurify from 'dompurify'

/**
 * The ONE markdown renderer for the whole desktop renderer — the Electron-app twin
 * of pixel-office's `resources/js/composables/useMarkdown.ts`. Every panel that
 * shows agent / assistant / A2A / system-narration prose (ChatTab, ActivityStream
 * rows, the office AgentStream ticker, OfficeRoom, the Sessions TranscriptPane)
 * funnels its text through here, so formatting is identical everywhere and there is
 * exactly ONE place in the codebase that touches `marked` / `DOMPurify`.
 *
 * Message bodies are LLM-authored, so they arrive as markdown (headings, **bold**,
 * lists, `code`, fenced blocks, links, tables via GFM). We render to HTML with
 * `marked` and then SANITIZE with DOMPurify before the string ever reaches
 * `dangerouslySetInnerHTML` — raw HTML in the source (e.g. an `<img onerror>`
 * payload) must never touch the DOM. Links are hardened to open safely in a new tab.
 *
 * Two entry points share ONE sanitize config and ONE bounded cache:
 *   • renderMarkdown(src)        — FULL block markdown, for prose panels.
 *   • renderMarkdownInline(src)  — INLINE-only (bold/italic/code/links/strike),
 *                                  block elements stripped + collapsed to a single
 *                                  line, for compact tickers/previews.
 *
 * USER-typed input is NOT passed through here — callers keep their own messages
 * literal (matching pixel-office), so a user's `#`/`*` is never treated as syntax.
 */

marked.setOptions({ async: false, breaks: true, gfm: true })

// ONE sanitize + link-hardening pass, shared by both renderers. DOMPurify keeps the
// href but drops target, so re-add a safe external target on every anchor.
function sanitize(rawHtml: string): string {
  const clean = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } })
  return clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer nofollow" ')
}

// marked.parse + DOMPurify.sanitize is a few hundred µs to a few ms per string, and
// panels re-render on every keystroke / poll. Message text is immutable, so memoize
// by (mode-prefixed) source with a bounded LRU (Map preserves insertion order —
// delete+set moves a key to newest). The prefix keeps block and inline renders of
// the same source from colliding.
const _cache = new Map<string, string>()
const _MAX = 1000
function memo(key: string, produce: () => string): string {
  const hit = _cache.get(key)
  if (hit !== undefined) {
    _cache.delete(key)
    _cache.set(key, hit)
    return hit
  }
  const out = produce()
  _cache.set(key, out)
  if (_cache.size > _MAX) {
    const oldest = _cache.keys().next().value
    if (oldest !== undefined) _cache.delete(oldest)
  }
  return out
}

/**
 * Render markdown to SANITIZED HTML suitable for `dangerouslySetInnerHTML`.
 * FULL block markdown (headings, lists, fenced code, tables…). Memoized.
 */
export function renderMarkdown(src: string | null | undefined): string {
  const source = src ?? ''
  return memo('b:' + source, () => sanitize(marked.parse(source, { async: false }) as string))
}

/**
 * Render markdown to SANITIZED, SINGLE-LINE HTML for compact tickers/previews.
 * Uses `marked.parseInline`, which emits ONLY inline elements (no <p>/<h*>/<ul>/
 * <pre>…), and collapses all whitespace first so `breaks:true` can't inject a <br>
 * — the result always stays on one line while still rendering **bold**, *italic*,
 * `code`, ~~strike~~ and [links]. Memoized. Keep the container's own overflow /
 * ellipsis / nowrap styling; this only themes the inline marks. */
export function renderMarkdownInline(src: string | null | undefined): string {
  const source = src ?? ''
  return memo('i:' + source, () => {
    // Collapse newlines/runs of whitespace BEFORE parsing so nothing can force a
    // second line; parseInline then leaves block syntax (`#`, `-`) as literal text.
    const oneLine = source.replace(/\s+/g, ' ').trim()
    return sanitize(marked.parseInline(oneLine, { async: false }) as string)
  })
}
