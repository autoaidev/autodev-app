/**
 * Unit tests for classifyHookActivity — the pure hook-event → Activity mapping
 * that drives the app's IMMEDIATE local "is this agent working?" signal.
 * Run: `npm test` (node's built-in runner + TS type-stripping).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHookActivity, eventAgeMs, HOOK_IDLE_MS, STALE_MS } from '../src/main/hookActivity.ts'

const NOW = 1_000_000_000_000
// A fresh hooks file: last write "just now".
const fresh = (obj: unknown): string => JSON.stringify(obj)

test('a fresh WORKING hook → working', () => {
  const tail = fresh({ hook_event_name: 'PreToolUse' })
  assert.equal(classifyHookActivity(tail, NOW, NOW), 'working')
})

test('UserPromptSubmit / PostToolUse / Notification all read working when fresh', () => {
  for (const name of ['UserPromptSubmit', 'PostToolUse', 'Notification']) {
    assert.equal(classifyHookActivity(fresh({ hook_event_name: name }), NOW, NOW), 'working', name)
  }
})

test('SessionStart / SessionStatus are HEARTBEATS, not work: fresh ones alone → idle', () => {
  // A long-lived (grok-acp) loop pings these on a timer even while idle; counting
  // them as 'working' pinned an idle agent to a green WORKING pill forever.
  for (const name of ['SessionStart', 'SessionStatus']) {
    assert.equal(classifyHookActivity(fresh({ hook_event_name: name }), NOW, NOW), 'idle', name)
  }
})

test('an event_type-shaped working line reads working too', () => {
  assert.equal(classifyHookActivity(fresh({ event_type: 'tool_start' }), NOW, NOW), 'working')
})

test('a Stop hook → idle (clean turn end), even with a fresh mtime', () => {
  const tail = fresh({ hook_event_name: 'Stop' })
  assert.equal(classifyHookActivity(tail, NOW, NOW), 'idle')
})

test('SessionEnd / loop_complete → idle', () => {
  assert.equal(classifyHookActivity(fresh({ hook_event_name: 'SessionEnd' }), NOW, NOW), 'idle')
  assert.equal(classifyHookActivity(fresh({ event_type: 'loop_complete' }), NOW, NOW), 'idle')
})

test('the NEWEST event wins: a Stop after a PreToolUse → idle', () => {
  const tail = [fresh({ hook_event_name: 'PreToolUse' }), fresh({ hook_event_name: 'Stop' })].join('\n')
  assert.equal(classifyHookActivity(tail, NOW, NOW), 'idle')
})

test('silence past HOOK_IDLE_MS decays a WORKING hook to idle (no stuck spinner)', () => {
  const tail = fresh({ hook_event_name: 'PreToolUse' })
  const mtime = NOW - (HOOK_IDLE_MS + 5_000) // ~95s quiet, still < STALE_MS
  assert.equal(classifyHookActivity(tail, NOW, mtime), 'idle')
})

test('a WORKING hook just inside the idle window still reads working', () => {
  const tail = fresh({ hook_event_name: 'PreToolUse' })
  const mtime = NOW - (HOOK_IDLE_MS - 5_000)
  assert.equal(classifyHookActivity(tail, NOW, mtime), 'working')
})

test('long silence past STALE_MS with a WORKING hook → stalled (a hang)', () => {
  const tail = fresh({ hook_event_name: 'PreToolUse' })
  const mtime = NOW - (STALE_MS + 10_000)
  assert.equal(classifyHookActivity(tail, NOW, mtime), 'stalled')
})

test('needs-auth OVERRIDES working: a reauth_required as the newest event wins even when fresh', () => {
  const tail = [fresh({ hook_event_name: 'PreToolUse' }), fresh({ hook_event_name: 'reauth_required' })].join('\n')
  assert.equal(classifyHookActivity(tail, NOW, NOW), 'needs-auth')
})

test('rate_limit as the newest event → rate-limited', () => {
  const tail = [fresh({ event_type: 'tool_start' }), fresh({ event_type: 'rate_limit' })].join('\n')
  assert.equal(classifyHookActivity(tail, NOW, NOW), 'rate-limited')
})

test('StopFailure → crashed (distinct from a clean Stop)', () => {
  assert.equal(classifyHookActivity(fresh({ hook_event_name: 'StopFailure' }), NOW, NOW), 'crashed')
})

test('garbage / non-JSON lines are skipped, falling through to the freshness verdict', () => {
  const tail = ['not json', '{bad', fresh({ hook_event_name: 'PreToolUse' })].join('\n')
  assert.equal(classifyHookActivity(tail, NOW, NOW), 'working')
})

test('an empty tail falls back to the freshness verdict (fresh → working, quiet → idle)', () => {
  assert.equal(classifyHookActivity('', NOW, NOW), 'working')
  assert.equal(classifyHookActivity('', NOW, NOW - (HOOK_IDLE_MS + 1_000)), 'idle')
})

test('idle-polling only: newest lines are mcp__ poll hooks (fresh) → idle, NOT working', () => {
  // An idle agent calls the office-MCP poll tools every few seconds; each emits a
  // Pre/PostToolUse hook keeping the file fresh. Those must NOT read as working.
  const tail = [
    fresh({ hook_event_name: 'PreToolUse', tool_name: 'mcp__office__get_tasks' }),
    fresh({ hook_event_name: 'PostToolUse', tool_name: 'mcp__office__wait_for_events' }),
  ].join('\n')
  assert.equal(classifyHookActivity(tail, NOW, NOW), 'idle')
})

test('a NATIVE PreToolUse (Bash) still reads working when fresh', () => {
  const tail = fresh({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })
  assert.equal(classifyHookActivity(tail, NOW, NOW), 'working')
})

test('an office-MCP WORK tool (send_message) reads working — only get_tasks/wait_for_events are polls', () => {
  // Regression guard: a coordinating PM doing A2A via send_message / post_message
  // is WORKING. Skipping ALL mcp__* (not just the poll tools) wrongly marked it
  // stalled. Only the pure poll endpoints are excluded.
  assert.equal(classifyHookActivity(fresh({ hook_event_name: 'PostToolUse', tool_name: 'mcp__office__send_message' }), NOW, NOW), 'working')
  assert.equal(classifyHookActivity(fresh({ hook_event_name: 'PreToolUse', tool_name: 'mcp__office__post_message' }), NOW, NOW), 'working')
  assert.equal(classifyHookActivity(fresh({ hook_event_name: 'PreToolUse', tool_name: 'mcp__office__write_file' }), NOW, NOW), 'working')
})

test('mixed: an mcp poll after a native tool — the poll alone cannot force working', () => {
  // Newest line is the mcp poll; the older native Bash tool has decayed past the
  // idle window. The fresh poll must NOT rescue the turn back to 'working'.
  const tail = [
    fresh({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
    fresh({ hook_event_name: 'PostToolUse', tool_name: 'mcp__office__get_tasks' }),
  ].join('\n')
  const quiet = NOW - (HOOK_IDLE_MS + 5_000) // native turn has gone quiet
  assert.equal(classifyHookActivity(tail, NOW, quiet), 'idle')
})

// ── ts-based freshness (the idle grok-acp "stuck WORKING" fix) ──────────────
// A grok-acp loop keeps the hooks FILE mtime warm with SessionStatus/poll writes,
// so freshness must come from the decisive work event's OWN `timestamp`, not mtime.
const iso = (ms: number): string => new Date(ms).toISOString()

test('eventAgeMs prefers the event ts (ISO or epoch) over the file mtime', () => {
  // mtime is "now", but the event itself is 10 min old — age must follow the event.
  assert.equal(eventAgeMs({ timestamp: iso(NOW - 600_000) }, NOW, NOW), 600_000)
  assert.equal(eventAgeMs({ ts: NOW - 120_000 }, NOW, NOW), 120_000)
  // No usable stamp → fall back to the file-mtime age.
  assert.equal(eventAgeMs({ hook_event_name: 'PreToolUse' }, NOW, NOW - 5_000), 5_000)
})

test('grok-acp idle: a STALE trailing tool_start + fresh heartbeats/polls → idle', () => {
  // The real bug: `all_tasks_done`, then a trailing `tool_start` (now old), then
  // SessionStatus + idle-poll writes keep the file mtime warm. Newest-first the scan
  // hits fresh heartbeats/polls (skipped), then the OLD tool_start — judged by its
  // own ts it is well past the idle window, so the agent has gone idle, NOT working.
  const tail = [
    fresh({ event_type: 'all_tasks_done', timestamp: iso(NOW - 300_000) }),
    fresh({ event_type: 'tool_start', timestamp: iso(NOW - 200_000) }), // trailing, OLD
    fresh({ hook_event_name: 'SessionStatus', timestamp: iso(NOW - 2_000) }),
    fresh({ hook_event_name: 'PostToolUse', tool_name: 'mcp__office__wait_for_events', timestamp: iso(NOW - 1_000) }),
  ].join('\n')
  assert.equal(classifyHookActivity(tail, NOW, NOW), 'idle')
})

test('genuinely active: a tool_start with a FRESH ts (no terminal event after) → working', () => {
  const tail = [
    fresh({ hook_event_name: 'SessionStatus', timestamp: iso(NOW - 3_000) }),
    fresh({ event_type: 'tool_start', timestamp: iso(NOW - 1_500) }), // fresh work
  ].join('\n')
  assert.equal(classifyHookActivity(tail, NOW, NOW), 'working')
})

test('a stale trailing tool_start by its OWN ts decays to idle even while mtime is warm', () => {
  // No heartbeat line at all, only the stale work event; its ts is in the idle
  // window (past HOOK_IDLE_MS, under STALE_MS) → idle, not a stuck 'working'.
  const tail = fresh({ event_type: 'tool_start', timestamp: iso(NOW - (HOOK_IDLE_MS + 10_000)) })
  assert.equal(classifyHookActivity(tail, NOW, NOW), 'idle') // mtime warm, event old
})

test('terminal all_tasks_done newest (by ts) → idle', () => {
  const tail = [
    fresh({ event_type: 'tool_start', timestamp: iso(NOW - 10_000) }),
    fresh({ event_type: 'all_tasks_done', timestamp: iso(NOW - 1_000) }),
  ].join('\n')
  assert.equal(classifyHookActivity(tail, NOW, NOW), 'idle')
})

test('no heartbeats + a long-stale work event (by ts) still surfaces as stalled', () => {
  // A genuine hang: the only work event is older than STALE_MS and nothing keeps the
  // loop alive — must NOT be softened to idle.
  const tail = fresh({ hook_event_name: 'PreToolUse', tool_name: 'Bash', timestamp: iso(NOW - (STALE_MS + 30_000)) })
  assert.equal(classifyHookActivity(tail, NOW, NOW - (STALE_MS + 30_000)), 'stalled')
})
