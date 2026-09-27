/**
 * services/agentStore.ts — the SINGLE source of truth for the live agent fleet.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Before Stage 1 the fleet array was fetched, subscribed and polled THREE times
 * independently — App.tsx (counts), views/AgentsView.tsx (append-unknown merge +
 * log buffer) and views/FleetView.tsx (trackElapsed merge). Each mounted its own
 * `listAgents()` seed, its own `onAgentsChanged`/`onAgentUpdated` listeners and
 * its own 5s `setInterval`, and state lived-and-died with the view's mount. This
 * module collapses all of that into ONE module-level store exposed through hooks,
 * so the data outlives any single view and every consumer sees one coherent list.
 *
 * ── One of everything ────────────────────────────────────────────────────────
 *  • ONE seed            — window.api.listAgents() on first hook mount
 *  • ONE onAgentsChanged — full reload (structure changed: add/remove)
 *  • ONE onAgentUpdated  — canonical merge: in-place patch by path, append-unknown
 *  • ONE 5s poll         — reconciled reload (keeps refs stable when unchanged)
 *  • ONE elapsed tracker — trackElapsed() maintains per-agent current-task "since"
 *                          (union of FleetView's startedRef logic), ticked by a
 *                          slow clock so "elapsed" stays live without re-fetching.
 *
 * ── Ref-counted lifecycle ────────────────────────────────────────────────────
 * The seed + subscriptions + intervals start on the FIRST hook mount and stop on
 * the LAST unmount (with a micro-deferred teardown so React 18 StrictMode's
 * mount→unmount→mount and rapid tab flips don't thrash the socket/poll).
 *
 * ── Public API (each hook documented at its definition) ──────────────────────
 *  useAgents(): AgentState[]                      — the whole fleet, live
 *  useAgent(path): AgentState | undefined         — one agent, re-renders only on ITS change
 *  useFleetCounts(): { running, needsYou, total } — the nav/shell tallies
 *  useAgentElapsed(path): number | null           — ms in the current task (null if not working)
 *  getAgents() / getAgent(path) / getElapsedMs(path) — imperative reads (event handlers)
 *  actions: start(path, provider?) · stop(path) · restart(path) · remove(path) · openFolder(path)
 *
 * Pure model (AgentState, ATTENTION_STATES, helpers) lives in ./model — this file
 * owns only data-fetch, subscriptions, merge and lifecycle. No JSX, no design
 * tokens: it is the data layer the views consume.
 *
 * NOTE: the per-agent streamed LOG buffer (onAgentLog) that AgentsView keeps is a
 * separate concern (a text ring buffer, not part of AgentState) and is NOT owned
 * here — only the AgentState fetch/subscribe/poll loop is unified. A future
 * logStore can mirror this pattern; the AgentState loop each view ran is replaced.
 */
import { useSyncExternalStore } from 'react'
import { needsUserAttention, agentEqual, type AgentState } from './model'

/* ------------------------------------------------------------------ config -- */

const POLL_MS = 5000 // full reconciled reload cadence (matches the 3 legacy loops)
const CLOCK_MS = 15000 // elapsed-clock tick (matches FleetView's `now` clock)
const RESTART_GAP_MS = 400 // let a child fully exit before respawn (AgentsView parity)

/** Minimal shape of the preload bridge this store touches. */
type Api = {
  listAgents: () => Promise<AgentState[]>
  startAgent: (path: string, provider?: string) => Promise<unknown>
  stopAgent: (path: string, keepLeader?: boolean) => Promise<unknown>
  removeAgentFolder: (path: string) => Promise<unknown>
  ptyKill: (id: string) => Promise<unknown>
  openPath: (p: string) => Promise<unknown>
  onAgentsChanged: (cb: () => void) => () => void
  onAgentUpdated: (cb: (s: AgentState) => void) => () => void
}
const api = (): Api => (window as unknown as { api: Api }).api

/* ------------------------------------------------------------- module state -- */

