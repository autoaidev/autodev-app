// operateCommand — the Operate pane's raw-TUI launch command builder.
//
// The original bug: the app's "Connect & operate" grok pane re-launched per turn
// with `grok --resume <id> --always-approve`, passing an id the app computed. A
// stale id or cwd-encoding mismatch makes grok error on resume and FALL BACK to a
// fresh, stateless session — the character opens a blank chat (system prompt + skill
// reminders only, no task) and idles forever (the post-turn-1 stall). The fix:
// resume via grok's own `--continue`, which resolves the newest session for the real
// cwd itself and is immune to our id drift (mirrors autodev-cli's grok provider).
//
// The SECOND bug (locked here for every provider): launched bare, each provider's
// TUI opens at an EMPTY prompt and never calls the office bridge's `wait_for_events`
// tool, so office tasks never reach it. Every operate provider now gets a
// single-quoted interactive KICK PROMPT passed via a flag VERIFIED (per `--help`) to
// keep the session interactive & persistent — never the provider's headless
// print-then-exit mode, which would kill the wait_for_events loop after one turn.
//
// Locks: (1) grok with a resumable session → `--continue` (never `--resume <id>`),
// (2) grok with no session → bare fresh, (3) the resumable flag is grok-only,
// (4) EVERY provider receives the shared kick prompt via its own interactive form:
//     grok=positional [PROMPT], claude=positional [prompt], opencode=`--prompt`,
//     copilot=`-i`, (5) NONE uses a known headless-exit flag (grok `-p/--single`,
//     claude `-p/--print`, opencode `run`, copilot `-p/--prompt`), (6) the bin stays
//     the first token so PixelOffice's resolveBinOnPath pre-check still works.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOperateCommand, buildLoopOperateCommand, isLoopProvider, OPERATE_KICK_PROMPT, GROK_OPERATE_KICK_PROMPT } from '../src/main/operateCommand.ts'

const KICK = OPERATE_KICK_PROMPT

