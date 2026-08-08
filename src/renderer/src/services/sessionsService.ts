/**
 * sessionsService — the SESSIONS / CHAT-SESSION service.
 *
 * Owns *all* session discovery, transcript state, the claude live-tail
 * subscription, and the interactive-PTY (Resume / New) lifecycle at MODULE
 * scope (two `useSyncExternalStore`-bridged singletons), so a live session's
 * transcript + live-tail survive `SessionsView` being unmounted/hidden. This is
 * Stage 1 of the services refactor (docs/redesign/ARCHITECTURE-REVIEW.md §2.3):
 * data-fetch + subscriptions + PTY lifecycle move OUT of the view, which becomes
 * a thin consumer of the hooks below. Keep-alive PTY semantics are preserved —
 * the `term` identity lives in the store; the view still renders one MOUNTED
 * `<TerminalPane>` (display:none while a transcript is peeked) so the PTY is
 * never SIGKILLed by a remount. Later phases can move these singletons into the
 * main process without changing the hook surface.
 *
 * ── Hooks ──────────────────────────────────────────────────────────────────
 *
 *  useSessions(opts?): SessionsList
 *    opts?: { provider?: ProviderFilter; query?: string; active?: boolean }
 *    → {
 *        list, shown, groups, groupOrder, liveCount, total,
 *        providerCount(p), loading, refresh()
 *      }
 *    One shared `sessionsDiscover()` seed + 5s poll (poll gated on `active`, so a
 *    hidden tab stops rescanning the FS; an immediate refresh fires on
 *    reactivation). `provider`/`query` filter + mtime-sort + time-bucket the
 *    shared list per-subscriber (cheap, memoized) — the discovery pipeline itself
 *    is single-instance regardless of how many views subscribe.
 *
 *  useSessionTranscript(sessionRef): SessionTranscript
 *    sessionRef: SessionMeta | null   (drives which session is open)
 *    → { session, messages, streaming, loading, workspace }
 *    Owns the backlog fetch + claude live-tail append + the monotonic open-token
 *    (stale-open guard) as a SERVICE concern. Passing a new non-null ref opens it
 *    (idempotent — re-passing the already-open session is a no-op); passing null
 *    does NOT tear the transcript down (that would defeat survive-unmount) — use
 *    the `backToTerminal` action to deselect explicitly.
 *
 *  useSessionActions(): SessionActions
 *    → {
 *        term, exportNote, connect{open,offices,officeSel,err,busy},
 *        open(session), resume(session), confirmResume(), cancelResume(),
 *        setOfficeSel(slug), newSession(), interject(cwd,text), exportTrace(cwd),
 *        backToTerminal(), closeTerm(), clearExportNote()
 *      }
 *    The imperative surface. `open(session)` selects+opens a transcript (same as
 *    passing a ref to useSessionTranscript). `resume(session)` opens the
 *    connect-into-office bar; `confirmResume()` binds it and swaps in a live
 *    Operate PTY. `newSession()` spawns a fresh interactive PTY. All PTY-replacing
 *    actions gate behind the app's native destructive-confirm so a running
 *    session is never dropped silently. All action fns are stable references.
 *
 * Backend contract: window.api (src/preload/index.ts). onSessionData returns an
 * unsubscribe fn; it is installed ONCE at module load and intentionally never
 * torn down, so the live-tail keeps filling the store while the view is unmounted.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  type SessionMeta,
  type SessionMsg,
  type ProviderFilter,
  type GroupId,
  baseName,
  keyOf,
  groupOf
} from '../components/sessions/types'

// Re-exported so the migrated view imports its vocabulary from one place.
export type { SessionMeta, SessionMsg, ProviderFilter, GroupId }

/** Fixed render order of the time-bucket sections. */
export const GROUP_ORDER: GroupId[] = ['live', 'today', 'yesterday', 'earlier']

/** A pixel office (Resume-into-office target). */
export interface Office {
  slug: string
  id: number
  name: string
}

/** A live interactive PTY (Resume/New) — identity lives here so it survives unmount. */
export interface TermState {
  id: string
  cwd: string
  command?: string
  name?: string
}

