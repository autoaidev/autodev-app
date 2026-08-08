/**
 * SCREEN 2g helpers — the live MCP connectivity shape + its UI mapping.
 *
 * `McpServerStatus` mirrors exactly what `window.api.agentMcpStatus(path)`
 * returns (see CURRENT-APP.md §1b). We map its raw `status` string onto the
 * three-tier visual vocabulary the mockup uses: ready (green) / failing (red) /
 * disabled (grey) — plus an actionable one-line hint for the failing case.
 */
import type { DotStatus } from '@renderer/ui'

export interface McpServerStatus {
  name: string
  kind: 'remote' | 'stdio'
  detail: string
  builtin: boolean
  enabled: boolean
  status: 'connected' | 'unreachable' | 'ready' | 'missing' | 'disabled'
  latencyMs?: number
  error?: string
}

export type McpTone = 'ready' | 'failing' | 'disabled'

export interface McpStatusMeta {
  tone: McpTone
  /** the short state word shown at the row's right edge */
  label: string
  /** StatusDot colour role */
  dot: DotStatus
  /** true when this row must render the red-wash error panel */
  failing: boolean
}

/**
 * MCP_STATUS_META — one entry per raw status. Kept as data (not a switch) so the
 * row and the summary counts read from the same source of truth.
 */
export const MCP_STATUS_META: Record<McpServerStatus['status'], McpStatusMeta> = {
  connected: { tone: 'ready', label: 'ready', dot: 'running', failing: false },
  ready: { tone: 'ready', label: 'ready', dot: 'running', failing: false },
  missing: { tone: 'failing', label: 'missing', dot: 'error', failing: true },
  unreachable: { tone: 'failing', label: 'unreachable', dot: 'error', failing: true },
  disabled: { tone: 'disabled', label: 'disabled', dot: 'idle', failing: false }
}

export function metaFor(s: McpServerStatus): McpStatusMeta {
  const base = MCP_STATUS_META[s.status] ?? MCP_STATUS_META.unreachable
  // A disabled server is never "failing" even if the probe couldn't reach it.
  if (!s.enabled) return MCP_STATUS_META.disabled
  return base
}

/** transport badge text — "builtin" wins over the stdio/remote transport word. */
export function transportLabel(s: McpServerStatus): string {
  if (s.builtin) return 'builtin'
  return s.kind === 'remote' ? 'remote' : 'stdio'
}

/**
 * A human, actionable one-liner for a failing server. Prefers the probe's own
 * `error`, then falls back to the classic "runner not on PATH" for a missing
 * stdio command.
 */
export function failureHint(s: McpServerStatus): { title: string; detail: string; runnerMissing: boolean } {
  const runnerMissing = s.status === 'missing' && s.kind === 'stdio'
  if (runnerMissing) {
    const runner = (s.detail || '').trim().split(/\s+/)[0] || 'runner'
    return {
      title: `Runner “${runner}” is not on PATH`,
      detail: s.error || "The office bridge can't start — this agent won't answer messages.",
      runnerMissing: true
    }
  }
  if (s.kind === 'remote') {
    return {
      title: 'Remote server unreachable',
      detail: s.error || 'The MCP initialize handshake failed — check the URL and that the server is up.',
      runnerMissing: false
    }
  }
  return {
    title: 'Server failed its connectivity check',
    detail: s.error || 'Could not verify this server. Restart the agent to retry.',
    runnerMissing: false
  }
}

/** counts for the "N ready · M failing" summary line. */
export function summarize(servers: McpServerStatus[]): { ready: number; failing: number; disabled: number } {
  let ready = 0
  let failing = 0
  let disabled = 0
  for (const s of servers) {
    const m = metaFor(s)
    if (m.tone === 'ready') ready++
    else if (m.tone === 'failing') failing++
    else disabled++
  }
  return { ready, failing, disabled }
}
