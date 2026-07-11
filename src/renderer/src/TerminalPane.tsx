import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/** A live terminal pane backed by a main-process PTY (runs `claude` in a folder). */
export default function TerminalPane({
  id, cwd, command, onExit
}: { id: string; cwd: string; command?: string; onExit?: () => void }): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
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
    try { fit.fit() } catch { /* not laid out yet */ }

    const dispInput = term.onData((d) => window.api.ptyWrite(id, d))
    const offData = window.api.onPtyData(({ id: pid, data }: { id: string; data: string }) => {
      if (pid === id) term.write(data)
    })
    const offExit = window.api.onPtyExit(({ id: pid }: { id: string; exitCode: number }) => {
      if (pid === id) { term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n'); onExit?.() }
    })

    void window.api.ptySpawn(id, { cwd, command, cols: term.cols, rows: term.rows })

    const ro = new ResizeObserver(() => {
      try { fit.fit(); window.api.ptyResize(id, term.cols, term.rows) } catch { /* */ }
    })
    if (hostRef.current) ro.observe(hostRef.current)
    term.focus()

    return () => {
      dispInput.dispose(); offData(); offExit(); ro.disconnect()
      void window.api.ptyKill(id)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return <div ref={hostRef} style={{ width: '100%', height: '100%', padding: 6, boxSizing: 'border-box' }} />
}
