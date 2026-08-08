/**
 * Fleet (2b) — shared types, activity vocabulary, and formatting helpers.
 *
 * These now live in `@renderer/services/model` (the single source of truth for
 * the renderer's agent domain model). This module is kept as a thin re-export so
 * every existing `import { … } from '.../fleet-helpers'` keeps resolving
 * unchanged. Do not re-declare the model here — add new shared helpers to
 * services/model.ts instead.
 */

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
