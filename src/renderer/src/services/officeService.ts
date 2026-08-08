/**
 * services/officeService.ts — the SINGLE owner of the pixel-office connection,
 * the office/character list, and the per-character conversation streams.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Before Stage 1 this all lived in view state: OfficeView owned the connection
 * probe, the 8s `officeAgents()` poll, the flat→offices fold, the auth-expiry /
 * empty-poll keep-alive guards, and a 5s `officeMessages()` poll for the focused
 * character; ChatTab independently ran its OWN 4s `officeMessages()` poll for the
 * same conversation. So the office data lived-and-died with a view mount and the
 * SAME conversation was fetched twice. This module collapses that into ONE store:
 *   • ONE connection probe (officeStatus + autoConnect), resolved once.
 *   • ONE 8s office-list poll, folded to offices, with the normalize(id→string)
 *     and empty-poll keep-alive guards applied ONCE at the ingest boundary.
 *   • ONE conversation poll PER (office, character), SHARED by every consumer
 *     (OfficeView's stream + room AND ChatTab) — subscribe twice, fetch once.
 *
 * ── Keep-alive / auth-expiry semantics (now service-level concerns) ──────────
 * A running Operate PTY must never be torn down by a data blip:
 *   • Empty poll: an `officeAgents()` that returns [] while termRegistry has live
 *     terms is REJECTED — the last-known list is kept and a soft notice is set.
 *   • Auth expiry: an auth error tries `officeAutoConnect()` recovery first; if
 *     that fails while live terms exist, we surface a soft "needs reconnect" notice
 *     and stay connected (never bounce to the login form under a live PTY); only
 *     with NO live terms do we drop to `connected:false` + the expired error.
 * Whether terms are live is asked of services/termRegistry (the PTY owner), so the
 * two stores stay decoupled — officeService reads it, never the reverse.
 *
 * ── Ref-counted lifecycle ────────────────────────────────────────────────────
 * The connection probe + poll start on the FIRST hook mount and stop on the LAST
 * unmount (deferred one tick so StrictMode's mount→unmount→mount and fast tab
 * flips don't thrash the socket/poll). The list poll only TICKS while connected
 * and visible (setVisible mirrors OfficeView's `visible` prop); a window `focus`
 * triggers an immediate refresh.
 *
 * ────────────────────────────────────────────────────────────── public API ──
 * Hooks:
 *   useOffice() → {
 *     offices, agents, connected, ready, loaded, loading, listError, authError,
 *     base, email, baseUrlPlaceholder,
 *     connect(base,email,password), disconnect(), reconnect(), refresh(), setVisible(v)
 *   }
 *       The office list (folded from the flat character list) plus connection
 *       state and the connect/disconnect/reconnect/refresh actions. `listError` is
 *       the soft keep-alive notice; `authError` is the hard expiry (only ever set
 *       when NO live terms exist).
 *
 *   useOfficeAgents(officeSlug) → { group, agents, onlineCount, loaded }
 *       The characters in ONE office, selected from the shared list. The
 *       normalize(id→string) + empty-poll guards live in the store, not here.
 *
 *   useOfficeMessages(officeSlug, ref, { active? }) →
 *       { messages, loading, error, resolvedAgentId }
 *       The live conversation for ONE character (`ref` = its office-agent id OR
 *       slug), SHARED by OfficeView's stream/room and ChatTab. Consumers own their
 *       own scroll (this hook is at-bottom-safe: it never forces a scroll and
 *       preserves the last transcript on a transient poll error). `active:false`
 *       (a hidden/off-screen consumer) pauses ITS polling while keeping the last
 *       transcript — the shared poll keeps running only while ≥1 active consumer
 *       is watching. An empty `ref` yields an inert empty snapshot (no fetch).
 *
 * Command (addressable, not a hook):
 *   steer(agentId, text) → Promise<{ ok: true } | { error }>
 *       Deliver a live instant-message (NOT a queued TODO task). On success it
 *       optimistically echoes a `you` message into any open conversation for that
 *       agent, reconciled by the next poll.
 *
 * Imperative reads (event handlers): getOffices() · getOfficeAgents(slug) ·
 *   getConnection().
 *
 * No JSX, no design tokens — this is the office data layer the views consume.
 * The interactive Operate/log terminals are owned by services/termRegistry; the
 * streamed log TEXT buffer by services/logBuffer.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  normalizeAgents,
  isAuthError,
  type OfficeAgent,
  type OfficeGroup,
  type ChatMessage,
  type RawOfficeAgent
} from '../components/office/officeTypes'
import * as termRegistry from './termRegistry'

/* ------------------------------------------------------------------ config -- */

