/**
 * services/windowFocus.ts — the SINGLE "is the app being looked at right now?"
 * signal, shared by every focus-gated poller.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * The app keeps all views mounted (display:none) and several always-on timers
 * (local /proc + fs discovery, office presence). On a software-GPU VNC box those
 * timers burn CPU even when the window is blurred or hidden, where sub-10s
 * freshness buys nothing. This module derives ONE boolean — "active" = the window
 * has OS focus AND the document is visible — from the main-process `window:focus`
 * IPC (BrowserWindow focus/blur), the DOM `focus`/`blur` events (a reliable
 * in-renderer backup) and `document.visibilityState` (covers minimise / hidden).
 *
 * It also owns the BODY-LEVEL idle signal: `<html>` gets the `app-blurred` class
 * whenever the app is not active, which the CSS uses to PAUSE (never remove) the
 * infinite "live/working" animations so an idle background window stops compositing
 * frames. Animations resume instantly on refocus; prefers-reduced-motion still wins.
 *
 * Listeners are installed ONCE at module load (not per hook), so the body signal is
 * always maintained even when no component subscribes.
 */
import { useSyncExternalStore } from 'react'

type FocusApi = {
  onWindowFocus?: (cb: (focused: boolean) => void) => (() => void)
  onWindowIdle?: (cb: (idle: boolean) => void) => (() => void)
}
const api = (): FocusApi => ((window as unknown as { api?: FocusApi }).api ?? {})

const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined'

// Seed from the live truth so we never start wrong (the first `focus` IPC may not
// arrive until the user interacts). document.hasFocus() reflects renderer focus.
let focused = hasDom ? document.hasFocus() : true
let docVisible = hasDom ? document.visibilityState !== 'hidden' : true
// `systemIdle` — nobody has touched the machine for a while (main powerMonitor).
// On a headless VNC box the window is focused+visible forever, so without this
// the app would NEVER pause; idle is the signal that actually trips there. It is
// ANDed into `active`: the app is "active" only when focused, visible AND someone
// is present. Resets to false the instant input resumes (window:idle false).
let systemIdle = false
let active = focused && docVisible && !systemIdle

const listeners = new Set<() => void>()

/** Reflect the active state onto <html> (CSS idle-animation pause) + wake subs. */
function recompute(): void {
  const next = focused && docVisible && !systemIdle
  if (next === active) return
  active = next
  if (hasDom) {
    try { document.documentElement.classList.toggle('app-blurred', !active) } catch { /* ignore */ }
  }
  listeners.forEach((cb) => cb())
}

if (hasDom) {
  // Primary: the main process's authoritative BrowserWindow focus/blur.
  try { api().onWindowFocus?.((f) => { focused = f; recompute() }) } catch { /* no bridge (tests) */ }
  // System idle (powerMonitor) — the real presence signal on an always-focused VNC
  // window. Pauses animations/pollers after IDLE_THRESHOLD_S of no input anywhere.
  try { api().onWindowIdle?.((idle) => { systemIdle = idle; recompute() }) } catch { /* no bridge (tests) */ }
  // Backup: the renderer's own window focus/blur (fires on webContents focus too).
  window.addEventListener('focus', () => { focused = true; recompute() })
  window.addEventListener('blur', () => { focused = false; recompute() })
  // Hidden / minimised / tab-backgrounded.
  document.addEventListener('visibilitychange', () => {
    docVisible = document.visibilityState !== 'hidden'
    recompute()
  })
  // Apply the initial body signal.
  try { document.documentElement.classList.toggle('app-blurred', !active) } catch { /* ignore */ }
}

/** Imperative read — "is the window focused AND the document visible?" */
export function isWindowActive(): boolean {
  return active
}

/** Subscribe to active-state changes; returns an unsubscribe. */
export function subscribeWindowActive(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/**
 * useWindowActive() → boolean
 * True while the window has OS focus AND the document is visible. Re-renders only
 * when that verdict flips. Pair with a tab-visible flag for per-view gating.
 */
export function useWindowActive(): boolean {
  return useSyncExternalStore(subscribeWindowActive, isWindowActive, () => true)
}