/** Transient export result surfaced in the transcript header. */
export interface ExportNote {
  kind: 'ok' | 'error'
  text: string
}

// ───────────────────────────────── tiny store ──────────────────────────────

interface Store<T> {
  get: () => T
  set: (patch: Partial<T> | ((s: T) => Partial<T>)) => void
  subscribe: (listener: () => void) => () => void
}

function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (patch) => {
      const p = typeof patch === 'function' ? (patch as (s: T) => Partial<T>)(state) : patch
      state = { ...state, ...p }
      for (const l of listeners) l()
    },
    subscribe: (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    }
  }
}

// ─────────────────────────────── discovery store ───────────────────────────

interface DiscoveryState {
  list: SessionMeta[]
  loading: boolean
}

const discoveryStore = createStore<DiscoveryState>({ list: [], loading: true })

let discoverInflight: Promise<void> | null = null

/** Rescan the filesystem for sessions across all providers (deduped in-flight). */
async function discover(): Promise<void> {
  if (discoverInflight) return discoverInflight
  discoverInflight = (async () => {
    try {
      const l = (await window.api.sessionsDiscover()) as SessionMeta[]
      discoveryStore.set({ list: Array.isArray(l) ? l : [], loading: false })
    } catch (e) {
      console.error('[sessionsService.discover]', e)
      discoveryStore.set({ loading: false })
    } finally {
      discoverInflight = null
    }
  })()
  return discoverInflight
}

// Reference-counted active poll: runs only while ≥1 subscriber wants it live.
let activeCount = 0
let pollTimer: ReturnType<typeof setInterval> | null = null

function retainActivePoll(): void {
  activeCount += 1
  if (activeCount === 1) {
    void discover() // immediate refresh on (re)activation
    if (!pollTimer) pollTimer = setInterval(() => void discover(), 5000)
  }
}