const POLL_MS = 8000 // office-list cadence (matches OfficeView)
const MSG_POLL_MS = 4000 // conversation cadence (tighter of OfficeView 5s / ChatTab 4s)

const EXPIRED = 'Your office session expired — please sign in again.'
const SOFT_RECONNECT = 'Office session needs reconnect — your running session is unaffected.'
const EMPTY_KEEP = 'Office list came back empty — keeping your running session.'
const PARTIAL_KEEP = 'Some offices didn’t load — keeping your running session.'

/** Minimal shape of the preload bridge this store touches. */
type Api = {
  getSettings: () => Promise<{ officeBaseUrl?: string }>
  officeStatus: () => Promise<{ connected: boolean; base?: string; email?: string }>
  officeAutoConnect: () => Promise<boolean>
  officeLogin: (base: string, email: string, password: string) => Promise<{ ok?: boolean; error?: string }>
  officeLogout: () => Promise<unknown>
  officeAgents: () => Promise<RawOfficeAgent[]>
  officeOffices: () => Promise<Array<{ slug: string; id: number; name: string }>>
  officeSteer: (agentId: string, text: string) => Promise<{ ok?: boolean; error?: string }>
  officeMessages: (
    officeSlug: string,
    agentRef: string
  ) => Promise<
    | { ok?: boolean; agentId?: string; agentName?: string; messages?: ChatMessage[] }
    | { error: string }
  >
}
const api = (): Api => (window as unknown as { api: Api }).api

/* ===========================================================================
 * OFFICE + CONNECTION STORE
 * ======================================================================== */

export interface OfficeConnection {
  ready: boolean // connection probe finished (true even when not connected)
  connected: boolean
  base: string
  email: string
  baseUrlPlaceholder: string
  loaded: boolean // at least one successful list fetch
  loading: boolean // initial load / manual refresh in flight (NOT background polls)
  listError: string // soft keep-alive notice
  authError: string // hard expiry — only set when NO live terms exist
}

interface OfficeState extends OfficeConnection {
  agents: OfficeAgent[] // normalized flat character list (stable ref when unchanged)
  offices: OfficeGroup[] // folded from `agents` (stable ref when unchanged)
}

let state: OfficeState = {
  ready: false,
  connected: false,
  base: '',
  email: '',
  baseUrlPlaceholder: 'https://…',
  loaded: false,
  loading: false,
  listError: '',
  authError: '',
  agents: [],
  offices: []
}

const listeners = new Set<() => void>()
function emit(patch: Partial<OfficeState>): void {
  state = { ...state, ...patch }
  listeners.forEach((cb) => cb())
}
function getState(): OfficeState {
  return state
}

/** Fold the flat character list into offices (mirror OfficeView `grouped`). */
function foldOffices(agents: OfficeAgent[]): OfficeGroup[] {
  const m = new Map<string, OfficeGroup>()
  for (const a of agents) {
    let g = m.get(a.officeSlug)
    if (!g) {
      g = { slug: a.officeSlug, name: a.office, agents: [], onlineCount: 0 }
      m.set(a.officeSlug, g)
    }
    g.agents.push(a)
    if (a.online) g.onlineCount++
  }
  return [...m.values()]
}

/** Shallow field-equality for one character (avoid re-render on identical polls). */
function agentEqual(a: OfficeAgent, b: OfficeAgent): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.slug === b.slug &&
    a.status === b.status &&
    a.online === b.online &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.office === b.office &&
    a.officeSlug === b.officeSlug
  )
}
function agentsEqual(a: OfficeAgent[], b: OfficeAgent[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!agentEqual(a[i], b[i])) return false
  return true
}

/**
 * Adopt a freshly fetched list. Applies the normalize(id→string) and empty-poll
 * keep-alive guards ONCE here (the ingest boundary). Reuses the prior array when
 * the data is identical so an unchanged poll triggers zero re-renders, then feeds
 * the present office slugs to termRegistry so it can advance its absence counters.
 */
