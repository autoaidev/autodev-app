import React from 'react'
import { AppShell, ContextMenu, ContextMenuEntry } from '@renderer/ui'
import { AgentRail, AgentAction, BulkAction } from '@renderer/components/agent/AgentRail'
import { AgentDetail, DetailTab } from '@renderer/components/agent/AgentDetail'
import { Inspector } from '@renderer/components/agent/Inspector'
import { AgentState, ATTENTION_STATES } from '@renderer/services/model'
import { useAgents, getAgents, actions } from '@renderer/services/agentStore'
import { appendAgentLog, deleteAgentLog, pruneAgentLogs } from '@renderer/services/logBuffer'
import { AgentConfigModal } from '@renderer/modals/AgentConfigModal'
import { McpEditorModal } from '@renderer/modals/McpEditorModal'
import { MAIN_NAV, SETTINGS_NAV, navTo } from '@renderer/nav'

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

  // Soft-hook: another screen (the Office view's "open this agent") asks us to
  // reveal a specific agent. App switches the top-nav to Agents; we own the
  // selection, so we resolve the office identity to a local workspace path and
  // select it here. Stays wired even while hidden (this view is kept mounted).
  React.useEffect(() => {
    const onOpen = (e: Event): void => {
      const d = (e as CustomEvent).detail as { path?: string; officeSlug?: string; agentSlug?: string }
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
      } else {
        // No local workspace path resolved — the character runs remotely (office-
        // only, no local loop). App already switched to the Agents tab, so without
        // this the user lands on a blank/unchanged detail with no explanation.
        window.dispatchEvent(
          new CustomEvent('redesign:toast', {
            detail: { msg: 'That character runs remotely — no local agent to open.', err: false }
          })
        )
      }
    }
    window.addEventListener('autodev:open-agent', onOpen)
    return () => window.removeEventListener('autodev:open-agent', onOpen)
  }, [])

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
        case 'duplicate':
          // TODO(redesign): no duplicate-agent api; a Stage-3 flow will clone the folder.
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
    { label: 'Duplicate', icon: 'duplicate', onClick: () => void onAction('duplicate', a) },
    { label: 'Remove…', icon: 'trash', danger: true, onClick: () => void onAction('remove', a) }
  ]

  return (
    <AppShell
      activeNav="agents"
      nav={MAIN_NAV}
      rightNav={SETTINGS_NAV}
      // Top-nav routing is owned by App.tsx (Stage 3): broadcast the intent, App switches the tab.
      onNavChange={(id) => navTo(id)}
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
          onNewAgent={() => window.dispatchEvent(new CustomEvent('redesign:new-agent'))}
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
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--tx-5)',
                fontSize: 'var(--fs-meta)',
                background: 'var(--bg-0)'
              }}
            >
              Select an agent to see its live work.
            </div>
          )}
        </div>

        {current && (
          <Inspector
            agent={current}
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
