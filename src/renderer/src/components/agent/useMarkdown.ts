import { marked } from 'marked'
import DOMPurify from 'dompurify'

/**
 * Chat-prose markdown renderer — the Electron-app twin of pixel-office's
 * `resources/js/composables/useMarkdown.ts`, kept deliberately 1:1 so the desktop
 * Chat tab and the web office chat format agent narration identically.
 *
 * Agent / A2A message bodies are LLM-authored, so they arrive as markdown
 * (headings, **bold**, lists, `code`, fenced blocks, links, tables via GFM). We
 * render them to HTML with `marked` and then SANITIZE with DOMPurify before the
 * string ever reaches `dangerouslySetInnerHTML` — raw HTML in the source (e.g. an
 * `<img onerror>` payload) must never touch the DOM. Links are hardened to open
 * safely in a new tab. USER-typed input is NOT passed through here (it stays
 * literal in ChatTab), matching pixel-office.
 */

marked.setOptions({ async: false, breaks: true, gfm: true })

// marked.parse + DOMPurify.sanitize is a few hundred µs to a few ms per bubble,
// and ChatTab re-renders on every keystroke in the composer. Without a cache a
// single keystroke would re-parse every visible bubble. Message text is
// immutable, so memoize by exact source with a bounded LRU (Map preserves
// insertion order — delete+set moves a key to newest).
const _mdCache = new Map<string, string>()
const _MD_CACHE_MAX = 1000

/**
 * Render markdown to SANITIZED HTML suitable for `dangerouslySetInnerHTML`.
 * Memoized by source string.
 */
export function renderMarkdown(src: string | null | undefined): string {
  const key = src ?? ''
  const hit = _mdCache.get(key)
  if (hit !== undefined) {
    // Mark as most-recently-used.
    _mdCache.delete(key)
    _mdCache.set(key, hit)
    return hit
  }
  const raw = marked.parse(key, { async: false }) as string
  const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
  // Force external links to a safe target (DOMPurify keeps href but not target).
  const out = clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer nofollow" ')
  _mdCache.set(key, out)
  if (_mdCache.size > _MD_CACHE_MAX) {
    // Evict the oldest (first) entry.
    const oldest = _mdCache.keys().next().value
    if (oldest !== undefined) {
      _mdCache.delete(oldest)
    }
  }
  return out
}