async function applyAgents(raw: RawOfficeAgent[]): Promise<void> {
  const next = normalizeAgents(Array.isArray(raw) ? raw : [])
  // Empty poll while live terms exist → keep the last-known list (never collapse
  // the office grid and SIGKILL a running Operate PTY on a transient empty 200).
  if (next.length === 0 && termRegistry.hasLiveTerms()) {
    if (state.listError !== EMPTY_KEEP) emit({ listError: EMPTY_KEEP })
    return
  }

  // Partial-poll keep-alive: a NON-empty poll that OMITS an office which still
  // owns a live Operate PTY is almost certainly a partial/paginated response or
  // one office's `/agents` sub-query 500ing under sqlite-lock — NOT a deletion.
  // Confirm the omission against the authoritative `/api/offices` list before we
  // let reconcilePresence advance its absence counters (3 straight → ptyKill):
  // merge the omitted-but-live office's last-known agents back in + raise a soft
  // notice, so the grid and PTY survive. Only a slug truly GONE from `/api/offices`
  // is a confirmed deletion and may reap; if we can't confirm, we keep (never kill
  // a live PTY on a blip). Offices without live terms fold out normally.
  let keptSlugs: Set<string> | null = null
  if (termRegistry.hasLiveTerms()) {
    const nextSlugs = new Set(next.map((a) => a.officeSlug))
    const missingLive = state.offices
      .filter((g) => !nextSlugs.has(g.slug) && termRegistry.listForOffice(g.slug).length > 0)
      .map((g) => g.slug)
    if (missingLive.length) {
      let confirmed: Set<string> | null = null
      try {
        confirmed = new Set((await api().officeOffices()).map((o) => o.slug))
      } catch {
        /* couldn't confirm the office list — keep every omitted-but-live office */
      }
      const keep = missingLive.filter((slug) => confirmed === null || confirmed.has(slug))
      if (keep.length) keptSlugs = new Set(keep)
    }
  }

  const merged =
    keptSlugs === null
      ? next
      : [
          ...next,
          ...state.offices.filter((g) => keptSlugs!.has(g.slug)).flatMap((g) => g.agents)
        ]
  const wantError = keptSlugs ? PARTIAL_KEEP : ''

  if (agentsEqual(merged, state.agents)) {
    if (state.listError !== wantError) emit({ listError: wantError })
  } else {
    const offices = foldOffices(merged)
    emit({ agents: merged, offices, listError: wantError })
  }
  // Slugs kept above are present in the (merged) state.offices, so reconcilePresence
  // never advances an absence counter for an office merely missing from a partial poll.
  termRegistry.reconcilePresence(new Set(state.offices.map((g) => g.slug)))
}

/* --------------------------------------------------------------- fetch ----- */

let listInFlight = false
/** Raw fetch → applyAgents. Throws on IPC/auth failure (caller handles auth). */
async function fetchList(): Promise<void> {
  const raw = (await api().officeAgents()) as RawOfficeAgent[]
  await applyAgents(raw)
  if (!state.loaded) emit({ loaded: true })
}

/**
 * Auth-expiry recovery, keep-alive aware. Try autoConnect + one retry; if that
 * fails while live terms exist, surface a soft notice and STAY connected; only
 * with no live terms do we drop to the login form.
 */
async function handleAuthError(): Promise<void> {
  let recovered = false
  try {
    recovered = !!(await api().officeAutoConnect())
  } catch {
    /* fall through */
  }
  if (recovered) {
    try {
      await fetchList()
      return
    } catch {
      /* fall through */
    }
  }
  if (termRegistry.hasLiveTerms()) {
    emit({ listError: SOFT_RECONNECT })
    return
  }
  emit({ connected: false, loaded: false, authError: EXPIRED })
}

/** Background poll (guarded, silent). */
async function poll(): Promise<void> {
  if (listInFlight) return
  listInFlight = true
  try {
    await fetchList()
  } catch (e) {
    const msg = (e as Error)?.message || ''
    if (isAuthError(msg)) await handleAuthError()
    // non-auth transient: keep the last good snapshot (parity with OfficeView poll)
  } finally {
    listInFlight = false
  }
}

