import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// React.StrictMode (dev only) mounts an effect, tears it down, then re-mounts it
// synchronously — which would ptyKill(id) then respawn the PTY on every mount,
// churning PTYs during `npm run dev`. So a pane's cleanup DEFERS its kill by a tick
// and the next mount CANCELS a still-pending kill for the same id: the synchronous
// remount wins the race, the live PTY survives, and no real respawn happens. A real
// close (no remount) still kills, just ~a tick later. Keyed by id, module-level so
// the two invocations of the same pane share it. (No-op in the production AppImage,
// which doesn't double-invoke effects.)
const pendingKills = new Map<string, ReturnType<typeof setTimeout>>()

/** A live terminal pane backed by a main-process PTY (runs `claude` in a folder). */
export default function TerminalPane({
  id, cwd, command, onExit, keepShell
}: { id: string; cwd: string; command?: string; onExit?: () => void; keepShell?: boolean }): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // A synchronous StrictMode remount lands here before the previous cleanup's
    // deferred kill fires — cancel it so the still-alive PTY is reused, not respawned.
    const stale = pendingKills.get(id)
    if (stale) { clearTimeout(stale); pendingKills.delete(id) }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0d1117', foreground: '#e6edf3' },
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)

    // Fit + resync the PTY size, then force a full repaint. On software-rendered
    // displays (e.g. Xvnc) xterm's initial canvas can stay blank until something
    // triggers a redraw — an explicit refresh avoids the "stuck on the welcome
    // banner until you resize the window" quirk.
    const refit = (): void => {
      try {
        fit.fit()
        window.api.ptyResize(id, term.cols, term.rows)
        term.refresh(0, term.rows - 1)
      } catch { /* not laid out yet */ }
    }
    // Defer the first fit past this paint so the container has real dimensions,
    // with a couple of follow-ups to catch slow (VNC) layout.
    requestAnimationFrame(refit)
    const t1 = setTimeout(refit, 120)
    const t2 = setTimeout(refit, 400)

    const dispInput = term.onData((d) => window.api.ptyWrite(id, d))
    let firstData = true
    const offData = window.api.onPtyData(({ id: pid, data }: { id: string; data: string }) => {
      if (pid !== id) return
      term.write(data)
      // The banner arrives before the canvas has painted under VNC — nudge once.
      if (firstData) { firstData = false; requestAnimationFrame(refit) }
    })
    const offExit = window.api.onPtyExit(({ id: pid }: { id: string; exitCode: number }) => {
      if (pid === id) { term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n'); onExit?.() }
    })

    // Surface a spawn failure IN the pane. PtyManager.spawn returns {error} (bad
    // cwd, missing $SHELL, node-pty ABI mismatch) and emits nothing on failure —
    // without this the pane stays a blank black box forever while the UI claims
    // the session is running.
    void window.api
      .ptySpawn(id, { cwd, command, cols: term.cols, rows: term.rows, keepShell })
      .then((res: { ok?: true; error?: string } | undefined) => {
        if (res?.error) {
          term.write('\r\n\x1b[31mFailed to start session: ' + res.error + '\x1b[0m\r\n')
          onExit?.()
        }
      })
      .catch((e: unknown) => {
        term.write('\r\n\x1b[31mFailed to start session: ' + String((e as Error)?.message ?? e) + '\x1b[0m\r\n')
        onExit?.()
      })

    const ro = new ResizeObserver(() => {
      try { fit.fit(); window.api.ptyResize(id, term.cols, term.rows) } catch { /* */ }
    })
    if (hostRef.current) ro.observe(hostRef.current)
    term.focus()

    return () => {
      clearTimeout(t1); clearTimeout(t2)
      dispInput.dispose(); offData(); offExit(); ro.disconnect()
      // Defer the kill so an immediate StrictMode remount can cancel it (above).
      const timer = setTimeout(() => { pendingKills.delete(id); void window.api.ptyKill(id) }, 0)
      pendingKills.set(id, timer)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return <div ref={hostRef} style={{ width: '100%', height: '100%', padding: 6, boxSizing: 'border-box' }} />
}
