import { spawn } from 'child_process'
import { resolveCliJs, nodeRunner } from './cli'

/**
 * Reap a grok agent's DETACHED leader + keepalive backend for a workspace `root`
 * via the bundled CLI's hidden `leader-stop <root>` (see autodev-cli
 * commands/leaderStop.ts). The CLI reads `<root>/.autodev/leader.json` and reaps
 * BOTH pid-trees (`pid` = the leader daemon, `keepalivePid` = the session holder)
 * BY PID, then removes the socket / sid / json. This is the ONLY portable reap:
 * once the loop exits the detached leader/keepalive reparent to init and are no
 * longer descendants of anything we can walk, and `grok leader kill` cannot see a
 * per-socket relay-on-demand leader — so we reap by the pids the CLI recorded.
 *
 * Called on every FULL teardown (office stop / remove / quit) for each grok
 * agent workspace, so the always-open feature never leaks detached daemons.
 *
 * Best-effort ONLY: fire-and-forget, never throws, never blocks the stop flow.
 * A no-op (exit 0, "no live grok leader") when there is no leader.json — so it is
 * safe to call for any grok workspace regardless of whether a leader was spawned.
 *
 * `detached: true` (the default) is what makes the QUIT reap correct: on
 * `before-quit` the app process is about to exit, and a non-detached child would
 * be torn down with it before it finished reaping. A detached + unref'd reaper
 * runs to completion independently, so the leader/keepalive are killed even as the
 * app exits. It is harmless for the app-stays-alive case too (it just exits after
 * reaping), so we use it uniformly.
 */
export function reapGrokLeader(root: string, opts?: { detached?: boolean }): void {
  try {
    const r = String(root ?? '').trim()
    if (!r) return
    const cliJs = resolveCliJs()
    if (!cliJs) return
    const { cmd, baseEnv } = nodeRunner()
    const detached = opts?.detached !== false
    const child = spawn(cmd, [cliJs, 'leader-stop', r], {
      env: baseEnv,
      windowsHide: true,
      detached,
      stdio: 'ignore'
    })
    // Detach from our lifecycle; a spawn failure must never surface.
    child.on('error', () => {})
    child.unref?.()
  } catch {
    /* best-effort — a failed reap must never block or throw in the teardown flow */
  }
}