/** Explicit load (initial + manual refresh) — toggles `loading`, surfaces errors. */
async function loadAgents(): Promise<void> {
  emit({ loading: true, listError: '' })
  try {
    await fetchList()
  } catch (e) {
    const msg = (e as Error)?.message || 'Failed to load agents'
    if (isAuthError(msg)) await handleAuthError()
    else emit({ listError: msg })
  } finally {
    emit({ loading: false })
  }
}

/* --------------------------------------------------------------- lifecycle -- */

let refCount = 0
let started = false
let resolved = false
let resolving = false
let visible = true
let pollTimer: ReturnType<typeof setInterval> | null = null
let stopTimer: ReturnType<typeof setTimeout> | null = null

const onFocus = (): void => {
  if (state.connected && visible) void poll()
}

/** Resolve the saved base + probe for a live session, exactly once. */
async function ensureResolved(): Promise<void> {
  if (resolved || resolving) return
  resolving = true
  try {
    const cfg = await api().getSettings()
    const patch: Partial<OfficeState> = {}
    if (cfg?.officeBaseUrl) patch.baseUrlPlaceholder = cfg.officeBaseUrl
    const st = await api().officeStatus()
    if (st?.base) patch.base = st.base
    if (st?.email) patch.email = st.email
    let ok = !!st?.connected
    if (!ok) {
      try {
        ok = !!(await api().officeAutoConnect())
      } catch {
        /* not connected */
      }
    }
    patch.connected = ok
    patch.ready = true
    emit(patch)
    resolved = true
    if (ok) void loadAgents()
  } finally {
    resolving = false
  }
}

function startLoop(): void {
  if (started) return
  started = true
  void ensureResolved()
  pollTimer = setInterval(() => {
    if (state.connected && visible) void poll()
  }, POLL_MS)
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus)
}

function stopLoop(): void {
  if (!started) return
  started = false
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
}

function subscribe(cb: () => void): () => void {
  refCount++
  if (stopTimer) {
    clearTimeout(stopTimer)
    stopTimer = null
  }
  if (refCount === 1) startLoop()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
    refCount = Math.max(0, refCount - 1)
    if (refCount === 0 && !stopTimer) {
      stopTimer = setTimeout(() => {
        stopTimer = null
        if (refCount === 0) stopLoop()
      }, 0)
    }
  }
}

/* ----------------------------------------------------------------- actions -- */

/** Toggle whether the office tab is foregrounded — pauses the list poll when hidden. */
export function setVisible(v: boolean): void {
  const was = visible
  visible = v
  if (v && !was && state.connected) void poll() // refresh on re-show
}

/** Sign in to an office. On success, connect + seed the list. */
export async function connect(
  base: string,
  email: string,
  password: string
): Promise<{ ok: true } | { error: string }> {
  emit({ loading: true, listError: '', authError: '' })
  const r = await api().officeLogin(base, email, password)
  if (r?.error) {
    emit({ loading: false, authError: r.error })
    return { error: r.error }
  }
  emit({ connected: true, base, email, authError: '' })
  resolved = true
  await loadAgents()
  return { ok: true }
}

/**
 * Full user-initiated sign-out: drop the connection + list. Does NOT force-kill
 * open terminals — per the keep-alive rule, PTYs die only via an explicit
 * termRegistry.close/stopAll (call termRegistry.stopAll() alongside if that is
 * the intent). Kept separate so a logout can never silently SIGKILL a live shell.
 */
export async function disconnect(): Promise<void> {
  try {
    await api().officeLogout()
  } catch {
    /* ignore */
  }
  emit({ connected: false, agents: [], offices: [], loaded: false, listError: '', authError: '' })
}

/**
 * Soft reconnect (the inline error-box action). If live terminals exist, re-auth
 * in place and keep them running (mirror the poll-path recovery); otherwise fall
 * back to a full disconnect.
 */
export async function reconnect(): Promise<void> {
  if (termRegistry.hasLiveTerms()) {
    emit({ listError: '' })
    try {
      await api().officeAutoConnect()
    } catch {
      /* loadAgents surfaces auth state */
    }
    void loadAgents()
    return
  }
  await disconnect()
}

