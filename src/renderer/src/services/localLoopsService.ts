/**
 * services/localLoopsService.ts — the single, focus-gated poller for THIS machine's
 * "local footprint" signals the Office rail needs:
 *   • localLoops      — same-host `autodev start` loops this app didn't spawn
 *                       (/proc scan via discoverLocalLoops), keyed by office-agent
 *                       slug AND id → LocalLoopOwner, so a character can be matched
 *                       by whichever it carries.
 *   • localOfficeSlugs — office slugs with an on-disk workspace under
 *                        ~/.autodev-app/offices (disk scan).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * OfficeView used to run a bare `setInterval(…, 4000)` calling discoverLocalLoops
 * forever — gated only on an `alive` flag, never on focus/visibility, and the view
 * never unmounts (App keeps every view mounted via display:none). So on a software-
 * GPU box it drove a synchronous /proc walk in the MAIN process ~every 4s even when
 * the window was blurred or in the tray. This module mirrors agentStore /
 * officeService: ONE ref-counted poller, single-flight, stable-ref reconcile, and —
 * the point — it PAUSES entirely whenever the app isn't active (window blurred /
 * document hidden) OR the Office tab isn't foregrounded, refreshing immediately on
 * becoming active again so the data is fresh the moment the user looks.
 *
 * Active = window focused AND document visible (windowFocus store) AND the Office
 * tab is the foreground tab (setVisible, mirroring OfficeView's `visible` prop).
 */
import { useSyncExternalStore } from 'react'
import type { LocalLoopOwner } from '../components/office/officeTypes'
import { isWindowActive, subscribeWindowActive } from './windowFocus'

/* ------------------------------------------------------------------ config -- */

// Poll cadence while active. Kept ≥ nothing-shorter-than the main-process scan cache
// (agentManager PROC_SCAN_CACHE_MS = 6s) so an on-cadence tick does not force a fresh
// /proc walk every time; the big win is that the timer STOPS when inactive.
const POLL_MS = 5000

/* ------------------------------------------------------------- shared shapes -- */

type DiscoveredLoop = {
  path: string
  officeAgentSlug?: string
  officeAgentId?: string
  ownerUid?: number
  ownerUser?: string
  foreign?: boolean
}
type Api = {
  discoverLocalLoops?: () => Promise<DiscoveredLoop[]>
  localOfficeSlugs?: () => Promise<string[]>
  onAgentsChanged: (cb: () => void) => () => void
}
const api = (): Api => (window as unknown as { api: Api }).api

/* ------------------------------------------------------------- module state -- */

const EMPTY_LOOPS: Map<string, LocalLoopOwner> = new Map()
const EMPTY_SLUGS: Set<string> = new Set()

let loops: Map<string, LocalLoopOwner> = EMPTY_LOOPS // stable ref — replaced only on change
let slugs: Set<string> = EMPTY_SLUGS

const loopListeners = new Set<() => void>()
const slugListeners = new Set<() => void>()

// Lifecycle
let refCount = 0
let started = false
let visible = true // Office tab foregrounded (set by OfficeView via setVisible)
let pollTimer: ReturnType<typeof setInterval> | null = null
let teardownTimer: ReturnType<typeof setTimeout> | null = null
let unsubChanged: (() => void) | null = null
let unsubActive: (() => void) | null = null
let inFlight = false

/* ------------------------------------------------------------------ commit -- */

function isActive(): boolean {
  return isWindowActive() && visible
}

/** Build the slug/id → owner map from the raw loop list (mirrors OfficeView's old
 *  refreshLoops folding, including the foreign-defaults-to-current-account rule). */
function foldLoops(list: DiscoveredLoop[]): Map<string, LocalLoopOwner> {
  const m = new Map<string, LocalLoopOwner>()
  for (const l of list) {
    const owner: LocalLoopOwner = {
      ownerUid: l?.ownerUid,
      ownerUser: l?.ownerUser,
      foreign: l?.foreign === true
    }
    if (l?.officeAgentSlug) m.set(l.officeAgentSlug.toLowerCase(), owner)
    if (l?.officeAgentId) m.set(String(l.officeAgentId).toLowerCase(), owner)
  }
  return m
}

