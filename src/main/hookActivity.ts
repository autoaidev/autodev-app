/**
 * hookActivity — the PURE hook-event → Activity classifier (extracted from
 * AgentManager so it can be unit-tested without pulling in electron).
 *
 * An autonomous run appends a JSON line to `.autodev/hooks-events.jsonl` on every
 * lifecycle hook (prompt submit, tool start/stop, notification, stop, …). Reading
 * the tail of that file — newest event first — is the app's IMMEDIATE, local
 * signal for "is this agent doing something right now?", independent of the
 * laggy pixel-office presence round-trip. This module owns the vocabulary that
 * maps those raw hook names to the app's Activity states.
 */

// A truthful agent status. Beyond the naive working/idle/stopped, an autonomous
// run can be: STALLED (no hook activity for minutes — a hang, e.g. a dead grok
// token or a wedged tool), CRASHED (StopFailure / non-zero exit — a real failure,
// NOT a clean stop), NEEDS-AUTH (provider login expired, loop paused for re-auth),
// or RATE-LIMITED (provider throttled, loop paused until the window clears).
export type Activity = 'working' | 'idle' | 'stopped' | 'stalled' | 'needs-auth' | 'rate-limited' | 'crashed'

// Hooks the CLI fires while a turn is actively in flight (mirrors the CLI's
// WORKING_HOOKS): a prompt submitted, a tool about to/just run, a status ping, a
// notification. Any of these — when FRESH — means the agent is working right now.
export const WORKING_EVENTS = new Set(['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStatus', 'Notification'])
// Clean turn/session boundaries — the agent finished this turn, not a failure.
export const CLEAN_IDLE_EVENTS = new Set(['SessionEnd', 'Stop', 'session.idle'])
export const CLEAN_IDLE_ETYPES = new Set(['session_end', 'loop_complete', 'all_tasks_done', 'session.idle'])
// A run that FAILED (watchdog kill / crash) — distinct from a clean stop.
export const FAILURE_EVENTS = new Set(['StopFailure'])
export const WORKING_ETYPES = new Set(['notification', 'agent_message', 'tool_start', 'task_start', 'task_progress'])
// Pure IDLE-POLL office-MCP tools: an agent with no work calls these on a timer to
// wait for the next task. They are the ONLY tool hooks that do NOT count as work.
// Matched by tool-name suffix so it catches `mcp__pixel-office__wait_for_events`
// etc. Everything else (send_message, post_message, write_file, manage_agent_todos,
// native Edit/Bash/Read) is real work and drives 'working'.
export const POLL_TOOL_RE = /(?:get_tasks|wait_for_events|get_events|list_tasks)$/

// A 'working' agent whose hooks file has been silent this long is hung/stalled.
export const STALE_MS = 4 * 60 * 1000
// Shorter "turn quiet" window: once the newest working hook is older than this
// (and no clean Stop was seen), the turn has almost certainly ended, so the local
// signal decays to idle rather than leaving a spinner stuck. Kept well under
// STALE_MS so a genuine multi-minute hang still surfaces as 'stalled'.
export const HOOK_IDLE_MS = 90 * 1000

/**
 * Classify an agent's LOCAL activity from the tail of its hooks-events.jsonl.
 *
 * Scans newest-line-first and returns on the first decisive event:
 *   - reauth_required / rate_limit → needs-auth / rate-limited (a paused loop
 *     emits these as its LAST event, so newest-first surfaces them; they OVERRIDE
 *     a stale 'working' from the last pre-pause hook).
 *   - StopFailure / stop_failure → crashed.
 *   - Stop / SessionEnd / loop_complete → idle (a clean turn/session boundary).
 *   - a WORKING hook → working when FRESH, idle once quiet past HOOK_IDLE_MS,
 *     stalled once silent past STALE_MS.
 * With no decisive event in the tail, freshness alone decides (working/idle/stalled).
 *
 * Pure: all time comes from the caller (nowMs) and the file's last-write (mtimeMs),
 * so it is fully deterministic and unit-testable.
 */
export function classifyHookActivity(tailText: string, nowMs: number, mtimeMs: number): Activity {
  const ageMs = nowMs - mtimeMs
  // Freshness verdict for a WORKING hook: fresh → working, quiet → idle (turn
  // ended), long-silent with work → stalled (a hang). STALE takes precedence over
  // the idle window so a real multi-minute silence reads as the louder 'stalled'.
  const workingVerdict: Activity = ageMs > STALE_MS ? 'stalled' : ageMs > HOOK_IDLE_MS ? 'idle' : 'working'
  const lines = tailText.trim().split('\n')
  // Track whether the only recent activity was pure idle-POLLING (see below).
  let sawMcpPoll = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]
    if (!raw) continue
    let ev: any
    try { ev = JSON.parse(raw) } catch { continue }
    const name = ev.hook_event_name || ev.hook || ev.payload?.type || ev.type
    const et = ev.event_type || ev.event
    if (name === 'reauth_required' || et === 'reauth_required') return 'needs-auth'
    if (name === 'rate_limit' || et === 'rate_limit' || name === 'rate_limited' || et === 'rate_limited') return 'rate-limited'
    if (FAILURE_EVENTS.has(name) || et === 'stop_failure') return 'crashed'
    if (CLEAN_IDLE_EVENTS.has(name) || CLEAN_IDLE_ETYPES.has(et)) return 'idle'
    if (WORKING_EVENTS.has(name) || WORKING_ETYPES.has(et)) {
      // Only pure IDLE-POLLING is not work: an agent with nothing to do calls the
      // office-MCP wait/poll endpoints (get_tasks / wait_for_events) on a timer,
      // each emitting a Pre/PostToolUse hook — counting those as 'working' made an
      // idle agent FLAP working↔idle (and spam toasts). Skip ONLY those poll tools.
      // CRUCIAL: every OTHER tool is real work and MUST drive 'working' — native
      // tools (Edit/Bash/Read) AND office-MCP WORK tools (send_message, post_message,
      // write_file, manage_agent_todos, …). A coordinating PM doing A2A via
      // send_message was wrongly read as stalled when we skipped all `mcp__*`.
      const tool = ev.tool_name || ev.payload?.tool_name || ev.tool || ''
      if ((name === 'PreToolUse' || name === 'PostToolUse') && typeof tool === 'string' && POLL_TOOL_RE.test(tool)) { sawMcpPoll = true; continue }
      return workingVerdict
    }
  }
  // No decisive NATIVE event in the tail. If the only recent activity was office-MCP
  // polling, the agent is idle-polling — decay to idle (stalled if long-silent),
  // never 'working'. With no activity at all, fall back to freshness as before.
  if (sawMcpPoll) return ageMs > STALE_MS ? 'stalled' : 'idle'
  return workingVerdict
}
