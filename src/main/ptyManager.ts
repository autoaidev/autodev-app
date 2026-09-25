import { EventEmitter } from 'events'
import * as pty from 'node-pty'
import { augmentPath } from './spawnEnv'
import { buildPtyInvocation, friendlySpawnError } from './ptyShell'

/**
 * Spawns interactive PTYs (one per pane) so the renderer can run a real terminal
 * — primarily `claude` in a chosen folder — via xterm.js. Data is streamed both
 * ways; panes can be resized and killed.
 *
 * By default, when the launched command exits we drop to an interactive login
 * shell so the pane stays usable. Callers that need to OBSERVE the command's exit
 * (e.g. an operate/resume pane where `claude` exiting means the office character
 * went offline) pass `keepShell:false` so `command` is the PTY's final process and
 * its exit propagates as a real `exit` event instead of being masked by the shell.
 */
export class PtyManager extends EventEmitter {
  private _ptys = new Map<string, pty.IPty>()

  /** Start a PTY. `command` (e.g. "claude") runs first, then — unless
   *  `keepShell` is false — an interactive shell; omit `command` for a plain
   *  terminal. Returns ok or an error string. */
  spawn(
    id: string,
    opts: { cwd: string; command?: string; cols?: number; rows?: number; keepShell?: boolean }
  ): { ok: true } | { error: string } {
    if (this._ptys.has(id)) return { ok: true }
    // Cross-platform shell + argv (win32 cmd.exe vs unix bash) — see ptyShell.ts.
    const { file, args } = buildPtyInvocation(opts.command, opts.keepShell)
    try {
      const p = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: opts.cols || 80,
        rows: opts.rows || 24,
        cwd: opts.cwd,
        env: { ...process.env, TERM: 'xterm-256color', PATH: augmentPath(process.env.PATH) }
      })
      p.onData((data) => this.emit('data', { id, data }))
      p.onExit(({ exitCode }) => {
        this.emit('exit', { id, exitCode })
        this._ptys.delete(id)
      })
      this._ptys.set(id, p)
      return { ok: true }
    } catch (e) {
      // Map a node-pty ENOENT / "File not found" to a clear, provider-named reason
      // (e.g. "Couldn't start "grok" — it wasn't found on your PATH…") rather than
      // the raw error, on every platform.
      return { error: friendlySpawnError(e, opts.command) }
    }
  }

  /** The OS process id of a live PTY (node-pty IPty.pid), or undefined if the id
   *  is unknown. Read this BEFORE kill(id) — kill() deletes the entry, after which
   *  the pid is gone. Used to reap the child's whole tree (e.g. grok's subprocess
   *  tree on Windows) via the bundled CLI's `kill-tree <pid>`. */
  pidOf(id: string): number | undefined {
    return this._ptys.get(id)?.pid
  }

  write(id: string, data: string): void {
    this._ptys.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try { this._ptys.get(id)?.resize(Math.max(1, cols), Math.max(1, rows)) } catch { /* pane gone */ }
  }

  kill(id: string): void {
    const p = this._ptys.get(id)
    if (p) { try { p.kill() } catch { /* already gone */ } this._ptys.delete(id) }
  }

  killAll(): void {
    for (const p of this._ptys.values()) { try { p.kill() } catch { /* */ } }
    this._ptys.clear()
  }
}
