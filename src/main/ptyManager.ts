import { EventEmitter } from 'events'
import * as pty from 'node-pty'

/**
 * Spawns interactive PTYs (one per pane) so the renderer can run a real terminal
 * — primarily `claude` in a chosen folder — via xterm.js. Data is streamed both
 * ways; panes can be resized and killed. When the launched command exits we drop
 * to an interactive login shell so the pane stays usable.
 */
export class PtyManager extends EventEmitter {
  private _ptys = new Map<string, pty.IPty>()

  /** Start a PTY. `command` (e.g. "claude") runs first, then an interactive
   *  shell; omit it for a plain terminal. Returns ok or an error string. */
  spawn(
    id: string,
    opts: { cwd: string; command?: string; cols?: number; rows?: number }
  ): { ok: true } | { error: string } {
    if (this._ptys.has(id)) return { ok: true }
    const shell = process.env.SHELL || 'bash'
    const args = opts.command
      ? ['-lc', `${opts.command}; echo; echo "[${opts.command} exited — shell]"; exec ${shell} -l`]
      : ['-il']
    try {
      const p = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: opts.cols || 80,
        rows: opts.rows || 24,
        cwd: opts.cwd,
        env: { ...process.env, TERM: 'xterm-256color' }
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
