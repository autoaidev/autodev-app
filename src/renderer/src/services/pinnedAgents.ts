import { useCallback, useSyncExternalStore } from 'react'

/**
 * usePinnedAgents — a client-side, per-user "pin / favourite" set for office
 * characters, persisted to localStorage PER OFFICE.
 *
 * Pinning is purely a viewer preference: there is NO backend write and no IPC — the
 * pinned set lives only in this renderer's localStorage, keyed
 * `autodev:pinned:<officeKey>` (the office slug or id). A pinned character sorts to
 * the TOP of the office's card grid (and the Chat sidebar, which shares that order).
 *
 * A module-level store backs it (via useSyncExternalStore) so EVERY consumer of the
 * same office key reads one reactive source and stays in lockstep — the star toggle
 * on each card and the pinned-first sort can never disagree. All localStorage access
 * is wrapped in try/catch (private windows throw / block it); a failure degrades to
 * an in-memory set for the session rather than breaking the view.
 */

const PREFIX = 'autodev:pinned:'

// office key → the live pinned Set (the in-session source of truth). Replaced with a
// NEW Set on every mutation so useSyncExternalStore sees a fresh snapshot reference.
const cache = new Map<string, Set<string>>()
// office key → subscriber callbacks (useSyncExternalStore listeners).
const listeners = new Map<string, Set<() => void>>()

function storageKey(officeKey: string): string {
  return PREFIX + officeKey
}

/** Load (and memoize) the pinned set for an office. Stable reference until mutated. */
function load(officeKey: string): Set<string> {
  const cached = cache.get(officeKey)
  if (cached) return cached
  let set = new Set<string>()
  try {
    const raw = localStorage.getItem(storageKey(officeKey))
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) set = new Set(arr.filter((x): x is string => typeof x === 'string'))
    }
  } catch {
    /* private mode / blocked storage — start empty, in-memory only for this session */
  }
  cache.set(officeKey, set)
  return set
}

function persist(officeKey: string, set: Set<string>): void {
  try {
    localStorage.setItem(storageKey(officeKey), JSON.stringify([...set]))
  } catch {
    /* ignore — keep the in-memory set so the toggle still works this session */
  }
}

function emit(officeKey: string): void {
  listeners.get(officeKey)?.forEach((cb) => cb())
}

function subscribe(officeKey: string, cb: () => void): () => void {
  let set = listeners.get(officeKey)
  if (!set) {
    set = new Set()
    listeners.set(officeKey, set)
  }
  set.add(cb)
  return () => {
    set?.delete(cb)
  }
}

/** Toggle one character's pinned state for an office (persists + notifies all consumers). */
export function togglePinned(officeKey: string, agentId: string): void {
  if (!officeKey || !agentId) return
  // Replace the Set identity so useSyncExternalStore's getSnapshot returns a new ref.
  const next = new Set(load(officeKey))
  if (next.has(agentId)) next.delete(agentId)
  else next.add(agentId)
  cache.set(officeKey, next)
  persist(officeKey, next)
  emit(officeKey)
}

export interface PinnedAgents {
  /** The reactive set of pinned character ids for this office. */
  pinned: Set<string>
  /** Whether a character id is pinned. */
  isPinned: (agentId: string) => boolean
  /** Toggle a character's pinned state. */
  toggle: (agentId: string) => void
}

/**
 * Subscribe to (and mutate) the pinned set for one office. `officeKey` is the office
 * slug (or id); pass '' when no office is selected — that reads a stable empty set and
 * toggles no-op.
 */
export function usePinnedAgents(officeKey: string): PinnedAgents {
  const pinned = useSyncExternalStore(
    useCallback((cb: () => void) => subscribe(officeKey, cb), [officeKey]),
    () => load(officeKey)
  )
  const isPinned = useCallback((agentId: string) => pinned.has(agentId), [pinned])
  const toggle = useCallback((agentId: string) => togglePinned(officeKey, agentId), [officeKey])
  return { pinned, isPinned, toggle }
}
