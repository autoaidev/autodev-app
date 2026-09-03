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
  /** The persisted per-vendor model id ('' / undefined = provider default), from
   *  the main-process readState. Surfaced in the rail so the model is visible at a
   *  glance across the fleet (resolved to a friendly label via the model catalog). */
  model?: string
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
  /** Inline pixel-art sprite (`data:image/png…`) of the bound office character —
   *  present only while it is office-online, so the avatar shows the real face
   *  when connected and falls back to the initials monogram otherwise. */
  officeAvatarUrl?: string
  /** The bound office character's identity color (e.g. '#00d4ff'). */
  officeColor?: string
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

/**
 * The STATE color for an activity — the SINGLE source every status LABEL/badge
 * draws from (CharacterCard subtitle, FleetTable StateBadge, AgentRow meta), so
 * the same state never reads green in one view and grey in another (the R-E fix):
 *   working                       → --st-running (green)
 *   needs-auth / rate-limited     → --st-needsyou (amber)
 *   crashed / stalled             → --st-error   (red)
 *   idle / stopped (no live work) → --tx-4       (dim, receding)
 * Mirrors pillVariantFor's buckets — kept as a CSS-var string so a bare text
 * label can consume it directly without a Pill wrapper.
 */
export function stateColor(a: Activity): string {
  if (a === 'working') return 'var(--st-running)'
  if (a === 'needs-auth' || a === 'rate-limited') return 'var(--st-needsyou)'
  if (a === 'crashed' || a === 'stalled') return 'var(--st-error)'
  return 'var(--tx-4)'
}

/** State-badge label (mono, uppercase) for a StatusPill — same data as STATE_LABEL. */
export function stateLabel(a: Activity): string {
  return STATE_LABEL[a]
}

/**
 * Plain-language reason for a loop exit code (R8). Raw exit codes are meaningless
 * to a customer and often contradict the status word (130 is an interrupt, not a
 * timeout), so we never surface the number as the primary explanation.
 */
export function describeExit(code?: number | null): string {
  if (code == null) return ''
  switch (code) {
    case 0:
      return 'finished cleanly'
    case 124:
      return 'timed out'
    case 130:
      return 'interrupted'
    case 137:
      return 'killed'
    case 143:
      return 'stopped'
    default:
      return `stopped (code ${code})`
  }
}

/**
 * State-badge label, exit-code aware (R8). A "crashed" agent that was actually
 * interrupted (130) or terminated (143) reads STOPPED, not the timeout-implying
 * TIMED OUT — so the badge never disagrees with the exit reason shown elsewhere.
 */
