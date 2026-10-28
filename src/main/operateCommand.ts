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
 *   grok     → `grok --continue --always-approve '<kick>'` when a non-empty prior
 *              session exists for this scratch dir, else bare
 *              `grok --always-approve '<kick>'`. (POSITIONAL [PROMPT] arg.)
 *   claude   → `claude --continue '<kick>'` (resumes the most-recent session in this
 *              cwd, no picker; harmless when there is none — it just starts fresh;
 *              the kick rides claude's POSITIONAL [prompt] arg).
 *   opencode → `opencode --prompt '<kick>'` (the TUI command's own --prompt option).
 *   copilot  → `copilot -i '<kick>'` (copilot's dedicated interactive-with-prompt flag).
 *
 * `hasResumableGrokSession` is only consulted for grok; other providers ignore it.
 *
 * WHY EVERY OPERATE PROVIDER GETS A KICK PROMPT (the idle-at-TUI bug this fixes):
 * launched bare, a provider's interactive TUI opens and sits at an EMPTY prompt —
 * nobody ever types "start". Its chat then holds only the system prompt + skill
 * reminders, and it blocks idle having NEVER called the office bridge's
 * `wait_for_events` tool, so tasks the user sends from the web chat never reach it.
 * Passing an INITIAL PROMPT fixes this: it kicks the model into work on launch.
 *
 * THE CRITICAL CONSTRAINT (verified per-provider against each CLI's `--help`): the
 * prompt MUST be passed via a flag/arg that KEEPS THE SESSION INTERACTIVE &
 * PERSISTENT. Each provider has a HEADLESS single-turn "print-then-EXIT" mode that
 * would kill the wait_for_events loop after one turn — those are deliberately
 * AVOIDED here. Verification evidence (exact `--help` lines) per provider:
 *
 *   grok     INTERACTIVE: positional `[PROMPT]` "Initial prompt for the interactive
 *            session" (e.g. `grok "fix the bug"`). AVOID: `-p/--single` + the
 *            autodev-cli loop's `--prompt-file` (single-turn headless, print+exit).
 *   claude   INTERACTIVE: usage `claude [options] [command] [prompt]`, "starts an
 *            interactive session by default"; positional arg `prompt  Your prompt`.
 *            AVOID: `-p, --print` ("Print response and exit (useful for pipes)").
 *   opencode INTERACTIVE: the DEFAULT TUI command `opencode [project]` ("start
 *            opencode tui") carries its own `--prompt  prompt to use` option, which
 *            its handler feeds straight into the interactive TUI runner as the
 *            session's initial message (verified in the binary: the `$0 [project]`
 *            handler resolves `--prompt` and passes `prompt:C` into the TUI, exiting
 *            only after the TUI itself closes). AVOID: `opencode run [message..]`
 *            ("run opencode with a message") — the SEPARATE headless run command.
 *   copilot  INTERACTIVE: `-i, --interactive <prompt>  Start interactive mode and
 *            automatically execute this prompt` — the flag is literally "interactive
 *            + initial prompt". AVOID: `-p, --prompt <text>  Execute a prompt in
 *            non-interactive mode (exits after completion)`.
 *
 * The kick is deliberately terse (the agent's full operating guidance already lives
 * in its profile/system prompt): it only tells the model to call `wait_for_events`
 * now, service tasks/messages with its office tools, and keep calling
 * `wait_for_events` so it stays available. The semantics are identical across
 * providers, so one shared constant drives all of them.
 *
 * QUOTING: the result is handed to a PTY as `sh -lc "<command>"` (keepShell:false;
 * see ptyShell.buildPtyInvocation), so the login shell re-parses the whole string.
 * The kick is wrapped in SINGLE quotes so the multi-word prompt arrives as ONE argv
 * token intact; the text carries no apostrophes/`$`/backticks that single-quoting
 * wouldn't keep literal (asserted by the tests). The bin stays the FIRST token in
 * every case so PixelOffice's `resolveBinOnPath` pre-check still works.
 */
export const OPERATE_KICK_PROMPT =
  'Start operating now: call the wait_for_events tool immediately to receive office activity. ' +
  'When tasks or messages arrive, handle them using your office tools (get_tasks, complete_task, send_message, and the rest), ' +
  'then call wait_for_events again. Keep calling wait_for_events so you stay available and never sit idle.'

/**
 * @deprecated Back-compat alias — the kick is provider-agnostic now. Identical to
 * OPERATE_KICK_PROMPT; retained because existing tests/imports reference this name.
 */
export const GROK_OPERATE_KICK_PROMPT = OPERATE_KICK_PROMPT

export function buildOperateCommand(provider: string, hasResumableGrokSession: boolean): string {
  const p = String(provider ?? '').toLowerCase()
  const kick = `'${OPERATE_KICK_PROMPT}'`
  if (p.startsWith('grok')) {
    // POSITIONAL [PROMPT] keeps the TUI interactive (NOT `-p/--single`, which exits).
    const base = hasResumableGrokSession ? 'grok --continue --always-approve' : 'grok --always-approve'
    return `${base} ${kick}`
  }
  if (p.startsWith('claude') || p === '') {
    // POSITIONAL [prompt] keeps the session interactive (NOT `-p/--print`, which exits).
    return `claude --continue ${kick}`
  }
  if (p.startsWith('opencode')) {
    // The default TUI command's own --prompt option (NOT `opencode run`, which is headless).
    return `opencode --prompt ${kick}`
  }
  if (p.startsWith('copilot')) {
    // `-i/--interactive <prompt>` = interactive + initial prompt (NOT `-p/--prompt`, which exits).
    return `copilot -i ${kick}`
  }
  return `claude --continue ${kick}`
}
