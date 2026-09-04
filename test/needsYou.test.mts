/**
 * Locks the "needs you" classifier. The bug: an interrupted / retries-exhausted
 * agent (activity 'crashed') was counted as "1 need you" because the toolbar pill,
 * rail chip and per-agent flag all reused the broad ATTENTION_STATES triage set
 * (which includes crashed + stalled). "Needs you" must mean ONLY agents genuinely
 * awaiting the user — re-auth / rate-limit / a pending choice — so this test pins
 * needsUserAttention to that set and asserts failures are excluded.
 * Run: `npm test`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  needsUserAttention,
  NEEDS_YOU_STATES,
  ATTENTION_STATES,
  isAttention,
  isError,
  type Activity,
  type AgentState
} from '../src/renderer/src/services/model.ts'

function agent(activity: Activity, over: Partial<AgentState> = {}): AgentState {
  return {
    path: '/w/' + activity,
    name: activity,
    running: false,
    activity,
    tasks: { total: 2, remaining: 1, done: 1 },
    ...over
  }
}

test('needsUserAttention is TRUE only for genuine awaiting-user states', () => {
  assert.equal(needsUserAttention(agent('needs-auth')), true)
  assert.equal(needsUserAttention(agent('rate-limited')), true)
})

test('needsUserAttention EXCLUDES crashed / interrupted / retries-exhausted', () => {
  // The reported bug: a director stuck at "INTERRUPTED — retries exhausted (2/2)"
  // (activity 'crashed', exitCode 130) must NOT be counted as "need you".
  assert.equal(needsUserAttention(agent('crashed', { exitCode: 130 })), false)
  assert.equal(needsUserAttention(agent('crashed', { exitCode: 143 })), false)
})

test('needsUserAttention EXCLUDES stalled / stopped / idle / working', () => {
  for (const a of ['stalled', 'stopped', 'idle', 'working'] as Activity[]) {
    assert.equal(needsUserAttention(agent(a)), false, `${a} must not need you`)
  }
})

test('NEEDS_YOU_STATES is a strict subset of the broad ATTENTION_STATES triage set', () => {
  for (const s of NEEDS_YOU_STATES) assert.ok(ATTENTION_STATES.has(s), `${s} should also be triage-worthy`)
  // …but the triage set is strictly larger (it also carries the failure states).
  assert.ok(ATTENTION_STATES.has('crashed'))
  assert.ok(!NEEDS_YOU_STATES.has('crashed'))
  assert.ok(ATTENTION_STATES.size > NEEDS_YOU_STATES.size)
})

test('a crashed agent still triages (float/summary) and reads as an error, just not "need you"', () => {
  const crashed = agent('crashed', { exitCode: 130 })
  assert.equal(isAttention(crashed), true) // still floats to the top / not dimmed
  assert.equal(isError(crashed), true) // red error affordance
  assert.equal(needsUserAttention(crashed), false) // but not the amber "need you"
})