export function stateLabelForAgent(a: AgentState): string {
  if (a.activity === 'crashed' && (a.exitCode === 130 || a.exitCode === 143))
    return STATE_LABEL.stopped
  return STATE_LABEL[a.activity]
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
export function rowMeta(a: AgentState, modelLabel?: string, advanced = true): { text: string; tone: MetaTone; mono: boolean } {
  if (a.activity === 'needs-auth') return { text: 'waiting on you', tone: 'amber', mono: false }
  if (a.activity === 'rate-limited') return { text: a.error || 'rate-limited', tone: 'amber', mono: false }
  if (a.activity === 'stalled') return { text: a.error || 'stalled · no output', tone: 'amber', mono: false }
  if (a.activity === 'crashed') {
    const retry = a.tasks.total > 0 ? ' · retry 2/2' : ''
    // Plain-language reason (never the raw exit code) so the row can't read
    // "TIMED OUT" while the code says something else (R8).
    const reason = describeExit(a.exitCode) || a.error || 'timed out'
    return { text: reason + retry, tone: 'red', mono: false }
  }
  if (a.activity === 'idle' && a.tasks.remaining === 0)
    return { text: 'idle · all done', tone: 'idle', mono: false }
  if (a.activity === 'working' && a.currentTask)
    return { text: stripTaskHash(a.currentTask), tone: 'default', mono: false }
  // The distinguishing "provider · <model | shortid>" meta (R3). When a non-default
  // model is set we surface it (resolved to a friendly label by the caller) — the
  // single most useful differentiator across a large fleet; otherwise fall back to
  // the trailing id hash. The id/model is suppressed entirely when it would only
  // echo the name (an office folder whose basename IS the role, …/director).
  const prov = providerShort(a.provider)
  if (modelLabel) return { text: `${prov} · ${modelLabel}`, tone: 'default', mono: false }
  // Basic: the bare "provider · <slug-hash>" line is triple-encoded identity noise
  // (provider already rides the avatar ring; the hash is a machine id) — drop it.
  // Advanced restores the id line for support/differentiation across a large fleet.
  if (!advanced) return { text: '', tone: 'default', mono: true }
  const id = agentIdHash(a.path)
  if (id && id.toLowerCase() !== a.name.trim().toLowerCase())
    return { text: `${prov} · ${id}`, tone: 'default', mono: true }
  return { text: '', tone: 'default', mono: true }
}

/** Strip a leading "[7ef6ecb4…] " id token from a task title so the row shows
 *  only human text (the id already lives in the mono session-id line/header). */
export function stripTaskHash(task: string): string {
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

/**
 * A single canonical, human-readable headline for an agent, used by BOTH the Fleet
 * table and the Agents rail so the two never mix identity schemes (a human
 * "Casting Director" sitting next to a slug-hash "art-director-9f68d" or a bare
 * lowercase "director"). Names that are already human — they contain a space or an
 * uppercase letter — are kept verbatim; a bare slug / slug-hash is stripped of its
 * trailing id hash and Title-Cased. The raw slug-hash still lives on the dim mono
 * meta line (agentSlugId), never as the headline.
 */
export function agentHeadline(a: AgentState): string {
  const stripped = a.name.replace(/[-_](?=[0-9a-f]*\d)[0-9a-f]{4,12}$/i, '').trim()
  const src = (a.officeAgentSlug || stripped || a.name || '').trim()
  if (!src) return a.name
  if (/\s/.test(src) || /[A-Z]/.test(src)) return src
  return officeLabel(src)
}

/** The raw slug-hash folder id (basename of the workspace path) — the machine id
 *  shown as dim mono meta beneath the human headline, never inline in a sentence. */
export function agentSlugId(a: AgentState): string {
  return a.path.replace(/\/+$/, '').split('/').filter(Boolean).pop() || a.name
}

/**
 * Short attention badge label for the agent-detail header pill. It reads as a
 * demand for the operator ("INTERRUPTED" / "NEEDS AUTH"), never a calm "STOPPED" —
 * so a retrying/interrupted agent can't look complete. null when the agent isn't
 * in an attention state (the caller falls back to the normal state label).
 */
export function attentionTitle(a: AgentState): string | null {
  switch (a.activity) {
    case 'needs-auth':
      return 'NEEDS AUTH'
    case 'rate-limited':
      return 'RATE LIMIT'
    case 'stalled':
      return 'STALLED'
    case 'crashed':
      return a.exitCode === 130 || a.exitCode === 143 ? 'INTERRUPTED' : 'TIMED OUT'
    default:
      return null
  }
}

/**
 * A full-sentence attention summary for the main pane / inspector — WHAT went wrong
 * (and, implicitly, that it needs the operator). null when not in an attention
 * state, so callers can fall back to "All tasks complete." only when it's true.
 */
export function attentionSummary(a: AgentState): string | null {
  const who = a.name
  switch (a.activity) {
    case 'needs-auth':
      return `${who} needs you to re-authenticate before it can continue.`
    case 'rate-limited':
      return a.error || `${who} is rate-limited and waiting to retry.`
    case 'stalled':
      return a.error ? `${who} stalled: ${a.error}` : `${who} stalled with no output.`
    case 'crashed': {
      const interrupted = a.exitCode === 130 || a.exitCode === 143
      const base = interrupted ? `${who} was interrupted` : `${who} ${describeExit(a.exitCode) || 'stopped unexpectedly'}`
      const retry = a.tasks.total > 0 ? ' — retries exhausted (2/2)' : ''
      return base + retry + '.'
    }
    default:
      return null
  }
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
    a.model === b.model &&
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
    a.officeAgentId === b.officeAgentId &&
    a.officeAvatarUrl === b.officeAvatarUrl &&
    a.officeColor === b.officeColor
  )
}
