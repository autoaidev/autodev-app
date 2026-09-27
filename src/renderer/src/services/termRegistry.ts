/**
 * services/termRegistry.ts — the SINGLE owner of open Operate/log PTY terminals.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Before Stage 1 the open-terminal list lived in OfficeView local state (`terms`,
 * `activeTermId`, `endedIds`), so it lived-and-died with that view's mount and the
 * "stop everything" command was a DOM `office:stop-all` CustomEvent that only
 * worked *because* keep-alive kept OfficeView mounted to receive it. This module
 * hoists that state to a module-level registry so:
 *   • the term list (and its live PTYs) survive OfficeView unmount, and
 *   • `stopAll()` becomes a REAL, addressable command — it kills the PTYs itself
 *     via `window.api.ptyKill(id)` (the PTY is spawned in main keyed by the term
 *     id, see TerminalPane) rather than relying on a mounted pane to unmount.
 *
 * ── Keep-alive rule (unchanged, now enforced here) ───────────────────────────
 * A live PTY is NEVER killed except on an explicit `close(id)` / `stopAll()`, or a
 * CONFIRMED office deletion (`reconcilePresence` after ABSENT_POLLS_TO_REAP straight
 * absent polls). A single transient absent poll must NOT reap. Log terms are
 * view-only (closing one does not stop the tracked loop — that is
 * `window.api.officeStopOffice`), so `close`/`stopAll` never `ptyKill` a log term.
 *
 * ── Term id encoding (load-bearing) ──────────────────────────────────────────
 * Operate PTY ids:  `op-<officeSlug>-<agentId>`  (a re-operated ENDED pane gets a
 *                    `#<generation>` suffix so React mounts a FRESH pane → new PTY).
 * Log ids:          `log-<officeSlug>-<agentId>`.
 * Ids embed the office slug so terms bucket back to their office even while that
 * office is momentarily absent from a poll (keeps the pane's stable React key so a
 * live PTY is never remounted/killed). Because slugs may contain '-', bucketing
 * resolves each id against the LONGEST known slug (`acme` never swallows `acme-2`).
 *
 * ────────────────────────────────────────────────────────────── public API ──
 * Commands (addressable — callable from anywhere, no view need be mounted):
 *   operate(officeSlug, agent): Promise<{ ok: true; id; reused? } | { error }>
 *       Prepare + open an interactive Operate PTY for one character. Focuses an
 *       existing live pane; re-mints a generation-suffixed id for an ENDED one.
 *   openLogs(officeSlug, officeName, entries): string
 *       Register read-only log terms for a freshly spawned office; returns the id
 *       to focus (''). Does NOT spawn loops — that is officeService/spawnOffice.
 *   close(id): void          — close ONE term (ptyKill if it is a pty; log = view-only).
 *   stopAll(): void          — kill+remove EVERY Operate PTY (log terms untouched).
 *   closeLogsForOffice(slug) — drop an office's log terms (loop stop is separate).
 *   setActiveTerm(id) · markEnded(id) · clearNotice()
 *   reconcilePresence(presentSlugs): void
 *       Feed the set of office slugs present in the latest poll. Reaps the orphan
 *       Operate PTYs of an office that has been absent ABSENT_POLLS_TO_REAP polls
 *       (confirmed server-side deletion) and raises a one-line notice.
 *
 * Imperative reads (event handlers): listForOffice(slug) · getTerms() ·
 *   getActiveId() · getEndedIds() · hasLiveTerms() · getNotice() · getSnapshot()
 *
 * Hook:
 *   useTerms(officeSlug?) → { terms, activeId, endedIds, notice }
 *       Live snapshot for rendering. With a slug, `terms` is scoped to that office
 *       (longest-match bucketed); without, it is every open term. `endedIds` feeds
 *       TerminalTabs; `notice` surfaces a reap/removal message (clearNotice to ack).
 *
 * No JSX, no design tokens — this is the PTY-lifecycle data layer the office view
 * consumes. The streamed log TEXT buffer is a separate concern (services/logBuffer).
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { OpenTerm } from '../TerminalTabs'
import { providerToCommand } from '../components/office/officeTypes'
import type { OfficeAgent } from '../components/office/officeTypes'

/**
 * Consecutive polls an office owning a live Operate PTY must be absent from the
 * agent list before we treat it as truly deleted (vs a transient blip) and reap
 * its orphaned terminals. Mirrors OfficeView.ABSENT_POLLS_TO_REAP.
 */
export const ABSENT_POLLS_TO_REAP = 3

