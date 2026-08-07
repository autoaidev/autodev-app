import TerminalPane from './TerminalPane'

/** One open interactive terminal (one per operated office character). `command`
 *  is that agent's provider CLI (claude/grok/opencode/copilot). */
export interface OpenTerm {
  id: string
  cwd: string
  name: string
  mcpUrl?: string
  agentId: string
  command: string
}

interface TerminalTabsProps {
  terms: OpenTerm[]
  activeId: string
  endedIds: Set<string>
  /** Agent ids currently online in the office — drives the per-tab live badge. */
  onlineAgentIds: Set<string>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onExit: (id: string) => void
}

/**
 * A tab set that hosts N live PTY terminals (one per operated office character).
 *
 * CRITICAL keep-alive rule: a mounted TerminalPane === a live PTY, and unmounting
 * one SIGKILLs its PTY (TerminalPane's [id] cleanup calls ptyKill). So EVERY open
 * pane stays mounted; only the active one is visible (display:block) while the rest
 * are hidden with display:none. We never conditionally render just the active pane.
 */
export default function TerminalTabs({
  terms, activeId, endedIds, onlineAgentIds, onSelect, onClose, onExit
}: TerminalTabsProps): JSX.Element {
  const active = terms.find((t) => t.id === activeId)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Tab strip */}
      <div style={{ display: 'flex', overflowX: 'auto', borderBottom: '1px solid var(--border)', background: '#0d1117' }}>
        {terms.map((t) => {
          const isActive = t.id === activeId
          const ended = endedIds.has(t.id)
          const online = onlineAgentIds.has(t.agentId)
          const dot = ended ? '■' : online ? '●' : '◐'
          const dotColor = ended ? '#fecaca' : online ? '#7ee2a0' : '#f2cc60'
          return (
            <div
              key={t.id}
              onClick={() => onSelect(t.id)}
              title={t.name}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', cursor: 'pointer',
                borderRight: '1px solid var(--border)', whiteSpace: 'nowrap',
                background: isActive ? '#161b22' : 'transparent',
                borderBottom: isActive ? '2px solid var(--accent, #2f81f7)' : '2px solid transparent'
              }}
            >
              <span style={{ color: dotColor, fontSize: 10 }} title={ended ? 'ended' : online ? 'online (MCP)' : 'connecting…'}>{dot}</span>
              <span style={{ fontSize: 12, fontWeight: isActive ? 600 : 400 }}>{t.name.split(' · ')[0]}</span>
              <button
                title="Close this terminal (ends the session — character goes offline)"
                aria-label={`Close ${t.name}`}
                onClick={(e) => { e.stopPropagation(); onClose(t.id) }}
                style={{ marginLeft: 2, padding: '0 4px', lineHeight: 1, background: 'transparent', border: 'none', color: 'var(--muted,#8b949e)', cursor: 'pointer', fontSize: 13 }}
              >×</button>
            </div>
          )
        })}
      </div>

      {/* Active-tab status line (badge + cwd → mcpUrl) */}
      {active && (
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {endedIds.has(active.id)
            ? <span className="badge" style={{ background: '#3b0d0d', color: '#fecaca' }}>■ session ended — reopen</span>
            : onlineAgentIds.has(active.agentId)
              ? <span className="badge" style={{ background: '#12351f', color: '#7ee2a0' }}>● operating (MCP)</span>
              : <span className="badge" style={{ background: '#3a2f0a', color: '#f2cc60' }}>◐ connecting…</span>}
          <div style={{ fontSize: 12, fontWeight: 600 }}>{active.name}</div>
          <span className="badge" title="Provider launched in this terminal">{active.command}</span>
          <div style={{ flex: 1 }} />
          <button
            className="danger"
            title="End this session — the character goes offline"
            onClick={() => onClose(active.id)}
          >■ Close</button>
          <div style={{ flexBasis: '100%', fontSize: 10, color: 'var(--muted,#8b949e)', fontFamily: 'monospace' }}>
            {active.cwd}{active.mcpUrl ? '  →  ' + active.mcpUrl : ''}
          </div>
        </div>
      )}

      {/* Panes: ALL kept mounted, inactive ones hidden with CSS (never unmounted). */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, background: '#0d1117' }}>
        {terms.map((t) => (
          <div key={t.id} style={{ position: 'absolute', inset: 0, display: t.id === activeId ? 'block' : 'none' }}>
            <TerminalPane id={t.id} cwd={t.cwd} command={t.command} keepShell={false} onExit={() => onExit(t.id)} />
          </div>
        ))}
      </div>
    </div>
  )
}