/** Manual refresh (the rail's Refresh button). */
export function refresh(): Promise<void> {
  return loadAgents()
}

/* ------------------------------------------------------------- imperative --- */

export function getOffices(): OfficeGroup[] {
  return state.offices
}
export function getOfficeAgents(officeSlug: string): OfficeAgent[] {
  return state.offices.find((g) => g.slug === officeSlug)?.agents ?? []
}
export function getConnection(): OfficeConnection {
  return state
}

/* ------------------------------------------------------------------- hooks -- */

const officeActions = { connect, disconnect, reconnect, refresh, setVisible }

/**
 * useOffice() — the office list + connection state + actions. See the file header
 * for the full shape. The returned object is memoised so it is stable between
 * renders that don't change the store.
 */
export function useOffice(): OfficeState & typeof officeActions {
  const s = useSyncExternalStore(subscribe, getState)
  return useMemo(() => ({ ...s, ...officeActions }), [s])
}

export interface UseOfficeAgents {
  group: OfficeGroup | undefined
  agents: OfficeAgent[]
  onlineCount: number
  loaded: boolean
}

/**
 * useOfficeAgents(officeSlug) — the characters in ONE office, selected from the
 * shared list. The normalize + empty-poll keep-alive guards are applied upstream
 * in the store, so this is a pure selection.
 */
export function useOfficeAgents(officeSlug: string): UseOfficeAgents {
  const s = useSyncExternalStore(subscribe, getState)
  return useMemo<UseOfficeAgents>(() => {
    const group = s.offices.find((g) => g.slug === officeSlug)
    return {
      group,
      agents: group?.agents ?? EMPTY_AGENTS,
      onlineCount: group?.onlineCount ?? 0,
      loaded: s.loaded
    }
  }, [s, officeSlug])
}
const EMPTY_AGENTS: OfficeAgent[] = []

/* ===========================================================================
 * CONVERSATION (MESSAGES) STORE — one shared poll per (office, character)
 * ======================================================================== */

export interface MessagesSnapshot {
  messages: ChatMessage[]
  loading: boolean
  error: string
  resolvedAgentId: string
}
const EMPTY_MSG_SNAP: MessagesSnapshot = { messages: [], loading: false, error: '', resolvedAgentId: '' }

interface MsgEntry {
  slug: string
  ref: string
  listeners: Set<() => void>
  refCount: number
  activeCount: number // consumers currently watching (active:true) — poll while > 0
  loadedOnce: boolean
  inFlight: boolean
  timer: ReturnType<typeof setInterval> | null
  teardownTimer: ReturnType<typeof setTimeout> | null
  snap: MessagesSnapshot
}
const entries = new Map<string, MsgEntry>()
const keyOf = (slug: string, ref: string): string => `${slug}|${ref}`

function emitEntry(e: MsgEntry, patch: Partial<MessagesSnapshot>): void {
  e.snap = { ...e.snap, ...patch }
  e.listeners.forEach((cb) => cb())
}

/** Fetch one conversation. Keeps the last transcript on a transient error; only
 *  shows the error before the first successful load (at-bottom-safe: never clears). */
async function pollEntry(e: MsgEntry, initial: boolean): Promise<void> {
  if (e.inFlight) return
  e.inFlight = true
  if (initial && !e.loadedOnce) emitEntry(e, { loading: true })
  try {
    const r = await api().officeMessages(e.slug, e.ref)
    if ('error' in r) {
      if (isAuthError(r.error)) void handleAuthError()
      if (!e.loadedOnce) emitEntry(e, { error: r.error, loading: false })
      // otherwise keep the last-known transcript silently
    } else {
      e.loadedOnce = true
      emitEntry(e, {
        messages: r.messages ?? [],
        resolvedAgentId: r.agentId ?? e.snap.resolvedAgentId,
        error: '',
        loading: false
      })
    }
  } catch {
    if (!e.loadedOnce) emitEntry(e, { loading: false })
  } finally {
    e.inFlight = false
  }
}

function ensurePolling(e: MsgEntry): void {
  if (e.activeCount > 0 && !e.timer) {
    e.timer = setInterval(() => void pollEntry(e, false), MSG_POLL_MS)
  } else if (e.activeCount === 0 && e.timer) {
    clearInterval(e.timer)
    e.timer = null
  }
}

