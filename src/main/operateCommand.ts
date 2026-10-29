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

/**
 * A LOOP/ACP provider is a persistent JSON-RPC-over-stdio engine driven by the
 * CLI's task loop (`autodev start <dir> -p <id>`), NOT an interactive TUI that
 * can self-drive inside a PTY pane. grok-acp is the first such provider: it runs
 * `grok agent stdio` under the CLI loop. These providers do NOT belong on the
 * raw-TUI operate path (`buildOperateCommand`); the operate pane runs them as the
 * loop instead (see `buildLoopOperateCommand` / PixelOffice.operate), so they
 * actually drive over ACP and JOIN the office rather than opening a grok TUI.
 *
 * Matched by EXACT id (and the `*-acp` family for obvious future ACP providers),
 * NEVER by `startsWith('grok')` — that was the original bug: it swept grok-acp
 * into the grok TUI command, so "Connect & operate" ran `grok --continue` and the
 * ACP engine never ran.
 */
export function isLoopProvider(provider: string): boolean {
  const p = String(provider ?? '').trim().toLowerCase()
  if (!p) return false
  return p === 'grok-acp' || p.endsWith('-acp')
}

/** POSIX single-quote a token so it arrives as one argv word, literal. */
function shSingleQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * Build the OPERATE-PANE command for a LOOP/ACP provider (e.g. grok-acp): run the
 * bundled CLI's persistent task loop — `autodev start <dir> -p <provider>` — in the
 * pane. Unlike the TUI providers, this is NOT an interactive chat; the pane shows
 * the loop's LOG (started/turn/completed), which is exactly what we want to SEE the
 * ACP driver working. The loop joins the office over WS (its serverApiKey/wsUrl were
 * written by the caller's office bind), posts started/completed to the office chat,
 * and shows online — identical to `autodev office <slug>` and `office:spawnOffice`.
 *
 * The command is handed to a PTY as `sh -lc "<cmd>"` (unix) / `cmd /d /s /c "<cmd>"`
 * (win32), so it must be a self-contained shell line. We run the EXACT bundled CLI
 * via its resolved node runner (absolute paths, double-quoted for spaces) rather
 * than a bare `autodev`, because `autodev` is frequently not on a GUI PATH even
 * though the app bundles the CLI. When the runner is Electron's own node we must
 * export ELECTRON_RUN_AS_NODE=1 (the "ELECTRON_RUN_AS_NODE trap"), per-platform.
 */
export function buildLoopOperateCommand(
  opts: { nodeCmd: string; cliJs: string; dir: string; provider: string; electronRunAsNode?: boolean },
  platform: NodeJS.Platform = process.platform
): string {
  const provider = String(opts.provider ?? '').trim() || 'grok-acp'
  if (platform === 'win32') {
    // cmd.exe: double-quote each path; `set VAR=val &&` prefix when Electron-node.
    const q = (s: string): string => `"${String(s).replace(/"/g, '')}"`
    const core = `${q(opts.nodeCmd)} ${q(opts.cliJs)} start ${q(opts.dir)} -p ${provider}`
    return opts.electronRunAsNode ? `set "ELECTRON_RUN_AS_NODE=1" && ${core}` : core
  }
  // POSIX: single-quote each path; `VAR=val cmd` inline-env prefix when Electron-node.
  const core = `${shSingleQuote(opts.nodeCmd)} ${shSingleQuote(opts.cliJs)} start ${shSingleQuote(opts.dir)} -p ${provider}`
  return opts.electronRunAsNode ? `ELECTRON_RUN_AS_NODE=1 ${core}` : core
}

export function buildOperateCommand(provider: string, hasResumableGrokSession: boolean): string {
  const p = String(provider ?? '').toLowerCase()
  const kick = `'${OPERATE_KICK_PROMPT}'`
  // grok-acp (and any ACP/loop provider) is NOT a TUI — it must NEVER get the grok
  // TUI command here. Its routing lives in PixelOffice.operate (the loop path); this
  // guard just makes the pure builder refuse to mis-handle it if ever called.
  if (isLoopProvider(p)) {
    throw new Error(`buildOperateCommand called for loop/ACP provider '${p}' — route it to the loop (autodev start -p ${p}), not the TUI.`)
  }
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
