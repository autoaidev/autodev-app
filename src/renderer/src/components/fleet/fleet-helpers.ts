/**
 * Fleet (2b) — shared types, activity vocabulary, and formatting helpers.
 *
 * The renderer has no import path to the main-process `AgentState`, so the
 * shape is re-declared locally (kept in sync with src/main/agentManager.ts and
 * App.tsx). Everything here is pure — no window.api, no React.
 */

export type Activity =
  | 'working'
  | 'idle'
  | 'stopped'
  | 'stalled'
  | 'needs-auth'
  | 'rate-limited'
  | 'crashed'

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

/** Human labels for each activity (mirrors App.tsx ACTIVITY_LABEL). */
export const ACTIVITY_LABEL: Record<Activity, string> = {
  working: 'Working',
  idle: 'Idle',
  stopped: 'Stopped',
  stalled: 'Stalled',
  'needs-auth': 'Needs re-auth',
  'rate-limited': 'Rate-limited',
  crashed: 'Crashed'
}

/** Short uppercase STATE label for the inline table badge. */
export const STATE_LABEL: Record<Activity, string> = {
  working: 'WORKING',
  idle: 'IDLE',
  stopped: 'STOPPED',
  stalled: 'STALLED',
  'needs-auth': 'NEEDS AUTH',
  'rate-limited': 'RATE LIMIT',
  crashed: 'TIMED OUT'
}

/** States that demand the operator (float to the top, drive the amber tile). */
export const ATTENTION_STATES = new Set<Activity>([
  'stalled',
  'needs-auth',
  'rate-limited',
  'crashed'
])

export const isAttention = (a: AgentState): boolean => ATTENTION_STATES.has(a.activity)

/** Hard-error states (red wash) vs. soft attention states (amber wash). */
export const isError = (a: AgentState): boolean =>
  a.activity === 'crashed' || a.activity === 'stalled'

export type WashTone = 'none' | 'amber' | 'red'
export function washTone(a: AgentState): WashTone {
  if (isError(a)) return 'red'
  if (isAttention(a)) return 'amber'
  return 'none'
}

/** Map the AgentState activity onto a StatusDot status token. */
export function dotStatus(
  a: AgentState
): 'running' | 'needs-you' | 'error' | 'idle' {
  if (a.activity === 'crashed' || a.activity === 'stalled') return 'error'
  if (a.activity === 'needs-auth' || a.activity === 'rate-limited') return 'needs-you'
  if (a.running || a.activity === 'working') return 'running'
  return 'idle'
}

/** The provider vendor family (grok / claude / opencode / copilot). */
export function providerFamily(provider?: string): string {
  if (!provider) return 'unknown'
  return provider.split('-')[0].toLowerCase()
}

/** Prettify an office slug into a display name (no extra API round-trip). */
export function officeLabel(slug?: string): string {
  if (!slug) return ''
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Compact "n/m" tasks label (done / total). */
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