type Counts = { running: number; needsYou: number; total: number }

let agents: AgentState[] = [] // stable ref — only replaced when the data changes
let byPath = new Map<string, AgentState>() // rebuilt each commit; entry refs stay stable
let counts: Counts = { running: 0, needsYou: 0, total: 0 } // stable ref when unchanged

// Elapsed tracking (union of FleetView.trackElapsed): path → the current task and
// the ms timestamp we FIRST observed it. Elapsed resets on relaunch (no per-task
// start time is surfaced by the backend) and is recomputed against `nowTs`.
const started = new Map<string, { task: string; since: number }>()
let nowTs = Date.now()

// Two notify channels so the 15s elapsed clock doesn't re-render list/count
// consumers — only elapsed subscribers wake on a tick.
const dataListeners = new Set<() => void>()
const elapsedListeners = new Set<() => void>()

// Lifecycle: subscriptions + intervals live only while ≥1 hook is mounted.
let refCount = 0
let unsubChanged: (() => void) | null = null
let unsubUpdated: (() => void) | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null
let stopTimer: ReturnType<typeof setTimeout> | null = null
let started_ = false // whether the underlying loop is currently active

/* ------------------------------------------------------------------ commit -- */

function notifyData(): void {
  dataListeners.forEach((cb) => cb())
}
function notifyElapsed(): void {
  elapsedListeners.forEach((cb) => cb())
}

/** Recompute the nav/shell tallies, reusing the old ref when the values match. */
function computeCounts(list: AgentState[]): Counts {
  let running = 0
  let needsYou = 0
  for (const a of list) {
    if (a.running) running++
    // "need you" = genuinely awaiting the user (re-auth / rate-limit / pending
    // choice), NOT crashed/stalled/stopped failures — see needsUserAttention.
    if (needsUserAttention(a)) needsYou++
  }
  if (running === counts.running && needsYou === counts.needsYou && list.length === counts.total) {
    return counts // stable ref → useFleetCounts won't re-render
  }
  return { running, needsYou, total: list.length }
}

/**
 * The elapsed tracker — verbatim union of FleetView.trackElapsed. For every agent
 * that is working ON a named task, remember when we first saw THIS task; drop the
 * record the moment it stops working or the task text changes. Prunes agents that
 * left the fleet. Returns true when anything changed (so we can wake elapsed subs).
 */
function trackElapsed(list: AgentState[]): boolean {
  let changed = false
  const live = new Set<string>()
  const t = Date.now()
  for (const a of list) {
    const working = a.running || a.activity === 'working'
    const task = a.currentTask ?? ''
    if (working && task) {
      live.add(a.path)
      const cur = started.get(a.path)
      if (!cur || cur.task !== task) {
        started.set(a.path, { task, since: t })
        changed = true
      }
    } else if (started.delete(a.path)) {
      changed = true
    }
  }
  for (const key of Array.from(started.keys()))
    if (!live.has(key) && started.delete(key)) changed = true
  return changed
}

/** Adopt a new fleet array as the canonical snapshot and wake subscribers. */
function commit(next: AgentState[]): void {
  if (next === agents) {
    // No structural change to the list, but elapsed bookkeeping may still shift
    // (e.g. a task string changed in place). Keep it consistent.
    if (trackElapsed(agents)) notifyElapsed()
    return
  }
  agents = next
  const map = new Map<string, AgentState>()
  for (const a of next) map.set(a.path, a)
  byPath = map
  counts = computeCounts(next)
  trackElapsed(next)
  notifyData()
  notifyElapsed()
}

/**
 * Full reload reconcile: follow the incoming list order (parity with the legacy
 * setAgents(list)) but REUSE the existing object for any agent whose fields are
 * unchanged, so useSyncExternalStore refs stay stable and a 5s poll that returns
 * identical data triggers zero re-renders.
 */