test('the kick prompt is shared and safe to single-quote across all providers', () => {
  assert.equal(GROK_OPERATE_KICK_PROMPT, OPERATE_KICK_PROMPT, 'back-compat alias must equal the shared kick')
  assert.ok(KICK.includes('wait_for_events'), 'kick must tell the model to call wait_for_events')
  assert.ok(!/['$`]/.test(KICK), 'kick must carry no apostrophe/$/backtick that would break single-quoting')
})

test('grok with a resumable session resumes via --continue (not --resume <id>)', () => {
  const cmd = buildOperateCommand('grok', true)
  assert.equal(cmd, `grok --continue --always-approve '${KICK}'`)
  assert.ok(!cmd.includes('--resume'), 'must not use the fragile explicit-id --resume path')
})

test('grok with no resumable session launches bare (fresh) + kick prompt', () => {
  assert.equal(buildOperateCommand('grok', false), `grok --always-approve '${KICK}'`)
})

test('grok-cli / grok-tui family ids are treated as grok (TUI), NOT as the ACP loop', () => {
  assert.equal(buildOperateCommand('grok-tui', true), `grok --continue --always-approve '${KICK}'`)
  assert.equal(buildOperateCommand('grok-cli', false), `grok --always-approve '${KICK}'`)
  assert.equal(isLoopProvider('grok-tui'), false)
  assert.equal(isLoopProvider('grok-cli'), false)
})

test('isLoopProvider matches grok-acp (and the -acp family) by EXACT id, never startsWith(grok)', () => {
  assert.equal(isLoopProvider('grok-acp'), true)
  assert.equal(isLoopProvider('GROK-ACP'), true)
  assert.equal(isLoopProvider('some-future-acp'), true)
  // The plain grok TUI family and everyone else are NOT loop providers.
  for (const p of ['grok', 'grok-tui', 'grok-cli', 'claude', 'claude-cli', 'opencode', 'copilot', '']) {
    assert.equal(isLoopProvider(p), false, `${p} must not be a loop provider`)
  }
})

test('buildOperateCommand REFUSES grok-acp — it must route to the loop, not the grok TUI (the bug)', () => {
  assert.throws(() => buildOperateCommand('grok-acp', true), /loop\/ACP provider/)
  assert.throws(() => buildOperateCommand('grok-acp', false), /autodev start -p grok-acp/)
})

test('buildLoopOperateCommand runs the CLI loop (autodev start -p grok-acp), never the grok TUI', () => {
  const cmd = buildLoopOperateCommand(
    { nodeCmd: '/usr/bin/node', cliJs: '/opt/app/autodev-cli/bin/autodev.js', dir: '/home/u/.autodev-app/offices/o/a', provider: 'grok-acp' },
    'linux'
  )
  assert.equal(cmd, `'/usr/bin/node' '/opt/app/autodev-cli/bin/autodev.js' start '/home/u/.autodev-app/offices/o/a' -p grok-acp`)
  assert.ok(!/grok --continue|--always-approve|wait_for_events/.test(cmd), 'the ACP loop must NOT use the grok TUI command / kick')
  assert.ok(cmd.includes('-p grok-acp'), 'must force the grok-acp provider on the loop')
})

test('buildLoopOperateCommand exports ELECTRON_RUN_AS_NODE only for Electron-node, per platform', () => {
  const posix = buildLoopOperateCommand(
    { nodeCmd: '/apps/AutoDev', cliJs: '/r/autodev-cli/bin/autodev.js', dir: '/d', provider: 'grok-acp', electronRunAsNode: true },
    'linux'
  )
  assert.ok(posix.startsWith('ELECTRON_RUN_AS_NODE=1 '), `posix inline-env prefix expected: ${posix}`)
  const win = buildLoopOperateCommand(
    { nodeCmd: 'C:/apps/AutoDev.exe', cliJs: 'C:/r/autodev-cli/bin/autodev.js', dir: 'C:/d', provider: 'grok-acp', electronRunAsNode: true },
    'win32'
  )
  assert.ok(win.startsWith('set "ELECTRON_RUN_AS_NODE=1" && '), `win32 set-env prefix expected: ${win}`)
  assert.ok(win.includes('-p grok-acp'))
  // System-node runner needs no env var.
  const sysNode = buildLoopOperateCommand(
    { nodeCmd: '/usr/bin/node', cliJs: '/r/bin/autodev.js', dir: '/d', provider: 'grok-acp', electronRunAsNode: false },
    'linux'
  )
  assert.ok(!sysNode.includes('ELECTRON_RUN_AS_NODE'), 'system node must not export ELECTRON_RUN_AS_NODE')
})

test('claude gets the kick via its positional [prompt] arg (resumes via --continue)', () => {
  // `claude --continue <prompt>` stays interactive; only `-p/--print` exits.
  assert.equal(buildOperateCommand('claude', false), `claude --continue '${KICK}'`)
  // The resumable flag is grok-only — claude ignores it.
  assert.equal(buildOperateCommand('claude', true), `claude --continue '${KICK}'`)
})

test('opencode gets the kick via the TUI command --prompt option (not headless `run`)', () => {
  const cmd = buildOperateCommand('opencode', false)
  assert.equal(cmd, `opencode --prompt '${KICK}'`)
  assert.ok(!/\brun\b/.test(cmd), 'must NOT use the headless `opencode run` command')
})

test('copilot gets the kick via -i/--interactive (not the headless -p/--prompt)', () => {
  const cmd = buildOperateCommand('copilot', false)
  assert.equal(cmd, `copilot -i '${KICK}'`)
})

test('empty / unknown provider defaults to claude --continue + kick', () => {
  assert.equal(buildOperateCommand('', false), `claude --continue '${KICK}'`)
  assert.equal(buildOperateCommand('something-else', false), `claude --continue '${KICK}'`)
})

test('EVERY provider gets an interactive kick and avoids its headless print-then-exit flag', () => {
  const cmds = [
    buildOperateCommand('grok', true),
    buildOperateCommand('grok', false),
    buildOperateCommand('claude', false),
    buildOperateCommand('opencode', false),
    buildOperateCommand('copilot', false),
    buildOperateCommand('', false)
  ]
  for (const cmd of cmds) {
    assert.ok(cmd.includes(`'${KICK}'`), `kick must be single-quoted as one argv token: ${cmd}`)
    assert.ok(cmd.includes('wait_for_events'), `kick must tell the model to call wait_for_events: ${cmd}`)
    // No provider's print-then-exit headless flag: grok -p/--single, claude -p/--print,
    // copilot -p/--prompt. `--prompt` IS correct for opencode's TUI, so only reject a
    // SPACE-form `-p`/`--single` here (opencode uses --prompt, not -p).
    assert.ok(!/\s-p\b|--single\b/.test(cmd), `must NOT use a print-then-exit headless flag: ${cmd}`)
    // The bin must remain the first token for PixelOffice's resolveBinOnPath pre-check.
    assert.ok(/^(grok|claude|opencode|copilot)\b/.test(cmd.trim()), `first token must be the provider bin: ${cmd}`)
  }
})

test('opencode never uses copilot/claude headless flags and vice-versa (no cross-wiring)', () => {
  assert.ok(!buildOperateCommand('opencode', false).includes('-i'), 'opencode must not borrow copilot -i')
  assert.ok(!buildOperateCommand('copilot', false).includes('--prompt'), 'copilot must not use opencode --prompt (its --prompt is headless)')
  assert.ok(!buildOperateCommand('claude', false).includes('--print'), 'claude must not use --print (headless)')
})
