import { useEffect, useState } from 'react'
import { Button, Icon } from '@renderer/ui'
import TerminalPane from '../../TerminalPane'
import { useCliStatus } from '@renderer/services/cliStatus'
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
 * This component is ALWAYS keyed per agent path by its keep-alive host (AgentDetail):
 * each agent gets its own instance, so `takenOver` is naturally scoped per agent
 * (a freshly selected agent starts read-only and never auto-spawns a shell), and a
 * taken-over instance stays mounted across agent-switches so its PTY survives. On
 * take-over we notify the host via onTakenOver so it keeps this path mounted.
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

export function TerminalTab({
  agentPath,
  onTakenOver,
  onStart
}: {
  agentPath: string
  onTakenOver?: () => void
  onStart?: () => void
}): JSX.Element {
  const [agent, setAgent] = useState<AgentLite | null>(null)
  // Start can't succeed without the AutoDev CLI runner — disable it + explain (R5).
  const { missing: cliMissing } = useCliStatus()
  // Once true, the interactive pane is mounted and stays mounted (keep-alive).
  const [takenOver, setTakenOver] = useState(false)
  // Mount the live pane AND tell the host to keep this path mounted so switching
  // agents never unmounts (SIGKILLs) it.
  const takeOver = (): void => {
    setTakenOver(true)
    onTakenOver?.()
  }

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
  const running = !!agent?.running
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
            <Button size="sm" onClick={takeOver}>
              Take over
            </Button>
          </>
        )}
      </div>

      <div className="dv-term__body">
        {takenOver ? (
          <TerminalPane id={ptyId} cwd={agentPath} keepShell onExit={() => { /* PTY exited; pane shows [session ended] */ }} />
        ) : (
          // ONE read-only statement (the header chip is the control); this block only
          // explains the state and differentiates STOPPED from a live "watch from a
          // distance". Take-over stays the header control — not restated here.
          <div className="dv-term__ph">
            <span className="dv-term__ph-glyph">
              <Icon name="terminal" size={26} />
            </span>
            {running ? (
              <>
                <div className="dv-term__ph-title">Watching {name} from a distance</div>
                <div className="dv-term__ph-body">
                  This agent runs in its own session, so its output isn&rsquo;t typed here.
                  Use <b>Take over</b> (top-right) to open an interactive shell in this
                  workspace and type directly.
                </div>
              </>
            ) : (
              <>
                <div className="dv-term__ph-title">Agent not running</div>
                <div className="dv-term__ph-body">
                  Start it to see its loop output, or take over to open an interactive shell
                  in this workspace.
                </div>
                {onStart && (
                  <>
                    <Button variant="primary" onClick={onStart} disabled={cliMissing}>
                      <Icon name="play" size={10} /> Start agent
                    </Button>
                    {cliMissing && (
                      <div className="dv-term__ph-body" style={{ color: 'var(--st-error-bright)' }}>
                        Install the AutoDev CLI to run agents.
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {takenOver && (
        <div className="dv-term__foot">
          <span className="dv-term__foot-hint">
            Interactive — type directly into the terminal · <kbd>Ctrl+C</kbd> interrupts
          </span>
        </div>
      )}
    </div>
  )
}
