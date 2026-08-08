/**
 * Fleet (2b) — shared types, activity vocabulary, and formatting helpers.
 *
 * These now live in `@renderer/services/model` (the single source of truth for
 * the renderer's agent domain model). This module is kept as a thin re-export so
 * every existing `import { … } from '.../fleet-helpers'` keeps resolving
 * unchanged. Do not re-declare the model here — add new shared helpers to
 * services/model.ts instead.
 */

import type { AgentState } from '@renderer/services/model'
import { officeLabel } from '@renderer/services/model'

export type { Activity, AgentState, WashTone } from '@renderer/services/model'
export {
  ACTIVITY_LABEL,
  STATE_LABEL,
  ATTENTION_STATES,
  isAttention,
  isError,
  washTone,
  dotStatus,
  providerFamily,
  officeLabel,
  tasksLabel,
  tasksFraction,
  formatElapsed
} from '@renderer/services/model'

/* --------------------------- fleet-only derivations ------------------------- */
/* These are Fleet-view helpers (grouping/office derivation for the table +
 * header), not model re-declarations, so they live here rather than in
 * services/model.ts. They mirror the Agents rail's office grouping so the Fleet
 * OFFICE column, the office count in the header, and the rail all agree. */

/** Immediate containing subfolder of a workspace path (the "office folder"). */
export function parentFolderName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : ''
}

/**
 * The office an agent belongs to, using the SAME derivation as the Agents rail:
 * prefer the bound office slug, else the containing subfolder. Returns '' only
 * when there is genuinely nothing to show (a top-level/`workspace` path with no
 * bound office) — that's the only case the OFFICE column falls back to "—".
 */
export function fleetOffice(a: AgentState): string {
  if (a.officeSlug) return officeLabel(a.officeSlug)
  const folder = parentFolderName(a.path)
  if (folder && folder !== 'workspace') return officeLabel(folder)
  return ''
}

/** Distinct office count across a fleet, from the grouped folders/slugs above. */
export function officeCountOf(agents: AgentState[]): number {
  const set = new Set<string>()
  for (const a of agents) {
    const o = fleetOffice(a)
    if (o) set.add(o)
  }
  return set.size
}

/** True when any agent in the set is actively running (drives ELAPSED column). */
export function anyRunning(agents: AgentState[]): boolean {
  return agents.some((a) => a.running || a.activity === 'working')
}