function ownerEqual(a: LocalLoopOwner, b: LocalLoopOwner): boolean {
  return a.foreign === b.foreign && a.ownerUid === b.ownerUid && a.ownerUser === b.ownerUser
}
function loopsEqual(a: Map<string, LocalLoopOwner>, b: Map<string, LocalLoopOwner>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) { const w = b.get(k); if (!w || !ownerEqual(v, w)) return false }
  return true
}
function slugsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const s of a) if (!b.has(s)) return false
  return true
}

function commitLoops(next: Map<string, LocalLoopOwner>): void {
  if (loopsEqual(loops, next)) return // stable ref → no re-render
  loops = next
  loopListeners.forEach((cb) => cb())
}
function commitSlugs(next: Set<string>): void {
  if (slugsEqual(slugs, next)) return
  slugs = next
  slugListeners.forEach((cb) => cb())
}

/* --------------------------------------------------------------- the poller -- */

async function refresh(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    // Loops: best-effort — a failure (or non-Linux []) leaves the previous map.
    try {
      const list = await api().discoverLocalLoops?.()
      if (Array.isArray(list)) commitLoops(foldLoops(list))
    } catch { /* keep the last good map */ }
    // On-disk office footprint: best-effort likewise.
    try {
      const got = await api().localOfficeSlugs?.()
      if (Array.isArray(got)) commitSlugs(new Set(got.map((s) => s.toLowerCase())))
    } catch { /* keep the last good set */ }
  } finally {
    inFlight = false
  }
}

function startTimer(): void {
  if (pollTimer == null) pollTimer = setInterval(() => { if (isActive()) void refresh() }, POLL_MS)
}
function stopTimer(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

/** React to active-state flips: on becoming active refresh NOW (so nothing reads
 *  stale on return) and arm the timer; on going inactive stop the timer dead. */
function onActiveChange(): void {
  if (!started) return
  if (isActive()) { void refresh(); startTimer() }
  else stopTimer()
}

function startLoop(): void {
  if (started) return
  started = true
  // Refresh on registry changes (office spawn/remove) so the footprint updates
  // promptly — but only while active; re-activation refreshes anyway.
  unsubChanged = api().onAgentsChanged(() => { if (isActive()) void refresh() })
  unsubActive = subscribeWindowActive(onActiveChange)
  if (isActive()) { void refresh(); startTimer() }
}
function stopLoop(): void {
  if (!started) return
  started = false
  unsubChanged?.(); unsubChanged = null
  unsubActive?.(); unsubActive = null
  stopTimer()
}

function acquire(): void {
  refCount++
  if (teardownTimer) { clearTimeout(teardownTimer); teardownTimer = null }
  if (refCount === 1) startLoop()
}
function release(): void {
  refCount = Math.max(0, refCount - 1)
  if (refCount === 0 && !teardownTimer) {
    // Defer teardown a tick so StrictMode's mount→unmount→mount doesn't thrash.
    teardownTimer = setTimeout(() => { teardownTimer = null; if (refCount === 0) stopLoop() }, 0)
  }
}

/* ----------------------------------------------------------------- actions -- */

/** Toggle whether the Office tab is foregrounded — pauses the poll when it isn't. */
export function setVisible(v: boolean): void {
  const was = visible
  visible = v
  if (v && !was) onActiveChange() // refresh on re-show if now active
}

/* ------------------------------------------------------------------- hooks -- */

function subscribeLoops(cb: () => void): () => void {
  acquire(); loopListeners.add(cb)
  return () => { loopListeners.delete(cb); release() }
}
function subscribeSlugs(cb: () => void): () => void {
  acquire(); slugListeners.add(cb)
  return () => { slugListeners.delete(cb); release() }
}

/**
 * useLocalLoops() → Map<slug|id (lowercased) → LocalLoopOwner>
 * Same-host autodev loops this app didn't spawn. Stable ref while unchanged, so a
 * poll that returns identical data triggers zero re-renders.
 */
export function useLocalLoops(): Map<string, LocalLoopOwner> {
  return useSyncExternalStore(subscribeLoops, () => loops)
}

/**
 * useLocalOfficeSlugs() → Set<lowercased office slug>
 * Offices with an on-disk workspace on this machine.
 */
export function useLocalOfficeSlugs(): Set<string> {
  return useSyncExternalStore(subscribeSlugs, () => slugs)
}
