/**
 * Shared types + helpers for the 2d Sessions screen.
 *
 * SessionMeta / SessionMsg mirror the real `window.api.sessionsDiscover` /
 * `sessionBacklog` payloads (see docs/redesign/CURRENT-APP.md §1e). Nothing here
 * invents fields the api doesn't return — where the design asks for data the api
 * doesn't expose (a per-session token count), the closest available field is used
 * and flagged with a // TODO(redesign) note at the call site.
 */

export interface SessionMeta {
  id: string
  provider: string
  file: string
  project: string
  cwd: string
  title: string
  mtime: number
  sizeKb: number
  msgs: number
  live: boolean
}

export interface SessionMsg {
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  ts?: number
}

/** The four provider families the filter Pills expose (matches PROVIDERS in App). */
export const PROVIDERS = ['grok', 'claude', 'opencode', 'copilot'] as const
export type ProviderFilter = 'all' | (typeof PROVIDERS)[number]

/** Stable per-row identity — non-claude sessions have no file path, so key on id. */
export const keyOf = (s: SessionMeta): string => `${s.provider}:${s.id}`

/** Last path segment of a workspace cwd — used as the agent handle in the meta line. */
export const baseName = (p: string): string =>
  p.replace(/\/+$/, '').split('/').filter(Boolean).pop() || p

/** "38s ago" / "4m ago" / "3h ago" / "2d ago". */
export function ago(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** "11:39" clock for a session's start/mtime. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Compact msg/size count for the meta tail (api exposes no token count — see note). */
export function countLabel(s: SessionMeta): string {
  // TODO(redesign): the mockup shows "17.7k tokens"; sessionsDiscover exposes no
  // per-session token total, so we surface the message count (closest real field).
  if (s.msgs > 0) return `${s.msgs} msg${s.msgs === 1 ? '' : 's'}`
  return `${s.sizeKb}kb`
}

/** Time-bucket a session for the LIVE NOW / EARLIER TODAY / YESTERDAY groups. */
export type GroupId = 'live' | 'today' | 'yesterday' | 'earlier'

export function groupOf(s: SessionMeta, now = Date.now()): GroupId {
  if (s.live) return 'live'
  const d = new Date(s.mtime)
  const t = new Date(now)
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, t)) return 'today'
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (sameDay(d, y)) return 'yesterday'
  return 'earlier'
}

export const GROUP_LABEL: Record<GroupId, string> = {
  live: 'LIVE NOW',
  today: 'EARLIER TODAY',
  yesterday: 'YESTERDAY',
  earlier: 'EARLIER'
}

/**
 * A rendered list entry: either a single session row, or a fold of N identical
 * repeated runs ("31 runs of the same task-poller prompt"). Folding collapses
 * ≥ FOLD_MIN sessions that share the exact same title within one time group.
 */
export const FOLD_MIN = 3

export type ListItem =
  | { kind: 'row'; session: SessionMeta }
  | { kind: 'fold'; title: string; sessions: SessionMeta[] }

/** Build the ordered list items for one time group, folding duplicate titles. */
export function foldGroup(sessions: SessionMeta[]): ListItem[] {
  const byTitle = new Map<string, SessionMeta[]>()
  for (const s of sessions) {
    const arr = byTitle.get(s.title)
    if (arr) arr.push(s)
    else byTitle.set(s.title, [s])
  }
  const items: ListItem[] = []
  // Preserve original (mtime-desc) ordering by walking the source list and
  // emitting each title once, at the position of its first occurrence.
  const emitted = new Set<string>()
  for (const s of sessions) {
    if (emitted.has(s.title)) continue
    emitted.add(s.title)
    const group = byTitle.get(s.title)!
    if (group.length >= FOLD_MIN) items.push({ kind: 'fold', title: s.title, sessions: group })
    else for (const one of group) items.push({ kind: 'row', session: one })
  }
  return items
}
