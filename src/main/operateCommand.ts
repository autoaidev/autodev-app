/**
 * operateCommand — the pure builder for an Operate pane's raw-TUI launch command.
 *
 * Extracted from PixelOffice so the grok resume decision is unit-testable without
 * electron/fs (pixelOffice.ts imports `electron` at module top, so it can't be
 * imported from a node:test). The session-PRESENCE lookup (does a resumable grok
 * transcript exist for this dir?) stays in PixelOffice; this module decides the
 * command GIVEN that boolean.
 *
 * Why grok resumes via `--continue` and NOT `--resume <id>` (the bug this fixes):
 * the app's "Connect & operate" pane re-launches grok per turn. The old command
 * `grok --resume <id> --always-approve` passed an id WE computed (newest session
 * by mtime under the URL-encoded cwd). That id is fragile: grok keys sessions by
 * its OWN encoding of the process cwd, so a stale id or a cwd-encoding/realpath
 * mismatch makes `grok --resume <id>` error on launch and FALL BACK TO A FRESH,
 * STATELESS session. The operate character then opens a blank chat that holds only
 * the system prompt + skill-list reminders — no prior context, no task — so grok
 * sits idle at an empty prompt forever (the observed post-turn-1 stall). grok's
 * own `-c, --continue` ("continue the most recent session for the current working
 * directory") lets grok resolve the newest session for the REAL cwd itself, which
 * is immune to our id-tracking drift. This mirrors the autodev-cli grok provider,
 * which abandoned per-turn `--resume <id>` for `--continue` for exactly this reason
 * (see autodev-cli src/providers/grok/tui.ts `grokSessionArgsFor`).
 *
 *   grok    → `grok --continue --always-approve '<kick>'` when a non-empty prior
 *             session exists for this scratch dir, else bare
 *             `grok --always-approve '<kick>'`.
 *   claude  → `claude --continue` (resumes the most-recent session in this cwd, no
 *             picker; harmless when there is none — it just starts fresh).
 *   opencode/copilot → bare (no clean, non-interactive continue flag).
 *
 * `hasResumableGrokSession` is only consulted for grok; other providers ignore it.
 *
 * WHY grok gets a KICK PROMPT (the idle-at-TUI bug this fixes):
 * launched bare (`grok --always-approve`), grok opens its interactive TUI and sits
 * at an EMPTY prompt — nobody ever types "start". Its chat then holds only the
 * system prompt + skill reminders, and it blocks idle (futex_wait) having never
 * called the office bridge's `wait_for_events` tool, so tasks the user sends from
 * the web chat never reach it. Passing an INITIAL PROMPT fixes this: grok's
 * POSITIONAL `[PROMPT]` arg ("Initial prompt for the interactive session", e.g.
 * `grok "fix the bug"`) kicks the model into work on launch WHILE KEEPING THE TUI
 * INTERACTIVE/PERSISTENT — the opposite of grok's `-p/--single` (and the autodev-cli
 * loop's `--prompt-file`), which are single-turn HEADLESS and print-then-EXIT, so
 * the wait_for_events loop would die after one turn. The kick is deliberately terse
 * (the agent's full operating guidance already lives in its profile/system prompt):
 * it only tells grok to call `wait_for_events` now, service tasks/messages with its
 * office tools, and keep calling `wait_for_events` so it stays available.
 *
 * QUOTING: the result is handed to a PTY as `sh -lc "<command>"` (keepShell:false;
 * see ptyShell.buildPtyInvocation), so the login shell re-parses the whole string.
 * The kick is wrapped in SINGLE quotes so the multi-word prompt arrives as ONE argv
 * token intact; the text carries no apostrophes/`$`/backticks that single-quoting
 * wouldn't keep literal.
 */
export const GROK_OPERATE_KICK_PROMPT =
  'Start operating now: call the wait_for_events tool immediately to receive office activity. ' +
  'When tasks or messages arrive, handle them using your office tools (get_tasks, complete_task, send_message, and the rest), ' +
  'then call wait_for_events again. Keep calling wait_for_events so you stay available and never sit idle.'

export function buildOperateCommand(provider: string, hasResumableGrokSession: boolean): string {
  const p = String(provider ?? '').toLowerCase()
  if (p.startsWith('grok')) {
    const base = hasResumableGrokSession ? 'grok --continue --always-approve' : 'grok --always-approve'
    return `${base} '${GROK_OPERATE_KICK_PROMPT}'`
  }
  if (p.startsWith('claude') || p === '') return 'claude --continue'
  if (p.startsWith('opencode')) return 'opencode'
  if (p.startsWith('copilot')) return 'copilot'
  return 'claude --continue'
}