function releaseActivePoll(): void {
  activeCount = Math.max(0, activeCount - 1)
  if (activeCount === 0 && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// ─────────────────────────────── transcript store ──────────────────────────

interface ConnectState {
  open: boolean
  offices: Office[]
  officeSel: string
  err: string
  busy: boolean
  /** The session a pending Resume-into-office bar is bound to. */
  target: SessionMeta | null
}

interface TranscriptState {
  current: SessionMeta | null
  messages: SessionMsg[]
  streaming: boolean
  loading: boolean
  workspace: { exists: boolean } | null
  exportNote: ExportNote | null
  term: TermState | null
  connect: ConnectState
}

const EMPTY_CONNECT: ConnectState = { open: false, offices: [], officeSel: '', err: '', busy: false, target: null }

const transcriptStore = createStore<TranscriptState>({
  current: null,
  messages: [],
  streaming: false,
  loading: false,
  workspace: null,
  exportNote: null,
  term: null,
  connect: EMPTY_CONNECT
})

// The claude live-tail file currently open (null for non-claude sessions).
let selFile: string | null = null
// Monotonic open token: openSession awaits a per-provider backlog (a CLI
// subprocess for non-claude, variable latency), so opening A then B can let a
// slow A resolve last and overwrite B's transcript. Each open bumps this; after
// every await we bail if a newer open has started.
let openSeq = 0

// Live tail — installed ONCE, never torn down, so incoming claude lines keep
// filling the store even while SessionsView is unmounted/hidden.
if (typeof window !== 'undefined' && window.api?.onSessionData) {
  window.api.onSessionData(({ file, msgs: incoming }: { file: string; msgs: unknown[] }) => {
    if (file !== selFile) return
    const cur = transcriptStore.get().messages
    const next = [...cur, ...(incoming as SessionMsg[])]
    transcriptStore.set({ messages: next.length > 1000 ? next.slice(-1000) : next })
  })
}

/** Open a session's transcript: backlog fetch + claude live-tail + stale guard. */
async function openSession(s: SessionMeta): Promise<void> {
  const seq = ++openSeq
  const prev = selFile
  selFile = s.provider === 'claude' ? s.file : null
  // NOTE: never clear `term` here — the terminal and transcript are visually
  // mutually exclusive, but the view keeps the PTY pane MOUNTED (hidden) so
  // peeking another session never silently kills a running Resume/New PTY.
  transcriptStore.set((st) => ({
    current: s,
    messages: [],
    streaming: !!s.live,
    loading: true,
    workspace: null,
    exportNote: null,
    connect: { ...st.connect, open: false }
  }))
  try {
    if (prev && prev !== selFile) await window.api.sessionClose(prev)
    const backlog = (await window.api.sessionBacklog({
      file: s.file,
      provider: s.provider,
      id: s.id,
      cwd: s.cwd
    })) as SessionMsg[]
    if (seq !== openSeq) return
    transcriptStore.set({ messages: backlog, loading: false })
    if (s.provider === 'claude' && s.file) await window.api.sessionOpen(s.file)
  } catch (e) {
    console.error('[sessionsService.openSession]', e)
    if (seq === openSeq) transcriptStore.set({ loading: false })
  }
  try {
    const info = (await window.api.workspaceInfo(s.cwd)) as { exists: boolean }
    if (seq !== openSeq) return
    transcriptStore.set({ workspace: { exists: !!info?.exists } })
  } catch {
    if (seq === openSeq) transcriptStore.set({ workspace: { exists: false } })
  }
}

/** Return to a live terminal hidden behind a peeked transcript (keeps `term`). */
async function backToTerminal(): Promise<void> {
  if (selFile) {
    await window.api.sessionClose(selFile)
    selFile = null
  }
  transcriptStore.set((st) => ({
    current: null,
    messages: [],
    exportNote: null,
    connect: { ...st.connect, open: false }
  }))
}

/** End the live PTY session & close the pane. */
function closeTerm(): void {
  transcriptStore.set({ term: null })
}

/** Spawn a fresh interactive claude PTY in a picked folder (confirm-gated). */
async function newSession(): Promise<void> {
  const cwd = (await window.api.pickFolder()) as string | null
  if (!cwd) return
  const term = transcriptStore.get().term
  // Replacing a live `term` remounts the pane → its cleanup kills the PTY. Never
  // do that silently: gate behind the app's native destructive-confirm dialog.
  if (
    term &&
    !(await window.api.confirmDialog(
      `End the live "${term.name ?? 'claude'}" session?`,
      `Starting a new session in\n${cwd}\nwill terminate the session running in\n${term.cwd}`
    ))
  )
    return
  if (selFile) {
    await window.api.sessionClose(selFile)
    selFile = null
  }
  transcriptStore.set({ current: null, messages: [], term: { id: `pty-${Date.now()}`, cwd } })
}

/** Open the Resume-into-office connect bar for a claude session. */
async function resume(session: SessionMeta): Promise<void> {
  const st = (await window.api.officeStatus()) as { connected: boolean }
  if (!st.connected) {
    const ok = await window.api.officeAutoConnect()
    if (!ok) {
      transcriptStore.set((s) => ({
        connect: { ...s.connect, open: true, err: 'Connect a pixel-office first (Office tab).', target: session }
      }))
      return
    }
  }
  let offs: Office[] = []
  try {
    offs = (await window.api.officeOffices()) as Office[]
  } catch (e) {
    transcriptStore.set((s) => ({
      connect: {
        ...s.connect,
        open: true,
        offices: [],
        err: String((e as Error)?.message ?? e) || 'Could not load your offices — reconnect.',
        target: session
      }
    }))
    return
  }
  transcriptStore.set({
    connect: { open: true, offices: offs, officeSel: offs[0]?.slug ?? '', err: '', busy: false, target: session }
  })
}

/** Bind the selected office and swap in a live Operate PTY (confirm-gated). */
async function confirmResume(): Promise<void> {
  const c = transcriptStore.get().connect
  const sel = c.target
  const off = c.offices.find((o) => o.slug === c.officeSel)
  if (!off || !sel) return
  const term = transcriptStore.get().term
  if (
    term &&
    !(await window.api.confirmDialog(
      `End the live "${term.name ?? 'claude'}" session?`,
      `Resuming this session will terminate the session running in\n${term.cwd}`
    ))
  )
    return
  transcriptStore.set((s) => ({ connect: { ...s.connect, busy: true, err: '' } }))
  const r = (await window.api.officeConnectSession(off.slug, off.id, sel.cwd, sel.id, sel.title)) as {
    cwd: string
    sessionId: string
    agentName: string
    error?: string
  }
  if (r?.error) {
    transcriptStore.set((s) => ({ connect: { ...s.connect, busy: false, err: r.error as string } }))
    return
  }
  if (selFile) {
    await window.api.sessionClose(selFile)
    selFile = null
  }
  transcriptStore.set((s) => ({
    current: null,
    messages: [],
    connect: { ...s.connect, busy: false, open: false },
    term: {
      id: `op-${Date.now()}`,
      cwd: r.cwd,
      command: `claude --resume ${r.sessionId}`,
      name: `${r.agentName} · live`
    }
  }))
}

/** Dismiss the Resume-into-office bar without binding. */
function cancelResume(): void {
  transcriptStore.set((s) => ({ connect: { ...s.connect, open: false } }))
}

/** Update the selected office in the Resume bar. */
function setOfficeSel(slug: string): void {
  transcriptStore.set((s) => ({ connect: { ...s.connect, officeSel: slug } }))
}

/**
 * Queue a message into a session's workspace TODO.md (the closest real write —
 * no api injects into a read transcript). Rejects a non-AutoDev cwd; the {error}
 * is surfaced so the composer keeps the draft instead of discarding it.
 */
async function interject(cwd: string, text: string): Promise<{ error?: string }> {
  const r = (await window.api.sendAgentMessage(cwd, text)) as { ok: true } | { error: string }
  if ('error' in r) return { error: r.error }
  return {}
}

/** Export a session's trace (grok native trace / backup zip) to a chosen file. */
async function exportTrace(cwd: string): Promise<void> {
  const cur = transcriptStore.get().current
  transcriptStore.set({ exportNote: null })
  const defName =
    cur && cur.cwd === cwd ? `${cur.provider}-${cur.id.slice(0, 8)}.trace.txt` : `${baseName(cwd)}.trace.txt`
  const out = (await window.api.saveFile(defName)) as string | null
  if (!out) return
  const r = await window.api.exportTrace(cwd, out)
  if ('error' in r) {
    transcriptStore.set({ exportNote: { kind: 'error', text: r.error } })
    return
  }
  transcriptStore.set({
    exportNote: { kind: 'ok', text: r.note ? `Exported to ${r.output} — ${r.note}` : `Exported to ${r.output}` }
  })
}

/** Clear the transient export note. */
function clearExportNote(): void {
  transcriptStore.set({ exportNote: null })
}

// ───────────────────────────────────── hooks ───────────────────────────────

export interface SessionsList {
  /** Raw discovered sessions (unfiltered). */
  list: SessionMeta[]
  /** Filtered (provider + query) and mtime-desc sorted. */
  shown: SessionMeta[]
  /** `shown` bucketed by time group. */
  groups: Record<GroupId, SessionMeta[]>
  /** Fixed render order of the groups. */
  groupOrder: GroupId[]
  /** Count of live sessions across the whole (unfiltered) list. */
  liveCount: number
  /** Total discovered sessions. */
  total: number
  /** Count of sessions for a provider filter (`'all'` = everything). */
  providerCount: (p: ProviderFilter) => number
  loading: boolean
  /** Force an immediate rescan. */
  refresh: () => Promise<void>
}

export function useSessions(opts?: {
  provider?: ProviderFilter
  query?: string
  active?: boolean
}): SessionsList {
  const provider = opts?.provider ?? 'all'
  const query = opts?.query ?? ''
  const active = opts?.active ?? true

  const { list, loading } = useSyncExternalStore(discoveryStore.subscribe, discoveryStore.get)

  // Always seed once on mount so a hidden (inactive) view still has data.
  useEffect(() => {
    void discover()
  }, [])

  // Poll only while active (a hidden tab stops rescanning the FS).
  useEffect(() => {
    if (!active) return
    retainActivePoll()
    return () => releaseActivePoll()
  }, [active])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list
      .filter((s) => provider === 'all' || s.provider === provider)
      .filter(
        (s) =>
          !q ||
          s.title.toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q)
      )
      .sort((a, b) => b.mtime - a.mtime)
  }, [list, provider, query])

  const groups = useMemo(() => {
    const map: Record<GroupId, SessionMeta[]> = { live: [], today: [], yesterday: [], earlier: [] }
    for (const s of shown) map[groupOf(s)].push(s)
    return map
  }, [shown])

  const liveCount = useMemo(() => list.filter((s) => s.live).length, [list])

  const providerCount = useCallback(
    (p: ProviderFilter) => (p === 'all' ? list.length : list.filter((s) => s.provider === p).length),
    [list]
  )

  return {
    list,
    shown,
    groups,
    groupOrder: GROUP_ORDER,
    liveCount,
    total: list.length,
    providerCount,
    loading,
    refresh: discover
  }
}

