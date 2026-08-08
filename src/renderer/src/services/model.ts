/**
 * services/model.ts — the SINGLE SOURCE for the renderer's agent domain model.
 *
 * Before Stage 1 the `AgentState` shape + activity vocabulary + label/helper maps
 * were declared THREE times (components/agent/AgentRow.tsx, components/fleet/
 * fleet-helpers.ts, and re-imported through App.tsx). This module unifies them so
 * every view/component/store shares ONE type and ONE set of pure helpers. It is
 * intentionally pure — no `window.api`, no React, no side effects — so it can be
 * imported anywhere (store, hooks, components) without pulling in the data layer.
 *
 * Migration note: AgentRow.tsx and fleet-helpers.ts should re-export from here
 * (`export { AgentState, ATTENTION_STATES, ... } from '@renderer/services/model'`)
 * and then delete their local copies. The names below are chosen to be a superset
 * of both so those re-exports are a drop-in swap.
 *
 * The only non-data import is a TYPE-ONLY import of `PillVariant` from the UI kit
 * (design tokens) used by `pillVariantFor`; it emits no runtime dependency.
 */
import type { PillVariant } from '@renderer/ui'

/* --------------------------------------------------------------- vocabulary -- */

/** The lifecycle/attention state an agent can be in. Mirrors main/agentManager. */
export type Activity =
  | 'working'
  | 'idle'
  | 'stopped'
  | 'stalled'
  | 'needs-auth'
  | 'rate-limited'
  | 'crashed'

/**
 * The canonical agent record. Mirrors AgentManager.readState in the main process
 * (there is no shared import path across the process boundary, so the shape is
 * declared here and kept in sync). This is the shape `window.api.listAgents()`
 * and the `agent:updated` event both deliver.
 */
export interface AgentState {
  path: string
  name: string
  provider?: string
  sessionName?: string
  wsUrl?: string
  running: boolean
  external?: boolean
  online?: boolean
  activity: Activity
  tasks: { total: number; remaining: number; done: number }
  currentTask?: string
  lastOutput?: string
  error?: string
  exitCode?: number | null
  officeAgentSlug?: string
  officeSlug?: string
  officeAgentId?: string
}

/** Human, sentence-case label for each activity. */
export const ACTIVITY_LABEL: Record<Activity, string> = {
  working: 'Working',
  idle: 'Idle',
  stopped: 'Stopped',
  stalled: 'Stalled',
  'needs-auth': 'Needs re-auth',
  'rate-limited': 'Rate-limited',
  crashed: 'Crashed'
}

/** Short uppercase STATE badge label (mono) used by the rail/table badges. */
export const STATE_LABEL: Record<Activity, string> = {
  working: 'WORKING',
  idle: 'IDLE',
  stopped: 'STOPPED',
  stalled: 'STALLED',
  'needs-auth': 'NEEDS AUTH',
  'rate-limited': 'RATE LIMIT',
  crashed: 'TIMED OUT'
}

/** States that demand the operator: float to the top, drive the "needs you" tally. */
export const ATTENTION_STATES = new Set<Activity>([
  'stalled',
  'needs-auth',
  'rate-limited',
  'crashed'
])

/* ------------------------------------------------------------- predicates ---- */

/** True when the agent is asking for the operator (any ATTENTION state). */
export const isAttention = (a: AgentState): boolean => ATTENTION_STATES.has(a.activity)

/** Hard-error states (red wash) vs. soft attention states (amber wash). */
export const isError = (a: AgentState): boolean =>
  a.activity === 'crashed' || a.activity === 'stalled'

/** Whether a row's name should be dimmed (idle / stopped, no live work). */
export const isDim = (a: AgentState): boolean =>
  (a.activity === 'idle' || a.activity === 'stopped') && !a.running

export type WashTone = 'none' | 'amber' | 'red'
export function washTone(a: AgentState): WashTone {
  if (isError(a)) return 'red'
  if (isAttention(a)) return 'amber'
  return 'none'
}

/* ----------------------------------------------------------- UI derivations -- */

/** WORKING/IDLE/… pill variant reserved strictly for state (AgentRow). */
export function pillVariantFor(a: Activity): PillVariant {
  if (a === 'working') return 'green'
  if (a === 'crashed') return 'red'
  if (ATTENTION_STATES.has(a)) return 'amber'
  return 'neutral'
}

/** State-badge label (mono, uppercase) for a StatusPill — same data as STATE_LABEL. */
export function stateLabel(a: Activity): string {
  return STATE_LABEL[a]
}

/**
 * Map an AgentState onto the 4-token dot status used by the fleet table/tiles
 * (running / needs-you / error / idle). Note StatusDot also accepts an Activity
 * directly; this is the collapsed-to-4 variant fleet-helpers exposed.
 */