function reconcile(list: AgentState[]): AgentState[] {
  const next = list.map((incoming) => {
    const prev = byPath.get(incoming.path)
    return prev && agentEqual(prev, incoming) ? prev : incoming
  })
  const sameAsCurrent =
    next.length === agents.length && next.every((a, i) => a === agents[i])
  return sameAsCurrent ? agents : next
}

let reloading = false
async function reload(): Promise<void> {
  if (reloading) return
  reloading = true
  try {
    const list = await api().listAgents()
    commit(reconcile(Array.isArray(list) ? list : []))
  } catch {
    /* transient — keep the last good snapshot (parity with FleetView) */
  } finally {
    reloading = false
  }
}

/** onAgentUpdated merge: in-place patch by path, append when unknown. */
function applyUpdate(s: AgentState): void {
  if (!s || !s.path) return
  const idx = agents.findIndex((a) => a.path === s.path)
  if (idx === -1) {
    commit([...agents, s])
    return
  }
  if (agentEqual(agents[idx], s)) {
    // Fields identical, but the task-elapsed clock may need the fresh observation.
    if (trackElapsed(agents)) notifyElapsed()
    return
  }
  const next = agents.slice()
  next[idx] = s
  commit(next)
}

/* --------------------------------------------------------------- lifecycle -- */

// Visibility gating: a hidden window (app in the tray / another workspace) doesn't
// need the 5s reconcile poll or the elapsed clock — pushed onAgentUpdated events
// still keep state fresh the moment they arrive. Pausing the fixed-cadence timers
// while hidden stops several polls stacking in the background during a demo.
function startTimers(): void {
  if (pollTimer == null) pollTimer = setInterval(() => void reload(), POLL_MS)
  if (clockTimer == null)
    clockTimer = setInterval(() => {
      nowTs = Date.now()
      notifyElapsed()
    }, CLOCK_MS)
}

function stopTimers(): void {
  if (pollTimer) clearInterval(pollTimer)
  if (clockTimer) clearInterval(clockTimer)
  pollTimer = null
  clockTimer = null
}

function onVisibility(): void {
  if (!started_) return
  if (document.visibilityState === 'visible') {
    void reload() // catch up on anything missed while hidden
    startTimers()
  } else {
    stopTimers()
  }
}

function startLoop(): void {
  if (started_) return
  started_ = true
  void reload() // ONE seed
  unsubChanged = api().onAgentsChanged(() => void reload())
  unsubUpdated = api().onAgentUpdated((s) => applyUpdate(s))
  document.addEventListener('visibilitychange', onVisibility)
  // Only run the fixed-cadence timers while the window is actually visible.
  if (document.visibilityState !== 'hidden') startTimers()
}

function stopLoop(): void {
  if (!started_) return
  started_ = false
  unsubChanged?.()
  unsubUpdated?.()
  unsubChanged = null
  unsubUpdated = null
  document.removeEventListener('visibilitychange', onVisibility)
  stopTimers()
}

/** Shared ref-count entry used by every hook's `subscribe`. */
function acquire(): void {
  refCount++
  if (stopTimer) {
    clearTimeout(stopTimer)
    stopTimer = null
  }
  if (refCount === 1) startLoop()
}

function release(): void {
  refCount = Math.max(0, refCount - 1)
  if (refCount === 0 && !stopTimer) {
    // Defer teardown one tick so StrictMode's mount→unmount→mount and fast tab
    // switches don't tear down and re-seed the whole loop needlessly.
    stopTimer = setTimeout(() => {
      stopTimer = null
      if (refCount === 0) stopLoop()
    }, 0)
  }
}

function subscribeData(cb: () => void): () => void {
  acquire()
  dataListeners.add(cb)
  return () => {
    dataListeners.delete(cb)
    release()
  }
}

function subscribeElapsed(cb: () => void): () => void {
  acquire()
  elapsedListeners.add(cb)
  return () => {
    elapsedListeners.delete(cb)
    release()
  }
}

/* ------------------------------------------------------------- imperative --- */

/** Current fleet snapshot without subscribing (for one-shot event handlers). */
export function getAgents(): AgentState[] {
  return agents
}

