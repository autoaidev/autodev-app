import { useEffect, useRef, useState } from 'react'
import TerminalPane from './TerminalPane'
import { Icon } from '@renderer/ui'
import { stripAnsi } from '@renderer/lib/ansi'

/**
 * One open pane in the office view. Two kinds:
 *  - `pty`: an interactive terminal running a provider CLI (Connect & operate).
 *           `cwd`/`command` drive TerminalPane; unmounting it SIGKILLs the PTY.
 *  - `log`: a READ-ONLY live log view of a tracked AgentManager loop (Spawn office).
 *           `path` is the workspace path = key into the `agent:log` stream buffer.
 *           Closing it is view-only — the loop keeps running in the background.
 */
export interface OpenTerm {
  id: string
  kind: 'pty' | 'log'
  name: string
  agentId: string
  /** Provider label for the status badge (pty uses `command`, log uses `provider`). */
  provider?: string
  // pty-only:
  cwd?: string
  mcpUrl?: string
  command?: string
  // log-only:
  path?: string
}

interface TerminalTabsProps {
  terms: OpenTerm[]
  activeId: string
  endedIds: Set<string>
  /** Agent ids currently online in the office — drives the per-tab live badge. */
  onlineAgentIds: Set<string>
  /** Read the current log buffer for a tracked loop (keyed by workspace path). */
  getLog: (path: string) => string
  /** Subscribe to log-stream ticks; returns an unsubscribe. Shared, no re-subscribe. */
  subscribeLog: (cb: () => void) => () => void
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onExit: (id: string) => void
}

// These panes render inside the redesign OfficeView, OUTSIDE the .legacy-app
// container — so the legacy bare `button` base rule (now scoped in styles.css) no
// longer reaches them. Style the status-line close buttons inline with the same
// look the base rule gave them so they stay self-contained (danger adds red text).
const closeBtnStyle: React.CSSProperties = {
  background: 'var(--bg3)', color: 'var(--fg)', border: '1px solid var(--border)',
  borderRadius: 6, padding: '7px 13px', cursor: 'pointer', fontSize: 13
}

/**
 * Read-only live log pane for a tracked loop. Self-subscribes to the shared log
 * stream and re-renders only itself (so many panes can coexist cheaply), reading
 * the latest buffer via getText() on each render and sticky-scrolling to the tail.
 */