function subscribeMessages(slug: string, ref: string, cb: () => void, active: boolean): () => void {
  const key = keyOf(slug, ref)
  let e = entries.get(key)
  if (!e) {
    e = {
      slug,
      ref,
      listeners: new Set(),
      refCount: 0,
      activeCount: 0,
      loadedOnce: false,
      inFlight: false,
      timer: null,
      teardownTimer: null,
      snap: EMPTY_MSG_SNAP
    }
    entries.set(key, e)
  }
  // A pending deferred teardown (see below) means a sole subscriber is mid
  // unsub→resub round-trip — e.g. an `active` toggle changing this hook's
  // `subscribe` identity. Cancel it so the entry (and its transcript / optimistic
  // steer echoes) survives instead of being wiped and re-fetched with a flash.
  if (e.teardownTimer) {
    clearTimeout(e.teardownTimer)
    e.teardownTimer = null
  }
  e.listeners.add(cb)
  e.refCount++
  if (active) e.activeCount++
  // First consumer of this conversation gets an initial fetch even if hidden, so a
  // just-opened (but off-screen) view still has a transcript to show on reveal.
  if (e.refCount === 1) void pollEntry(e, true)
  ensurePolling(e)
  return () => {
    if (!e) return
    e.listeners.delete(cb)
    e.refCount = Math.max(0, e.refCount - 1)
    if (active) e.activeCount = Math.max(0, e.activeCount - 1)
    ensurePolling(e)
    // Defer teardown one tick (mirror the office store's stopTimer): a synchronous
    // unsub→resub from an `active` toggle re-enters subscribeMessages and cancels
    // this timer before it fires, so the entry — and the accumulated transcript —
    // is only dropped on a genuine last unmount.
    if (e.refCount === 0 && !e.teardownTimer) {
      e.teardownTimer = setTimeout(() => {
        e!.teardownTimer = null
        if (e!.refCount === 0) {
          if (e!.timer) clearInterval(e!.timer)
          entries.delete(key)
        }
      }, 0)
    }
  }
}

function getMessagesSnapshot(slug: string, ref: string): MessagesSnapshot {
  return entries.get(keyOf(slug, ref))?.snap ?? EMPTY_MSG_SNAP
}

/**
 * useOfficeMessages(officeSlug, ref, { active? }) — the live conversation for one
 * character, shared across every consumer. `active:false` pauses THIS consumer's
 * contribution to the shared poll while keeping the last transcript. An empty
 * `ref` returns an inert empty snapshot with no fetch. See the file header.
 */
export function useOfficeMessages(
  officeSlug: string,
  ref: string,
  opts?: { active?: boolean }
): MessagesSnapshot {
  const active = opts?.active ?? true
  const inert = !ref
  const sub = useCallback(
    (cb: () => void) => (inert ? () => {} : subscribeMessages(officeSlug, ref, cb, active)),
    [officeSlug, ref, active, inert]
  )
  const snap = useCallback(
    () => (inert ? EMPTY_MSG_SNAP : getMessagesSnapshot(officeSlug, ref)),
    [officeSlug, ref, inert]
  )
  return useSyncExternalStore(sub, snap)
}

/**
 * steer(agentId, text) — deliver a live instant-message (NOT a queued task).
 * Optimistically echoes a `you` message into any open conversation whose resolved
 * agent id (or ref) matches, reconciled by the next poll.
 */
export async function steer(
  agentId: string,
  text: string
): Promise<{ ok: true } | { error: string }> {
  if (!agentId || !text) return { error: 'Nothing to send' }
  let r: { ok?: boolean; error?: string }
  try {
    r = await api().officeSteer(agentId, text)
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) }
  }
  if (r?.error) return { error: r.error }
  const echo: ChatMessage = {
    id: `local-${Date.now()}`,
    role: 'user',
    author: 'you',
    text,
    kind: 'steer',
    at: Date.now()
  }
  for (const e of entries.values()) {
    if (e.snap.resolvedAgentId === agentId || e.ref === agentId) {
      emitEntry(e, { messages: [...e.snap.messages, echo] })
    }
  }
  return { ok: true }
}