/** One agent by workspace path, or undefined. */
export function getAgent(path: string): AgentState | undefined {
  return byPath.get(path)
}

/** Milliseconds spent in the current task (null when not working on one). */
export function getElapsedMs(path: string): number | null {
  const rec = started.get(path)
  return rec ? Math.max(0, nowTs - rec.since) : null
}

/**
 * Force an immediate reconciled reload of the fleet. Used after an out-of-band
 * mutation the backend doesn't push a `changed` event for (e.g. registering a
 * freshly-created workspace via `agents:add`), so the new agent shows up at once
 * instead of waiting for the 5s poll. A no-op reconcile (identical data) triggers
 * zero re-renders, so calling it defensively is cheap.
 */
export function refreshAgents(): void {
  void reload()
}

/* ----------------------------------------------------------------- actions -- */

/**
 * Lifecycle actions. Each drives the real preload bridge, then triggers a reload
 * so the snapshot reflects the change even before the next `agent:updated` event.
 * `remove` does NOT prompt — the caller owns confirmation UX (the store is data
 * only) — but it does kill the agent's taken-over terminal PTY so no shell leaks
 * (mirrors AgentsView's teardown).
 */
export const actions = {
  start(path: string, provider?: string): Promise<void> {
    return Promise.resolve(api().startAgent(path, provider)).then(() => void reload())
  },
  stop(path: string): Promise<void> {
    return Promise.resolve(api().stopAgent(path)).then(() => void reload())
  },
  async restart(path: string): Promise<void> {
    try {
      // keepLeader: preserve an always-open grok agent's warm leader/keepalive
      // across the stop→gap→start bounce so the fresh loop re-attaches without a
      // cold reload. No-op for the toggle-OFF / non-grok path (main ignores it).
      await api().stopAgent(path, true)
    } catch {
      /* may not be running */
    }
    await new Promise((r) => setTimeout(r, RESTART_GAP_MS))
    try {
      await api().startAgent(path)
    } catch {
      /* surfaced via state on the next reload */
    }
    void reload()
  },
  async remove(path: string): Promise<void> {
    await api().removeAgentFolder(path)
    void api().ptyKill(`agent-term:${path}`)
    void reload()
  },
  openFolder(path: string): Promise<void> {
    return Promise.resolve(api().openPath(path)).then(() => undefined)
  }
}

/* ------------------------------------------------------------------- hooks -- */

/**
 * useAgents() → AgentState[]
 * The whole live fleet. Re-renders when any agent is added, removed or changed;
 * a poll that returns identical data does NOT re-render (stable snapshot ref).
 */
export function useAgents(): AgentState[] {
  return useSyncExternalStore(subscribeData, getAgents)
}

/**
 * useAgent(path) → AgentState | undefined
 * A single agent. Re-renders ONLY when that agent's own fields change (its object
 * ref is preserved across commits that don't touch it), so a detail view keyed to
 * one agent is undisturbed by fleet-wide churn.
 */
export function useAgent(path: string | undefined): AgentState | undefined {
  return useSyncExternalStore(subscribeData, () => (path ? byPath.get(path) : undefined))
}

/**
 * useFleetCounts() → { running, needsYou, total }
 * The nav-bar / shell tallies (running loops · agents needing you · fleet size).
 * The returned object ref is stable while the numbers hold, so the shell re-renders
 * only when a tally actually moves.
 */
export function useFleetCounts(): Counts {
  return useSyncExternalStore(subscribeData, () => counts)
}

/**
 * useAgentElapsed(path) → number | null
 * Milliseconds the agent has spent in its CURRENT task, or null when it isn't
 * working on one. Ticks live off the store's slow clock (no extra fetch); pair
 * with model.formatElapsed for display.
 */
export function useAgentElapsed(path: string | undefined): number | null {
  return useSyncExternalStore(subscribeElapsed, () => (path ? getElapsedMs(path) : null))
}
