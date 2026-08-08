import { useEffect, useState } from 'react'
import { Button, Icon } from '@renderer/ui'
import TerminalPane from '../../TerminalPane'
import './TerminalTab.css'

/**
 * TerminalTab (redesign screen 2f — the agent detail "Terminal" sub-tab).
 *
 * An interactive PTY pane rooted at the agent's workspace, wrapped in the
 * mockup's tmux-info-bar + read-only/Take-over chrome.
 *
 * CRITICAL keep-alive rule (CURRENT-APP.md §5.1): a mounted <TerminalPane> === a
 * live PTY, and unmounting it calls ptyKill → SIGKILL. So we mount TerminalPane
 * with a stable id and NEVER conditionally unmount it once created — Take over is
 * one-way (it only ever mounts the pane), and the parent (Stage 3) keeps this
 * whole tab mounted with display:none when another sub-tab is shown.
 *
 * TODO(redesign): the mockup's default "READ-ONLY" state mirrors the running
 * loop's own tmux session. The real PTY api (ptySpawn/onPtyData) has no
 * read-only tap into an already-running external loop — the read-only tail we DO
 * have is the log stream (onAgentLog), shown on the Activity sub-tab. So here
 * "Take over" opens a fresh interactive shell in the agent's workspace folder;
 * before that it shows a read-only placeholder rather than a fabricated mirror.
 */

interface AgentLite {
  path?: string
  name?: string
  provider?: string
  running?: boolean
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

export function TerminalTab({ agentPath }: { agentPath: string }): JSX.Element {
  const [agent, setAgent] = useState<AgentLite | null>(null)
  // Once true, the interactive pane is mounted and stays mounted (keep-alive).
  const [takenOver, setTakenOver] = useState(false)

  useEffect(() => {
    let alive = true
    void (window.api.agentState(agentPath) as Promise<AgentLite>).then((a) => {
      if (alive) setAgent(a ?? null)
    })
    const off = window.api.onAgentUpdated((s: AgentLite) => {
      if (s?.path === agentPath) setAgent(s)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [agentPath])

  const name = agent?.name || basename(agentPath)
  const provider = agent?.provider || 'shell'
  // Stable per-agent PTY id — reused so re-mounts (should not happen) map to one PTY.
  const ptyId = `agent-term:${agentPath}`

  return (
    <div className="dv-term">
      <div className="dv-term__bar">
        <span className="dv-term__bar-glyph">
          <Icon name="terminal" size={13} />
        </span>
        <span className="dv-term__bar-name">
          {provider}
          <span className="dv-term__bar-sep"> · </span>
          {name}
        </span>
        <span className="dv-term__bar-path" title={agentPath}>
          {agentPath}
        </span>
        {takenOver ? (
          <span className="dv-term__chip is-live">Live</span>
        ) : (
          <>
            <span className="dv-term__chip is-readonly">Read-only</span>
            <Button size="sm" onClick={() => setTakenOver(true)}>
              Take over
            </Button>
          </>
        )}
      </div>

      <div className="dv-term__body">
        {takenOver ? (
          <TerminalPane id={ptyId} cwd={agentPath} keepShell onExit={() => { /* PTY exited; pane shows [session ended] */ }} />
        ) : (
          <div className="dv-term__ph">
            <span className="dv-term__ph-glyph">
              <Icon name="terminal" size={26} />
            </span>
            <div className="dv-term__ph-title">Terminal is read-only</div>
            <div className="dv-term__ph-body">
              Watching {name} from a distance. Take over to open an interactive shell in this
              workspace and type directly — the running loop keeps its own session, so use
              <kbd> ⌃C</kbd> there to interrupt it.
            </div>
            <Button variant="primary" onClick={() => setTakenOver(true)}>
              Take over to type
            </Button>
          </div>
        )}
      </div>

      <div className="dv-term__foot">
        {takenOver ? (
          <span className="dv-term__foot-hint">
            Interactive — type directly into the terminal · <kbd>⌃C</kbd> interrupts
          </span>
        ) : (
          <button
            type="button"
            className="dv-term__takeover"
            onClick={() => setTakenOver(true)}
          >
            Take over to type into this session…
          </button>
        )}
      </div>
    </div>
  )
}