export function dotStatus(a: AgentState): 'running' | 'needs-you' | 'error' | 'idle' {
  if (a.activity === 'crashed' || a.activity === 'stalled') return 'error'
  if (a.activity === 'needs-auth' || a.activity === 'rate-limited') return 'needs-you'
  if (a.running || a.activity === 'working') return 'running'
  return 'idle'
}

export type MetaTone = 'default' | 'amber' | 'red' | 'idle'

/**
 * The meta / state line under an agent name in the rail. It carries only what
 * DIFFERS between sibling rows, in the STATE colour:
 *  - attention rows → a coloured human reason ("waiting on you" / "timed out" …);
 *  - default rows → the session id (last path hash) in dim mono.
 *
 * The provider and office no longer appear here: they live on the GROUP HEADER
 * (AgentRail), so repeating "grok · <hash>" down the whole rail — the identical-
 * info anti-pattern flagged in R2 — is gone. When a working row has a live task
 * we surface that instead of the bare id, since it's the most differentiating bit.
 */
export function rowMeta(a: AgentState): { text: string; tone: MetaTone; mono: boolean } {
  if (a.activity === 'needs-auth') return { text: 'waiting on you', tone: 'amber', mono: false }
  if (a.activity === 'rate-limited') return { text: a.error || 'rate-limited', tone: 'amber', mono: false }
  if (a.activity === 'stalled') return { text: a.error || 'stalled · no output', tone: 'amber', mono: false }
  if (a.activity === 'crashed') {
    const retry = a.tasks.total > 0 ? ' · retry 2/2' : ''
    return { text: (a.error || 'timed out') + retry, tone: 'red', mono: false }
  }
  if (a.activity === 'idle' && a.tasks.remaining === 0)
    return { text: 'idle · all done', tone: 'idle', mono: false }
  if (a.activity === 'working' && a.currentTask)
    return { text: stripTaskHash(a.currentTask), tone: 'default', mono: false }
  // Session id only — never the provider (that's on the group header now).
  return { text: agentIdHash(a.path), tone: 'default', mono: true }
}

/** Strip a leading "[7ef6ecb4…] " id token from a task title so the row shows
 *  only human text (the id already lives in the mono session-id line/header). */
function stripTaskHash(task: string): string {
  return task.replace(/^\s*\[[0-9a-f]{6,}\W*\]\s*/i, '').trim() || task
}

/* ------------------------------------------------------------- formatting ---- */

/** Vendor family of a provider id (grok / claude / opencode / copilot). */
export function providerFamily(provider?: string): string {
  if (!provider) return 'unknown'
  return provider.split('-')[0].toLowerCase()
}

/** Short provider label, e.g. "claude-tui" → "claude" (falls back to "local"). */
export function providerShort(p?: string): string {
  return (p || '').split('-')[0] || 'local'
}

/** The trailing hash of a workspace basename, e.g. balance-analyst-d271e → d271e. */
export function agentIdHash(path: string): string {
  const base = path.replace(/\/+$/, '').split('/').filter(Boolean).pop() || ''
  const m = base.match(/-([0-9a-z]{4,12})$/i)
  return m ? m[1] : base
}

/** Last-two path segments — the compact rail/header label. */
export function shortPath(p?: string): string {
  if (!p) return ''
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts.slice(-2).join('/') || p
}

/** Prettify an office slug into a display name (no extra API round-trip). */
export function officeLabel(slug?: string): string {
  if (!slug) return ''
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Compact "done/total" tasks label. */
export function tasksLabel(t: AgentState['tasks']): string {
  return `${t.done}/${t.total}`
}

/** done/total as a 0..1 fraction (0 when no tasks). */
export function tasksFraction(t: AgentState['tasks']): number {
  if (!t.total) return 0
  return Math.max(0, Math.min(1, t.done / t.total))
}

/** Human elapsed string from a ms duration. `null` ⇒ em-dash. */
export function formatElapsed(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}`
}

/* ----------------------------------------------------------- store helpers --- */

/**
 * Structural equality for two agent records — used by the store to keep snapshot
 * references stable across a poll that returned identical data (so useSyncExternal
 * Store subscribers don't re-render on every 5s tick). Compares every field the
 * views read, including the nested tasks counters.
 */
export function agentEqual(a: AgentState, b: AgentState): boolean {
  return (
    a.path === b.path &&
    a.name === b.name &&
    a.provider === b.provider &&
    a.sessionName === b.sessionName &&
    a.wsUrl === b.wsUrl &&
    a.running === b.running &&
    a.external === b.external &&
    a.online === b.online &&
    a.activity === b.activity &&
    a.tasks.total === b.tasks.total &&
    a.tasks.remaining === b.tasks.remaining &&
    a.tasks.done === b.tasks.done &&
    a.currentTask === b.currentTask &&
    a.lastOutput === b.lastOutput &&
    a.error === b.error &&
    a.exitCode === b.exitCode &&
    a.officeAgentSlug === b.officeAgentSlug &&
    a.officeSlug === b.officeSlug &&
    a.officeAgentId === b.officeAgentId
  )
}
