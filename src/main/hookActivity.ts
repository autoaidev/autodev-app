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
// HEARTBEAT lifecycle hooks: a long-lived session (esp. a grok-acp loop) keeps
// emitting SessionStart/SessionStatus pings on a timer even while idle. Like the
// idle-POLL tools below, these keep the hooks file's mtime warm but are NOT proof
// of work — if we let them assert 'working', an idle grok-acp agent stays pinned
// to a green WORKING pill forever. They set the heartbeat flag and keep scanning.
export const HEARTBEAT_EVENTS = new Set(['SessionStart', 'SessionStatus'])
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
 * Pure: all time comes from the caller (nowMs), each event's own `timestamp`/`ts`,
 * and the file's last-write (mtimeMs), so it is fully deterministic and testable.
 */

/**
 * Age (ms) of a single hook event relative to `nowMs`, derived from the event's
 * OWN timestamp — the CLI's hooksManager stamps every appended line with an ISO
 * `timestamp` (older/other shapes may use `ts`, or a raw epoch number). This is
 * the decisive clock for freshness: the hooks FILE mtime stays warm as long as
 * ANY line is appended (idle-poll writes, SessionStatus heartbeats), so a stale
 * trailing `tool_start` must be judged by when IT happened, not by the file mtime.
 * Falls back to the file-mtime age only when the event carries no usable stamp.
 */
export function eventAgeMs(ev: any, nowMs: number, mtimeMs: number): number {
  const raw = ev?.timestamp ?? ev?.ts ?? ev?.payload?.timestamp ?? ev?.payload?.ts
  if (typeof raw === 'number' && Number.isFinite(raw)) return nowMs - raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return nowMs - parsed
  }
  return nowMs - mtimeMs
}

export function classifyHookActivity(tailText: string, nowMs: number, mtimeMs: number): Activity {
  const ageMs = nowMs - mtimeMs
  // Freshness verdict for a given AGE: fresh → working, quiet → idle (turn ended),
  // long-silent with work → stalled (a hang). STALE takes precedence over the idle
  // window so a real multi-minute silence reads as the louder 'stalled'.
  const freshnessVerdict = (age: number): Activity => age > STALE_MS ? 'stalled' : age > HOOK_IDLE_MS ? 'idle' : 'working'
  const lines = tailText.trim().split('\n')
  // Track whether we saw a HEARTBEAT: pure idle-POLLING (office-MCP wait/poll) or a
  // SessionStart/SessionStatus ping. These keep the file warm but are not work.
  let sawHeartbeat = false
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
      // SessionStart/SessionStatus are liveness HEARTBEATS, not work: a long-lived
      // (grok-acp) loop pings them on a timer even while idle. Treat like polls.
      if (HEARTBEAT_EVENTS.has(name)) { sawHeartbeat = true; continue }
      // Only pure IDLE-POLLING is not work: an agent with nothing to do calls the
      // office-MCP wait/poll endpoints (get_tasks / wait_for_events) on a timer,
      // each emitting a Pre/PostToolUse hook — counting those as 'working' made an
      // idle agent FLAP working↔idle (and spam toasts). Skip ONLY those poll tools.
      // CRUCIAL: every OTHER tool is real work and MUST drive 'working' — native
      // tools (Edit/Bash/Read) AND office-MCP WORK tools (send_message, post_message,
      // write_file, manage_agent_todos, …). A coordinating PM doing A2A via
      // send_message was wrongly read as stalled when we skipped all `mcp__*`.
      const tool = ev.tool_name || ev.payload?.tool_name || ev.tool || ''
      if ((name === 'PreToolUse' || name === 'PostToolUse') && typeof tool === 'string' && POLL_TOOL_RE.test(tool)) { sawHeartbeat = true; continue }
      // A real WORK event — judge freshness by the event's OWN timestamp, not the
      // file mtime (which heartbeat/poll writes keep warm). A fresh work event is
      // the agent working right now. A STALE one (e.g. a trailing `tool_start` left
      // after `all_tasks_done`) is NOT proof of work: if heartbeats show the loop is
      // still alive and polling, it has merely gone idle; otherwise fall to a plain
      // freshness verdict so a genuine multi-minute hang still surfaces as 'stalled'.
      const evAge = eventAgeMs(ev, nowMs, mtimeMs)
      if (evAge <= HOOK_IDLE_MS) return 'working'
      if (sawHeartbeat) return ageMs > STALE_MS ? 'stalled' : 'idle'
      return freshnessVerdict(evAge)
    }
  }
  // No decisive WORK event in the tail. If the only recent activity was heartbeats
  // (office-MCP polling or session pings), the agent is alive-but-idle — decay to
  // idle (stalled if long-silent), never 'working'. With no activity at all, fall
  // back to the file-mtime freshness as before.
  if (sawHeartbeat) return ageMs > STALE_MS ? 'stalled' : 'idle'
  return freshnessVerdict(ageMs)
}
