import React from 'react'
import { AppShell, ContextMenu, ContextMenuEntry } from '@renderer/ui'
import { AgentRail, AgentAction, BulkAction } from '@renderer/components/agent/AgentRail'
import { AgentDetail, DetailTab } from '@renderer/components/agent/AgentDetail'
import { Inspector } from '@renderer/components/agent/Inspector'
import { useAgentTasks } from '@renderer/components/agent/useAgentTasks'
import { AgentState, ATTENTION_STATES } from '@renderer/services/model'
import { useAgents, getAgents, actions } from '@renderer/services/agentStore'
import { appendAgentLog, deleteAgentLog, pruneAgentLogs } from '@renderer/services/logBuffer'
import { AgentConfigModal } from '@renderer/modals/AgentConfigModal'
import { McpEditorModal } from '@renderer/modals/McpEditorModal'
import { MAIN_NAV, SETTINGS_NAV, type NavId } from '@renderer/nav'
import { useAppActions } from '@renderer/services/appActions'

/**
 * AgentsView — screen 2a. Three columns: the AgentRail (262), the AgentDetail
 * center, and the fixed Inspector (308). The live fleet comes from the shared
 * agentStore (useAgents) and the per-agent log buffer from the shared logBuffer
 * service (path-scoped, so a streamed line re-renders ONLY the visible
 * ActivityStream, never this whole view — composer/search keystrokes are never
 * dropped). This view owns only the current selection + bulk-check set and the
 * Setup / MCP modal open-state.
 *
 * All agent lifecycle goes through the real window.api (start/stop/restart/
 * removeFolder/openFolder/sendAgentMessage). Where the api lacks a field the
 * design wants, the nearest real value is used and marked // TODO(redesign).
 */
