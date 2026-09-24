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
