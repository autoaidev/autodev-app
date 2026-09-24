/**
 * Unit tests for classifyHookActivity — the pure hook-event → Activity mapping
 * that drives the app's IMMEDIATE local "is this agent working?" signal.
 * Run: `npm test` (node's built-in runner + TS type-stripping).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHookActivity, HOOK_IDLE_MS, STALE_MS } from '../src/main/hookActivity.ts'

const NOW = 1_000_000_000_000
// A fresh hooks file: last write "just now".
const fresh = (obj: unknown): string => JSON.stringify(obj)

test('a fresh WORKING hook → working', () => {
  const tail = fresh({ hook_event_name: 'PreToolUse' })
  assert.equal(classifyHookActivity(tail, NOW, NOW), 'working')
})

test('UserPromptSubmit / PostToolUse / Notification all read working when fresh', () => {
  for (const name of ['UserPromptSubmit', 'PostToolUse', 'Notification', 'SessionStatus']) {
    assert.equal(classifyHookActivity(fresh({ hook_event_name: name }), NOW, NOW), 'working', name)
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
