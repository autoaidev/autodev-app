/**
 * ptyShell.ts — the PURE, cross-platform shell/argv selection for PtyManager,
 * split out so it has NO native (`node-pty`) import and can be unit-tested by
 * mocking `process.platform`.
 *
 * WHY THIS EXISTS (P0 win32 bug): PtyManager used to hard-code
 * `process.env.SHELL || 'bash'` + `['-lc', cmd]`, which is Unix-only. On Windows
 * `SHELL` is unset, so it tried to launch `bash` — absent on a stock Windows box —
 * and `node-pty` threw "File not found", breaking the interactive Operate pane
 * (`grok --always-approve`, `claude --continue`) and therefore every start / stop /
 * state that rides it. `buildPtyInvocation` picks the RIGHT shell per platform:
 *   • win32  → `%ComSpec%` (cmd.exe) so PATH + PATHEXT resolve `grok` / `grok.cmd`
 *              / `claude.cmd`. `/c` for the observe-exit case (command is the final
 *              process), `/k` to keep an interactive shell after it.
 *   • darwin/linux → the original `$SHELL`/bash `-lc` behaviour, unchanged.
 */

/** The concrete process + argv a PTY should launch. */
export interface PtyInvocation {
  /** Executable to spawn (the shell). */
  file: string
  /** Argv for the shell. */
  args: string[]
}

/** The interactive fallback shell for the keep-shell case, per platform. */
function interactiveShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  return platform === 'win32' ? env.ComSpec || 'cmd.exe' : env.SHELL || 'bash'
}

/**
 * Resolve the shell + argv for a PTY, cross-platform.
 *
 * @param command    the command to run (e.g. `grok --always-approve`); omit for a
 *                   plain interactive terminal.
 * @param keepShell  when NOT `false`, drop to an interactive shell after `command`
 *                   so the pane stays usable; when `false`, `command` is the PTY's
 *                   final process and its exit ends the PTY (fires `exit`).
 * @param platform   defaults to `process.platform` (injectable for tests).
 * @param env        defaults to `process.env` (injectable for tests).
 */
export function buildPtyInvocation(
  command: string | undefined,
  keepShell: boolean | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): PtyInvocation {
  const shell = interactiveShell(platform, env)

  if (platform === 'win32') {
    // cmd.exe: `/d` skips AutoRun, `/s` keeps the whole command string after
    // `/c`/`/k` intact (so quoting inside `command` isn't mangled).
    if (!command) return { file: shell, args: [] } // interactive cmd.exe
    if (keepShell === false) {
      // `command` is the final process — cmd exits with its code, firing `exit`.
      return { file: shell, args: ['/d', '/s', '/c', command] }
    }
    // Run `command`, then stay in an interactive cmd.exe (`/k`) so the pane lives on.
    return { file: shell, args: ['/d', '/s', '/k', command] }
  }

  // darwin / linux — unchanged login-shell behaviour.
  if (!command) return { file: shell, args: ['-il'] }
  if (keepShell === false) return { file: shell, args: ['-lc', command] }
  return {
    file: shell,
    args: ['-lc', `${command}; echo; echo "[${command} exited — shell]"; exec ${shell} -l`]
  }
}

/** The leading executable token of a shell command (`grok --resume x` → `grok`). */
export function firstToken(command?: string): string {
  const t = String(command ?? '').trim().split(/\s+/)[0] || ''
  // Strip a wrapping quote if the command was quoted.
  return t.replace(/^["']|["']$/g, '')
}

/**
 * Map a `node-pty` spawn failure to a clear, actionable message that names the
 * missing binary, instead of the raw "File not found" / ENOENT. Cross-platform:
 * on win32 the shell is cmd.exe, on unix bash — but the token the user cares about
 * is the provider CLI at the head of `command`.
 */
export function friendlySpawnError(
  err: unknown,
  command: string | undefined,
  platform: NodeJS.Platform = process.platform
): string {
  const raw = String((err as Error)?.message ?? err ?? '')
  const enoent = /ENOENT|File not found|not found|cannot find|no such file/i.test(raw)
  const bin = firstToken(command)
  if (enoent) {
    if (bin) {
      return `Couldn't start "${bin}" — it wasn't found on your PATH. Install it (and make sure it's on PATH), then try again.`
    }
    const shell = platform === 'win32' ? 'cmd.exe' : 'a shell'
    return `Couldn't start the session — ${shell} was not found. ${raw}`
  }
  return raw || 'Failed to start session'
}
