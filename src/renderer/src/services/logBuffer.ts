/**
 * logBuffer — the SHARED per-agent log buffer service (Stage 1, services layer).
 *
 * Owns a module-level ring buffer of the RAW provider log text, keyed by agent
 * workspace path, fed by a SINGLE `window.api.onAgentLog` subscription. Replaces
 * the `logsRef` Map + `logListeners` Set that used to live inside AgentsView, so
 * the buffer no longer lives-and-dies with that view's mount and any component
 * (ActivityStream, an Output pane, a mini-preview) can read the same bytes.
 *
 * Parsing stays OUT of here — consumers get the raw text and parse it themselves
 * (ActivityStream.parseLog). This module only accumulates, caps, and notifies.
 *
 * Re-render scoping: listeners are grouped PER PATH, so a streamed line for
 * agent A wakes only the components observing A. This is what kept the parent
 * view's composer/search inputs from dropping keystrokes and is preserved here.
 *
 * ---------------------------------------------------------------- public API
 *  getAgentLog(path: string): string
 *      Current buffered raw text for `path` ('' if none). Stable reference:
 *      returns the SAME string until the buffer for that path actually changes,
 *      so it is safe as a useSyncExternalStore snapshot.
 *
 *  subscribeAgentLog(path: string, cb: () => void): () => void
 *      Subscribe to changes for a SINGLE path; returns an unsubscribe fn. Lazily
 *      attaches the one shared onAgentLog bridge on first use.
 *
 *  useAgentLog(path: string): string
 *      React hook (useSyncExternalStore) → the current raw text for `path`. Only
 *      components observing `path` re-render when that agent streams a line.
 *
 *  appendAgentLog(path: string, text: string): void
 *      Append text to a path's buffer as if it had streamed (local echo — e.g.
 *      AgentsView's "queued task" line). Applies the same cap + notifies.
 *
 *  deleteAgentLog(path: string): void
 *      Drop one agent's buffer (e.g. after removeAgentFolder) and notify it.
 *
 *  pruneAgentLogs(livePaths: Iterable<string>): void
 *      Drop buffers for any path NOT in `livePaths`, so the Map can't grow
 *      unbounded as agents are removed. Diffs against the live set (a size gate
 *      would strand stale buffers when one agent is removed as another is added).
 *
 *  initAgentLogBridge(): void
 *      Eagerly attach the shared onAgentLog subscription (optional; subscribing
 *      does it lazily). Idempotent.
 *
 * The buffer is capped at CAP chars per path (front-truncated), matching the old
 * 20k window so ActivityStream's content-derived keys keep following their rows.
 */

import { useSyncExternalStore } from 'react'

/** Per-path buffer cap in characters (front-truncated), matching the legacy 20k window. */
export const CAP = 20000

/** path -> raw accumulated log text. */
const buffers = new Map<string, string>()

/** path -> set of change listeners scoped to that path. */
const listeners = new Map<string, Set<() => void>>()

/** Unsubscribe handle for the single shared onAgentLog bridge, or null until attached. */
let bridgeOff: (() => void) | null = null

function notify(path: string): void {
  const set = listeners.get(path)
  if (set) for (const cb of set) cb()
}

/**
 * Attach the ONE shared onAgentLog subscription that feeds every path's buffer.
 * Idempotent — repeated calls are no-ops once attached. Guards for non-renderer
 * environments where window.api may be undefined (typecheck/test harnesses).
 */
export function initAgentLogBridge(): void {
  if (bridgeOff) return
  const w = typeof window !== 'undefined' ? window : undefined
  if (!w?.api?.onAgentLog) return
  bridgeOff = w.api.onAgentLog(({ path, line }: { path: string; line: string }) => {
    const cur = buffers.get(path) ?? ''
    buffers.set(path, (cur + line).slice(-CAP))
    notify(path)
  })
}

/** Current buffered raw text for `path` ('' if none). Stable reference until it changes. */
export function getAgentLog(path: string): string {
  return buffers.get(path) ?? ''
}

/**
 * Subscribe to buffer changes for a SINGLE `path`. Returns an unsubscribe fn.
 * Lazily attaches the shared onAgentLog bridge on first subscription.
 */
export function subscribeAgentLog(path: string, cb: () => void): () => void {
  initAgentLogBridge()
  let set = listeners.get(path)
  if (!set) {
    set = new Set()
    listeners.set(path, set)
  }
  set.add(cb)
  return () => {
    const s = listeners.get(path)
    if (!s) return
    s.delete(cb)
    if (s.size === 0) listeners.delete(path)
  }
}

/**
 * Append `text` to a path's buffer as if it had streamed (local echo). Applies
 * the same front-truncation cap and notifies that path's observers.
 */
export function appendAgentLog(path: string, text: string): void {
  const cur = buffers.get(path) ?? ''
  buffers.set(path, (cur + text).slice(-CAP))
  notify(path)
}

/** Drop one agent's buffer and notify its observers (they read '' afterwards). */
export function deleteAgentLog(path: string): void {
  if (buffers.delete(path)) notify(path)
}

/**
 * Drop buffers for any path NOT present in `livePaths`. Diffs against the live
 * set so a removed agent's buffer is always reclaimed, even mid-churn.
 */
export function pruneAgentLogs(livePaths: Iterable<string>): void {
  const live = livePaths instanceof Set ? livePaths : new Set(livePaths)
  for (const p of Array.from(buffers.keys())) {
    if (!live.has(p)) {
      buffers.delete(p)
      notify(p)
    }
  }
}

/**
 * React hook → the current raw log text for `path`. Backed by
 * useSyncExternalStore so only components observing `path` re-render when that
 * agent streams (or a local echo is appended). Parse the returned raw text in
 * the consumer (e.g. ActivityStream.parseLog).
 */
export function useAgentLog(path: string): string {
  return useSyncExternalStore(
    (cb) => subscribeAgentLog(path, cb),
    () => getAgentLog(path)
  )
}