export interface SessionTranscript {
  session: SessionMeta | null
  messages: SessionMsg[]
  /** True while the open session is live (drives the STREAMING/typing UI). */
  streaming: boolean
  /** True while the backlog is being fetched. */
  loading: boolean
  /** Whether the open session's cwd is a writable AutoDev workspace, or null while probing. */
  workspace: { exists: boolean } | null
}

export function useSessionTranscript(sessionRef: SessionMeta | null): SessionTranscript {
  const snap = useSyncExternalStore(transcriptStore.subscribe, transcriptStore.get)

  const refKey = sessionRef ? keyOf(sessionRef) : null
  useEffect(() => {
    if (!sessionRef) return // null never tears down — deselect via backToTerminal()
    const cur = transcriptStore.get().current
    if (!cur || keyOf(cur) !== keyOf(sessionRef)) void openSession(sessionRef)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey])

  return {
    session: snap.current,
    messages: snap.messages,
    streaming: snap.streaming,
    loading: snap.loading,
    workspace: snap.workspace
  }
}

export interface SessionConnectBar {
  open: boolean
  offices: Office[]
  officeSel: string
  err: string
  busy: boolean
}

export interface SessionActions {
  /** The live interactive PTY (Resume/New), or null. Survives view unmount. */
  term: TermState | null
  /** Transient export result for the transcript header. */
  exportNote: ExportNote | null
  /** Resume-into-office connect bar state. */
  connect: SessionConnectBar
  /** Select + open a session's transcript (same effect as passing a ref to useSessionTranscript). */
  open: (session: SessionMeta) => Promise<void>
  /** Open the Resume-into-office connect bar for a claude session. */
  resume: (session: SessionMeta) => Promise<void>
  /** Bind the selected office and swap in a live Operate PTY. */
  confirmResume: () => Promise<void>
  /** Dismiss the Resume bar. */
  cancelResume: () => void
  /** Change the selected office in the Resume bar. */
  setOfficeSel: (slug: string) => void
  /** Spawn a fresh interactive claude PTY in a picked folder. */
  newSession: () => Promise<void>
  /** Queue a message into a session workspace's TODO.md. */
  interject: (cwd: string, text: string) => Promise<{ error?: string }>
  /** Export a session's trace to a chosen file. */
  exportTrace: (cwd: string) => Promise<void>
  /** Deselect the transcript, returning to a hidden live terminal (keeps the PTY). */
  backToTerminal: () => Promise<void>
  /** End the live PTY & close the pane. */
  closeTerm: () => void
  /** Clear the export note. */
  clearExportNote: () => void
}

export function useSessionActions(): SessionActions {
  const snap = useSyncExternalStore(transcriptStore.subscribe, transcriptStore.get)
  return {
    term: snap.term,
    exportNote: snap.exportNote,
    connect: {
      open: snap.connect.open,
      offices: snap.connect.offices,
      officeSel: snap.connect.officeSel,
      err: snap.connect.err,
      busy: snap.connect.busy
    },
    open: openSession,
    resume,
    confirmResume,
    cancelResume,
    setOfficeSel,
    newSession,
    interject,
    exportTrace,
    backToTerminal,
    closeTerm,
    clearExportNote
  }
}