const REMOVED_NOTICE =
  'An office you were operating was removed on the server — its live terminal was closed.'

/** Minimal shape of the preload bridge this registry touches. */
type Api = {
  officeOperate: (
    officeSlug: string,
    agentId: string,
    agentSlug: string,
    provider?: string,
    name?: string
  ) => Promise<{ ok?: boolean; cwd?: string; mcpUrl?: string; command?: string; error?: string }>
  officeEnsureWorkspace: (
    officeSlug: string,
    agentId: string,
    agentSlug: string,
    provider?: string
  ) => Promise<{ ok?: boolean; cwd?: string; error?: string }>
  ptyKill: (id: string) => Promise<unknown>
}
const api = (): Api => (window as unknown as { api: Api }).api

/* ------------------------------------------------------------- module state -- */

let terms: OpenTerm[] = [] // stable ref — replaced only on change
let activeId = ''
let endedIds: ReadonlySet<string> = new Set() // new Set only when it changes
let notice = ''

/** Every office slug we have ever minted a term for — the bucketing dictionary. */
const seenSlugs = new Set<string>()
/** Consecutive-absence counter per pty-owning slug (for reconcilePresence). */
const absence = new Map<string, number>()

const listeners = new Set<() => void>()

/** The public snapshot — one stable object rebuilt only when something changes. */
export interface TermSnapshot {
  terms: OpenTerm[]
  activeId: string
  endedIds: ReadonlySet<string>
  notice: string
}
let snapshot: TermSnapshot = { terms, activeId, endedIds, notice }

