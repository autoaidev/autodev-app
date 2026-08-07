import { EventEmitter } from 'events'
import * as pty from 'node-pty'
import { augmentPath } from './spawnEnv'

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
    const shell = process.env.SHELL || 'bash'
    const args = opts.command
      ? opts.keepShell === false
        // `command` is the final process: its exit ends the PTY and fires `exit`.
        ? ['-lc', opts.command]
        : ['-lc', `${opts.command}; echo; echo "[${opts.command} exited — shell]"; exec ${shell} -l`]
      : ['-il']
    try {
      const p = pty.spawn(shell, args, {
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
      return { error: String((e as Error)?.message ?? e) }
    }
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