function LogPane({ getText, subscribe }: { getText: () => string; subscribe: (cb: () => void) => () => void }): JSX.Element {
  const [, force] = useState(0)
  const ref = useRef<HTMLPreElement>(null)
  // Follow the tail only while the user is already parked at/near the bottom, so a
  // streaming loop no longer yanks the view back down when they scroll up to read.
  // Updated on every scroll (the pre-update at-bottom state) and seeded true so a
  // fresh pane starts pinned to the newest output. Mirrors ActivityStream's follow.
  const followRef = useRef(true)
  useEffect(() => subscribe(() => force((t) => t + 1)), [subscribe])
  // Strip ANSI/terminal escapes: this is a plain <pre>, not an xterm terminal, so a
  // raw loop's colour codes (\x1b[90m…) would otherwise render as literal text and
  // their ESC byte as a □ box (the "squares in the loop rendering" bug).
  const text = stripAnsi(getText())
  useEffect(() => {
    const el = ref.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [text])
  const onScroll = (): void => {
    const el = ref.current
    if (el) followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }
  return (
    <pre
      ref={ref}
      onScroll={onScroll}
      style={{
        margin: 0, height: '100%', overflow: 'auto', padding: '10px 14px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12,
        lineHeight: 1.5, color: 'var(--tx-1)', background: 'var(--surface-stage)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
      }}
    >{text || 'Waiting for the loop to produce output…'}</pre>
  )
}

/**
 * A tab set that hosts N office panes (one per operated/spawned character).
 *
 * CRITICAL keep-alive rule (pty panes only): a mounted TerminalPane === a live
 * PTY, and unmounting one SIGKILLs its PTY. So EVERY open pty pane stays mounted;
 * only the active one is visible (display:block). Log panes are read-only views of
 * a background loop and have no such lifecycle — keeping them mounted is harmless.
 */
export default function TerminalTabs({
  terms, activeId, endedIds, onlineAgentIds, getLog, subscribeLog, onSelect, onClose, onExit
}: TerminalTabsProps): JSX.Element {
  const active = terms.find((t) => t.id === activeId)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Tab strip */}
      <div style={{ display: 'flex', overflowX: 'auto', borderBottom: '1px solid var(--border)', background: 'var(--surface-stage)' }}>
        {terms.map((t) => {
          const isActive = t.id === activeId
          const ended = t.kind === 'pty' && endedIds.has(t.id)
          const online = onlineAgentIds.has(t.agentId)
          const dot = ended ? '■' : online ? '●' : '◐'
          const dotColor = ended ? 'var(--st-error-bright)' : online ? 'var(--st-running)' : 'var(--st-needsyou)'
          return (
            <div
              key={t.id}
              onClick={() => onSelect(t.id)}
              title={t.name}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', cursor: 'pointer',
                borderRight: '1px solid var(--border)', whiteSpace: 'nowrap',
                background: isActive ? 'var(--surface-chrome)' : 'transparent',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent'
              }}
            >
              <span style={{ color: dotColor, fontSize: 10 }} title={ended ? 'ended' : online ? 'online (MCP)' : 'connecting…'}>{dot}</span>
              {t.kind === 'log' && <span title="Tracked loop — read-only log" style={{ fontSize: 10 }}>▸</span>}
              <span style={{ fontSize: 12, fontWeight: isActive ? 600 : 400 }}>{t.name.split(' · ')[0]}</span>
              <button
                title={t.kind === 'log'
                  ? 'Close this log view (the loop keeps running — stop it from the office header)'
                  : 'Close this terminal (ends the session — character goes offline)'}
                aria-label={`Close ${t.name}`}
                onClick={(e) => { e.stopPropagation(); onClose(t.id) }}
                style={{ marginLeft: 2, padding: '0 4px', lineHeight: 1, background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13 }}
              >×</button>
            </div>
          )
        })}
      </div>

      {/* Active-tab status line */}
      {active && (
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {active.kind === 'log'
            ? <span className="badge" style={{ background: 'var(--accent-tint)', color: 'var(--accent-ink)' }}>▸ loop · read-only</span>
            : endedIds.has(active.id)
              ? <span className="badge" style={{ background: 'var(--st-error-wash)', color: 'var(--st-error-bright)' }}>■ session ended — reopen</span>
              : onlineAgentIds.has(active.agentId)
                ? <span className="badge" style={{ background: 'var(--st-running-soft)', color: 'var(--st-running)' }}>● operating (MCP)</span>
                : <span className="badge" style={{ background: 'var(--st-needsyou-soft)', color: 'var(--st-needsyou-ink)' }}>◐ connecting…</span>}
          <div style={{ fontSize: 12, fontWeight: 600 }}>{active.name}</div>
          <span className="badge" title="Provider">{active.kind === 'log' ? (active.provider || 'loop') : active.command}</span>
          <div style={{ flex: 1 }} />
          {active.kind === 'log'
            ? <button style={{ ...closeBtnStyle, display: 'inline-flex', alignItems: 'center', gap: 5 }} title="Close this log view — the loop keeps running (use Stop office to stop it)" onClick={() => onClose(active.id)}><Icon name="close" size={10} /> Close view</button>
            : <button style={{ ...closeBtnStyle, display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--red)' }} title="End this session — the character goes offline" onClick={() => onClose(active.id)}><Icon name="stop" size={9} /> Close</button>}
          <div style={{ flexBasis: '100%', fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace' }}>
            {active.kind === 'log'
              ? active.path
              : `${active.cwd ?? ''}${active.mcpUrl ? '  →  ' + active.mcpUrl : ''}`}
          </div>
        </div>
      )}

      {/* Panes: pty panes ALL kept mounted (keep-alive rule); log panes are read-only. */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, background: 'var(--surface-stage)' }}>
        {terms.map((t) => (
          <div key={t.id} style={{ position: 'absolute', inset: 0, display: t.id === activeId ? 'block' : 'none' }}>
            {t.kind === 'log'
              ? <LogPane getText={() => getLog(t.path || '')} subscribe={subscribeLog} />
              : <TerminalPane id={t.id} cwd={t.cwd || ''} command={t.command || ''} keepShell={false} onExit={() => onExit(t.id)} />}
          </div>
        ))}
      </div>
    </div>
  )
}