function emit(): void {
  snapshot = { terms, activeId, endedIds, notice }
  listeners.forEach((cb) => cb())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Stable snapshot for useSyncExternalStore. */
export function getSnapshot(): TermSnapshot {
  return snapshot
}

/* --------------------------------------------------------------- bucketing -- */

/**
 * The office slug that OWNS a term id — the longest known slug `s` such that the
 * id starts with `op-<s>-` or `log-<s>-`. Longest-first so `acme` never swallows
 * an `acme-2` term. Returns '' when no known slug matches (unbucketed).
 */
function ownerSlug(id: string): string {
  let best = ''
  for (const s of seenSlugs) {
    if (s.length <= best.length) continue
    if (id.startsWith(`op-${s}-`) || id.startsWith(`log-${s}-`)) best = s
  }
  return best
}

/** Terms owned by `officeSlug` (each term resolved to exactly ONE office). */
export function listForOffice(officeSlug: string): OpenTerm[] {
  return terms.filter((t) => ownerSlug(t.id) === officeSlug)
}

/* ----------------------------------------------------------- ended/active --- */

function dropEnded(ids: Iterable<string>): void {
  const next = new Set(endedIds)
  let changed = false
  for (const id of ids) if (next.delete(id)) changed = true
  if (changed) endedIds = next
}

/** Pick the fallback active id after `removed` ids leave, given the next list. */
function reactive(next: OpenTerm[], removed: Set<string>): void {
  if (removed.has(activeId)) activeId = next.length ? next[next.length - 1].id : ''
}

/* ------------------------------------------------------------------ commands */

/**
 * Open (or focus) an interactive Operate PTY for one character. Focuses an
 * existing LIVE pane; for an ENDED pane it drops the stale term and mints a
 * generation-suffixed id so React mounts a fresh pane (a reused id never remounts,
 * so it would never respawn the PTY). Returns the prepared workspace on success.
 */
export async function operate(
  officeSlug: string,
  agent: OfficeAgent
): Promise<{ ok: true; id: string; reused?: boolean } | { error: string }> {
  seenSlugs.add(officeSlug)
  const baseId = `op-${officeSlug}-${agent.id}`
  const existing = terms.find((t) => t.id === baseId || t.id.startsWith(`${baseId}#`))
  if (existing && !endedIds.has(existing.id)) {
    activeId = existing.id
    emit()
    return { ok: true, id: existing.id, reused: true }
  }
  // Pass the character's display name through so the tracked Agents-tab row
  // (registered main-side in the office:operate handler, Change 1) shows the real
  // name ("Project manager") rather than its slug.
  const r = await api().officeOperate(officeSlug, agent.id, agent.slug, agent.provider, agent.name)
  if (r?.error || !r?.cwd) return { error: r?.error || 'Could not prepare the operate workspace' }
  if (existing) {
    terms = terms.filter((t) => t.id !== existing.id)
    dropEnded([existing.id])
  }
  const id = existing ? `${baseId}#${Date.now()}` : baseId
  terms = [
    ...terms,
    {
      id,
      kind: 'pty',
      cwd: r.cwd,
      mcpUrl: r.mcpUrl,
      name: `${agent.name} · ${agent.office}`,
      agentId: agent.id,
      // Prefer the main-resolved resume command (grok --resume <id> / claude
      // --continue) so Operate re-opens the existing session; fall back to the bare
      // provider command when main didn't supply one (ADD 2).
      command: r.command || providerToCommand(agent.provider),
      provider: agent.provider
    }
  ]
  dropEnded([id])
  activeId = id
  emit()
  return { ok: true, id }
}

/**
 * Open (or focus) an interactive `grok login --device-code` terminal for a
 * needs-auth grok character. Prepares the character's OWN scratch workspace (so
 * the login writes grok's credentials where the loop/operate will read them) via
 * ensureWorkspace — which does NOT launch a provider — then opens a PTY running the
 * interactive device-code login. Distinct id (`op-<slug>-<id>-login`) so it never
 * collides with the character's Operate pane; buckets to the office (op- prefix) so
 * stopAll/reap treat it like any Operate PTY.
 */
export async function login(
  officeSlug: string,
  agent: OfficeAgent
): Promise<{ ok: true; id: string; reused?: boolean } | { error: string }> {
  seenSlugs.add(officeSlug)
  const id = `op-${officeSlug}-${agent.id}-login`
  const existing = terms.find((t) => t.id === id)
  if (existing && !endedIds.has(existing.id)) {
    activeId = existing.id
    emit()
    return { ok: true, id: existing.id, reused: true }
  }
  const r = await api().officeEnsureWorkspace(officeSlug, agent.id, agent.slug, agent.provider)
  if (r?.error || !r?.cwd) return { error: r?.error || 'Could not prepare the workspace for login' }
  if (existing) { terms = terms.filter((t) => t.id !== existing.id); dropEnded([existing.id]) }
  terms = [
    ...terms,
    {
      id,
      kind: 'pty',
      cwd: r.cwd,
      name: `${agent.name} · sign in to grok`,
      agentId: agent.id,
      command: 'grok login --device-code',
      provider: agent.provider
    }
  ]
  dropEnded([id])
  activeId = id
  emit()
  return { ok: true, id }
}

/**
 * Register read-only log terms for a spawned office (one per returned loop) and
 * return the first id to focus (or '' if none). Idempotent per id. Does NOT start
 * the loops or seed the log text buffer — officeService owns the spawn call and
 * services/logBuffer lazily owns the bytes.
 */
export function openLogs(
  officeSlug: string,
  officeName: string,
  entries: Array<{ agentId: string; name: string; path: string; provider?: string }>
): string {
  seenSlugs.add(officeSlug)
  let firstId = ''
  let changed = false
  const next = terms.slice()
  for (const e of entries) {
    const id = `log-${officeSlug}-${e.agentId}`
    if (!firstId) firstId = id
    if (next.some((t) => t.id === id)) continue
    next.push({
      id,
      kind: 'log',
      name: `${e.name} · ${officeName}`,
      agentId: e.agentId,
      path: e.path,
      provider: e.provider
    })
    changed = true
  }
  if (changed) terms = next
  if (firstId) activeId = firstId
  if (changed || firstId) emit()
  return firstId
}

/**
 * Close ONE term. A pty is killed authoritatively via ptyKill(id) (works even
 * with no pane mounted); a log term is view-only (the tracked loop keeps running —
 * stop it with officeService/officeStopOffice).
 */
export function close(id: string): void {
  const t = terms.find((x) => x.id === id)
  if (!t) return
  if (t.kind === 'pty') void api().ptyKill(id)
  const next = terms.filter((x) => x.id !== id)
  terms = next
  reactive(next, new Set([id]))
  dropEnded([id])
  emit()
}

/**
 * Kill and remove EVERY Operate PTY across all offices — the real "Stop all"
 * command (was the `office:stop-all` DOM broadcast). Log terms are left mounted:
 * tracked loops keep running until an explicit office stop.
 */
export function stopAll(): void {
  const removed = new Set(terms.filter((t) => t.kind === 'pty').map((t) => t.id))
  if (!removed.size) return
  for (const id of removed) void api().ptyKill(id)
  const next = terms.filter((t) => t.kind !== 'pty')
  terms = next
  reactive(next, removed)
  dropEnded(removed)
  emit()
}

/**
 * Drop an office's read-only log terms (used by officeService.stopOffice after the
 * loops are stopped server-side). View-only: no ptyKill — the loops were already
 * stopped by the office API, these are just their log panes.
 */
export function closeLogsForOffice(officeSlug: string): void {
  const prefix = `log-${officeSlug}-`
  const removed = new Set(terms.filter((t) => t.kind === 'log' && t.id.startsWith(prefix)).map((t) => t.id))
  if (!removed.size) return
  const next = terms.filter((t) => !removed.has(t.id))
  terms = next
  reactive(next, removed)
  dropEnded(removed)
  emit()
}

/** Focus a tab. No-op if the id is not open. */
export function setActiveTerm(id: string): void {
  if (id === activeId) return
  if (!terms.some((t) => t.id === id)) return
  activeId = id
  emit()
}

/** Mark a term's PTY as exited (its pane stays mounted; TerminalTabs greys it). */
export function markEnded(id: string): void {
  if (endedIds.has(id)) return
  endedIds = new Set(endedIds).add(id)
  emit()
}

/** Acknowledge/clear the current notice (e.g. after showing the reap message). */
export function clearNotice(): void {
  if (!notice) return
  notice = ''
  emit()
}

/**
 * Feed the office slugs present in the latest agent poll. For every office that
 * owns a live Operate PTY but is absent from the poll, count CONSECUTIVE absences;
 * once an office has been absent ABSENT_POLLS_TO_REAP straight polls (confirmed
 * server-side deletion — a single blip must NOT reap, that would break keep-alive)
 * reap its orphaned Operate PTYs (ptyKill + remove, scoped to that slug) and raise
 * a notice. Log terms are left untouched (officeStopOffice owns those).
 */
export function reconcilePresence(presentSlugs: Set<string>): void {
  // Slugs that currently own at least one pty term.
  const ptyOwners = new Map<string, string[]>()
  for (const t of terms) {
    if (t.kind !== 'pty') continue
    const slug = ownerSlug(t.id)
    if (!slug) continue
    const arr = ptyOwners.get(slug) ?? []
    arr.push(t.id)
    ptyOwners.set(slug, arr)
  }

  let reaped: Set<string> | null = null
  for (const [slug, ids] of ptyOwners) {
    if (presentSlugs.has(slug)) {
      absence.delete(slug)
      continue
    }
    const n = (absence.get(slug) ?? 0) + 1
    if (n < ABSENT_POLLS_TO_REAP) {
      absence.set(slug, n)
      continue
    }
    absence.delete(slug)
    reaped = reaped ?? new Set<string>()
    for (const id of ids) {
      reaped.add(id)
      void api().ptyKill(id)
    }
  }
  // Drop counters for offices that no longer own any pty term (closed / reaped).
  for (const slug of Array.from(absence.keys())) if (!ptyOwners.has(slug)) absence.delete(slug)

  if (reaped && reaped.size) {
    const next = terms.filter((t) => !reaped!.has(t.id))
    terms = next
    reactive(next, reaped)
    dropEnded(reaped)
    notice = REMOVED_NOTICE
    emit()
  }
}

/* ------------------------------------------------------------- imperative --- */

export function getTerms(): OpenTerm[] {
  return terms
}
export function getActiveId(): string {
  return activeId
}
export function getEndedIds(): ReadonlySet<string> {
  return endedIds
}
export function getNotice(): string {
  return notice
}
/** Any open term (pty or log) — the office empty-poll keep-alive guard reads this. */
export function hasLiveTerms(): boolean {
  return terms.length > 0
}

/* ------------------------------------------------------------------- hooks -- */

/**
 * useTerms(officeSlug?) → { terms, activeId, endedIds, notice }
 * Live registry snapshot for rendering the terminal panes. With `officeSlug`,
 * `terms` is scoped to that office (longest-match bucketed) so switching offices
 * never mixes another office's panes; without it, every open term is returned.
 * The result object is memoised, so it is a stable reference between renders that
 * don't change the registry. `endedIds` plugs straight into <TerminalTabs>.
 */
export function useTerms(officeSlug?: string): TermSnapshot {
  const snap = useSyncExternalStore(subscribe, getSnapshot)
  return useMemo<TermSnapshot>(
    () => ({
      terms: officeSlug ? snap.terms.filter((t) => ownerSlug(t.id) === officeSlug) : snap.terms,
      activeId: snap.activeId,
      endedIds: snap.endedIds,
      notice: snap.notice
    }),
    [snap, officeSlug]
  )
}
