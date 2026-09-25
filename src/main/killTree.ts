import { spawn } from 'child_process'
import { resolveCliJs, nodeRunner } from './cli'

/**
 * Reap a process's WHOLE tree cross-platform via the bundled CLI's
 * `kill-tree <pid>` (which runs `taskkill /PID <pid> /T /F` on win32, and a
 * tree walk elsewhere). This is the ONLY portable way to kill a loop's grok
 * child tree on Windows, where the app's own /proc-based descendant reaping
 * (AgentManager._descendantPids) finds nothing.
 *
 * Best-effort ONLY: fire-and-forget, never throws, never blocks the stop flow,
 * and no-ops when the pid is missing/invalid or the CLI can't be resolved.
 * Idempotent — safe to call alongside SIGKILL fallbacks on any platform.
 */
export function killTree(pid: number | undefined): void {
  try {
    if (!pid || pid <= 1) return
    const cliJs = resolveCliJs()
    if (!cliJs) return
    const { cmd, baseEnv } = nodeRunner()
    const child = spawn(cmd, [cliJs, 'kill-tree', String(pid)], {
      env: baseEnv,
      windowsHide: true,
      detached: false,
      stdio: 'ignore'
    })
    // Detach from our lifecycle; a spawn failure must never surface.
    child.on('error', () => {})
    child.unref?.()
  } catch {
    /* best-effort — a failed reap must never block or throw in the stop flow */
  }
}