export function AgentsView(): React.JSX.Element {
  // Typed app-actions bus (replaces the window CustomEvent bus): nav routing,
  // the new-agent funnel, the global toast, and the openAgent / focusAttention
  // broadcasts this view subscribes to. Named `appActions` so it doesn't collide
  // with the agentStore `actions` (lifecycle start/stop/restart/remove) below.
  const appActions = useAppActions()
  // The live fleet comes from the shared agentStore (one seed/subscribe/poll for
  // the whole app); this view only owns selection, bulk-check and modal state.
  const agents = useAgents()
  const [selected, setSelected] = React.useState<string | undefined>(undefined)
  const [checked, setChecked] = React.useState<Set<string>>(new Set())
  const [detailTab, setDetailTab] = React.useState<DetailTab>('activity')

  const [configPath, setConfigPath] = React.useState<string | null>(null)
  const [mcpPath, setMcpPath] = React.useState<string | null>(null)
  const [menu, setMenu] = React.useState<{ x: number; y: number; agent: AgentState } | null>(null)

  // Prune log buffers for agents no longer in the fleet so the Map can't grow
  // unbounded (diff against the live set — a size gate would strand stale buffers
  // when one agent is removed as another is added), and default the selection to
  // the first agent once the fleet loads.
  React.useEffect(() => {
    pruneAgentLogs(new Set(agents.map((a) => a.path)))
    setSelected((cur) => cur ?? agents[0]?.path)
  }, [agents])

  // Broadcast intent: another screen (the Office view's "open this agent") asks us
  // to reveal a specific agent. App switches the top-nav to Agents; we own the
  // selection, so we resolve the office identity to a local workspace path and
  // select it here. Stays subscribed even while hidden (this view is kept mounted).
  React.useEffect(() => {
    return appActions.subscribeOpenAgent((d) => {
      if (!d) return
      // Read the latest fleet imperatively from the store so the match is a pure
      // lookup and the selection/tab/toast side-effects fire exactly once.
      const list = getAgents()
      // office is a SOFT filter: an identity (officeAgentSlug) or folder
      // (path ends with /agentSlug) match may stand alone, so a bound-but-
      // offline agent whose officeSlug isn't populated locally still resolves.
      const bySlug = (a: AgentState): boolean =>
        !!d.agentSlug && (a.officeAgentSlug === d.agentSlug || a.path.endsWith('/' + d.agentSlug))
      const match = d.path
        ? list.find((a) => a.path === d.path)
        : // prefer an exact office + slug hit, else fall back to slug/folder alone
          list.find((a) => a.officeSlug === d.officeSlug && bySlug(a)) ?? list.find(bySlug)
      if (match) {
        setSelected(match.path)
        setDetailTab('chat')
      } else if (d.path) {
        // A concrete workspace path that isn't in the fleet yet — e.g. it was just
        // registered (Sessions' "Open as agent") and the store's reload is still in
        // flight. Select it optimistically; displayAgent resolves once the poll
        // lands. NEVER the "runs remotely" toast (that's only for office-only refs).
        setSelected(d.path)
        setDetailTab('activity')
      } else {
        // No local workspace path resolved — the character runs remotely (office-
        // only, no local loop). App already switched to the Agents tab, so without
        // this the user lands on a blank/unchanged detail with no explanation.
        appActions.toast('That character runs remotely — no local agent to open.', false)
      }
    })
  }, [appActions])

  const current = agents.find((a) => a.path === selected)
  // KEEP-ALIVE: AgentDetail hosts the live terminal PTYs (termPaths/TerminalTab).
  // It must NEVER unmount on a selection change or a transient empty poll — an
  // unmount runs ptyKill on every taken-over shell. So we keep it mounted against
  // the last agent we showed (displayAgent) even when `current` is briefly
  // undefined (deselect / a poll that omits the selected path), and cover it with
  // the empty-state overlay instead. Only a truly empty fleet leaves it unmounted,
  // and then there are no PTYs to preserve.
  const lastAgentRef = React.useRef<AgentState | undefined>(undefined)
  if (current) lastAgentRef.current = current
  const displayAgent = current ?? lastAgentRef.current
  const running = agents.filter((a) => a.running).length
  const needsYou = agents.filter((a) => ATTENTION_STATES.has(a.activity)).length

  // ONE reconciled task truth for the shown agent, fed to BOTH the AgentDetail
  // header ("N/M done") and the Inspector TODO.md panel ("N / M") so the two
  // counters can never disagree (R8).
  const todo = useAgentTasks(displayAgent)

  // The shell's "N need you" pill (top bar) is clickable — bring the first agent
  // that needs attention into focus so the tally isn't a dead-end (R5). App brings
  // the Agents tab forward (onFocusAttention = go('agents')); we own the selection.
  React.useEffect(() => {
    return appActions.subscribeFocusAttention(() => {
      const hit = getAgents().find((a) => ATTENTION_STATES.has(a.activity))
      if (hit) {
        setSelected(hit.path)
        setDetailTab('activity')
      }
    })
  }, [appActions])

  /* ------------------------------------------------------------- lifecycle */

  const addTask = React.useCallback((path: string, text: string) => {
    appendAgentLog(path, `\n${new Date().toTimeString().slice(0, 5)} ✉ queued task: ${text}\n`)
    return window.api.sendAgentMessage(path, text)
  }, [])

  const onAction = React.useCallback(
    async (action: AgentAction, agent: AgentState) => {
      const p = agent.path
      switch (action) {
        case 'openFolder':
        case 'openEditor': // TODO(redesign): no dedicated editor-open api — opens the folder.
          window.api.openPath(p)
          break
        case 'openTerminal':
        case 'watch':
          setSelected(p)
          setDetailTab('terminal')
          break
        case 'copyPath':
          try {
            await navigator.clipboard?.writeText(p)
          } catch {
            /* clipboard unavailable */
          }
          break
        case 'stop':
          await actions.stop(p)
          break
        case 'restart':
          await actions.restart(p)
          break
        case 'connect':
          // TODO(redesign): the connect-to-office binding flow (officeBindWorkspace)
          // lives in a Stage-3 modal; open Setup as the nearest affordance for now.
          setConfigPath(p)
          break
        case 'setup':
          setConfigPath(p)
          break
        case 'remove': {
          const ok = await window.api.confirmDialog(`Remove ${agent.name}?`, `Deletes the workspace folder:\n${p}`)
          if (ok) {
            // actions.remove does removeAgentFolder + ptyKill(agent-term:<path>) +
            // reload; we own the confirm + drop this agent's log buffer + selection.
            await actions.remove(p)
            deleteAgentLog(p)
            if (selected === p) setSelected(undefined)
          }
          break
        }
      }
    },
    [selected]
  )

  const onBulk = React.useCallback(
    async (action: BulkAction) => {
      const paths = Array.from(checked)
      for (const p of paths) {
        if (action === 'start') await actions.start(p)
        else if (action === 'stop') await actions.stop(p)
        else if (action === 'restart') await actions.restart(p)
        // TODO(redesign): bulk 'add' needs a shared task-prompt UI — deferred to Stage 3.
      }
      if (action !== 'add') setChecked(new Set())
    },
    [checked]
  )

  const openMenu = React.useCallback((e: React.MouseEvent, agent: AgentState) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, agent })
  }, [])

  const detailMenuItems = (a: AgentState): ContextMenuEntry[] => [
    { label: 'Open agent folder', icon: 'folder', kbd: '⌘⏎', active: true, onClick: () => void onAction('openFolder', a) },
    { label: 'Open in editor', icon: 'editor', onClick: () => void onAction('openEditor', a) },
    { label: 'Open terminal here', icon: 'terminal', onClick: () => void onAction('openTerminal', a) },
    { label: 'Copy path', icon: 'copy', onClick: () => void onAction('copyPath', a) },
    { separator: true },
    { label: 'Stop loop', icon: 'stop', disabled: !a.running, onClick: () => void onAction('stop', a) },
    { label: 'Restart', icon: 'restart', onClick: () => void onAction('restart', a) },
    { label: 'Watch live session', icon: 'clock', onClick: () => void onAction('watch', a) },
    { label: 'Connect to office…', icon: 'office', onClick: () => void onAction('connect', a) },
    { label: 'Setup…', icon: 'gear', onClick: () => void onAction('setup', a) },
    { separator: true },
    { label: 'Remove…', icon: 'trash', danger: true, onClick: () => void onAction('remove', a) }
  ]

  return (
    <AppShell
      activeNav="agents"
      nav={MAIN_NAV}
      rightNav={SETTINGS_NAV}
      // Top-nav routing is owned by App.tsx: call the typed action, App switches the tab.
      onNavChange={(id) => appActions.navigate(id as NavId)}
      running={running}
      needsYou={needsYou}
      style={{ height: '100vh' }}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <AgentRail
          agents={agents}
          selectedPath={selected}
          onSelect={setSelected}
          checked={checked}
          onCheckedChange={setChecked}
          onNewAgent={() => appActions.newAgent()}
          onAction={(action, agent) => void onAction(action, agent)}
          onBulk={(action) => void onBulk(action)}
        />

        {/* Center column. AgentDetail stays mounted against displayAgent so its
            live terminal PTYs survive a deselect or a transient empty poll; the
            empty state is an overlay (not a conditional unmount) when !current. */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', position: 'relative' }}>
          {displayAgent && (
            <AgentDetail
              agent={displayAgent}
              livePaths={agents.map((a) => a.path)}
              taskCount={{ done: todo.done, total: todo.total }}
              tab={detailTab}
              onTabChange={setDetailTab}
              onStart={() => void actions.start(displayAgent.path)}
              onStop={() => void actions.stop(displayAgent.path)}
              onRestart={() => void actions.restart(displayAgent.path)}
              onOpenFolder={() => window.api.openPath(displayAgent.path)}
              onAddTask={(text) => void addTask(displayAgent.path, text)}
              onMenu={openMenu}
            />
          )}
          {!current && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                padding: 24,
                textAlign: 'center',
                background: 'var(--bg-0)'
              }}
            >
              {agents.length === 0 ? (
                // First run: no fleet at all. Point at the two real next actions
                // (spawn an agent, or open the getting-started guide) instead of the
                // "select an agent" copy that assumes agents already exist.
                <>
                  <div style={{ fontSize: 'var(--fs-agent-name)', fontWeight: 700, color: 'var(--tx-hi)' }}>
                    Welcome to AutoDev
                  </div>
                  <div style={{ maxWidth: 380, fontSize: 'var(--fs-meta)', color: 'var(--tx-dim)', lineHeight: 1.55 }}>
                    You have no agents yet. Create one to start — describe a task and let AutoDev generate a team, or
                    spawn a single agent in a folder.
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                    <button
                      type="button"
                      onClick={() => appActions.newAgent()}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 14px',
                        borderRadius: 'var(--r-button)',
                        background: 'var(--accent)',
                        border: '1px solid transparent',
                        color: 'var(--tx-onaccent)',
                        fontFamily: 'var(--font-sans)',
                        fontSize: 'var(--fs-meta)',
                        fontWeight: 700,
                        cursor: 'pointer'
                      }}
                    >
                      New agent
                    </button>
                    <button
                      type="button"
                      onClick={() => appActions.openHelp()}
                      style={{
                        padding: '6px 14px',
                        borderRadius: 'var(--r-button)',
                        background: 'var(--bg-input)',
                        border: '1px solid var(--bd-1)',
                        color: 'var(--tx-2)',
                        fontFamily: 'var(--font-sans)',
                        fontSize: 'var(--fs-meta)',
                        fontWeight: 600,
                        cursor: 'pointer'
                      }}
                    >
                      Getting started
                    </button>
                  </div>
                </>
              ) : (
                <span style={{ color: 'var(--tx-5)', fontSize: 'var(--fs-meta)' }}>
                  Select an agent to see its live work.
                </span>
              )}
            </div>
          )}
        </div>

        {current && (
          <Inspector
            agent={current}
            todo={todo}
            onEditSetup={() => setConfigPath(current.path)}
            onEditMcp={() => setMcpPath(current.path)}
            onWatch={() => setDetailTab('terminal')}
          />
        )}
      </div>

      {menu && (
        <ContextMenu
          header={menu.agent.path.split('/').filter(Boolean).pop()}
          items={detailMenuItems(menu.agent)}
          onClose={() => setMenu(null)}
          style={{ position: 'fixed', left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 360) }}
        />
      )}

      <AgentConfigModal agentPath={configPath ?? ''} open={configPath != null} onClose={() => setConfigPath(null)} />
      <McpEditorModal agentPath={mcpPath ?? ''} open={mcpPath != null} onClose={() => setMcpPath(null)} />
    </AppShell>
  )
}

export default AgentsView
