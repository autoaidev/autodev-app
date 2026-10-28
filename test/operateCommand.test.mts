// operateCommand — the Operate pane's raw-TUI launch command builder.
//
// The bug this locks: the app's "Connect & operate" grok pane re-launched per turn
// with `grok --resume <id> --always-approve`, passing an id the app computed. A
// stale id or cwd-encoding mismatch makes grok error on resume and FALL BACK to a
// fresh, stateless session — the character opens a blank chat (system prompt + skill
// reminders only, no task) and idles forever (the post-turn-1 stall). The fix:
// resume via grok's own `--continue`, which resolves the newest session for the real
// cwd itself and is immune to our id drift (mirrors autodev-cli's grok provider).
//
// Locks: (1) grok with a resumable session → `--continue` (never `--resume <id>`),
// (2) grok with no session → bare fresh, (3) the resumable flag is grok-only,
// (4) claude/opencode/copilot/unknown/empty are unchanged, (5) grok ALWAYS gets a
// single-quoted interactive KICK PROMPT so it starts operating instead of idling at
// an empty TUI (the positional [PROMPT] keeps the session interactive/persistent;
// `-p/--single` would print-and-exit, killing the wait_for_events loop).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOperateCommand, GROK_OPERATE_KICK_PROMPT } from '../src/main/operateCommand.ts'

test('grok with a resumable session resumes via --continue (not --resume <id>)', () => {
  const cmd = buildOperateCommand('grok', true)
  assert.equal(cmd, `grok --continue --always-approve '${GROK_OPERATE_KICK_PROMPT}'`)
  assert.ok(!cmd.includes('--resume'), 'must not use the fragile explicit-id --resume path')
})

test('grok with no resumable session launches bare (fresh) + kick prompt', () => {
  assert.equal(buildOperateCommand('grok', false), `grok --always-approve '${GROK_OPERATE_KICK_PROMPT}'`)
})

test('grok always receives an interactive kick prompt (not the headless -p/--single flag)', () => {
  for (const cmd of [buildOperateCommand('grok', true), buildOperateCommand('grok', false)]) {
    assert.ok(cmd.includes(`'${GROK_OPERATE_KICK_PROMPT}'`), 'kick prompt must be single-quoted as one argv token')
    assert.ok(cmd.includes('wait_for_events'), 'kick must tell grok to call wait_for_events')
    assert.ok(!/\s-p\b|--single/.test(cmd), 'must NOT use the print-then-exit headless flag')
    assert.equal(cmd.trim().split(/\s+/)[0], 'grok', 'first token stays the bin for the PATH precheck')
    assert.ok(!GROK_OPERATE_KICK_PROMPT.includes("'"), 'kick must carry no apostrophe that would break single-quoting')
  }
})

test('grok-cli / grok-tui family ids are treated as grok', () => {
  assert.equal(buildOperateCommand('grok-tui', true), `grok --continue --always-approve '${GROK_OPERATE_KICK_PROMPT}'`)
  assert.equal(buildOperateCommand('grok-cli', false), `grok --always-approve '${GROK_OPERATE_KICK_PROMPT}'`)
})

test('the resumable flag only affects grok — claude ignores it', () => {
  assert.equal(buildOperateCommand('claude', true), 'claude --continue')
  assert.equal(buildOperateCommand('claude', false), 'claude --continue')
})

test('non-grok providers are unchanged', () => {
  assert.equal(buildOperateCommand('claude', false), 'claude --continue')
  assert.equal(buildOperateCommand('opencode', false), 'opencode')
  assert.equal(buildOperateCommand('copilot', false), 'copilot')
})

test('empty / unknown provider defaults to claude --continue', () => {
  assert.equal(buildOperateCommand('', false), 'claude --continue')
  assert.equal(buildOperateCommand('something-else', false), 'claude --continue')
})
