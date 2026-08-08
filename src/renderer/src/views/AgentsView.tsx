import React from 'react'
import { AppShell, ContextMenu, ContextMenuEntry } from '@renderer/ui'
import { AgentRail, AgentAction, BulkAction } from '@renderer/components/agent/AgentRail'
import { AgentDetail, DetailTab } from '@renderer/components/agent/AgentDetail'
import { Inspector } from '@renderer/components/agent/Inspector'
import { AgentState, ATTENTION_STATES } from '@renderer/components/agent/AgentRow'
import { AgentConfigModal } from '@renderer/modals/AgentConfigModal'
import { McpEditorModal } from '@renderer/modals/McpEditorModal'
import { MAIN_NAV, SETTINGS_NAV, navTo } from '@renderer/nav'

/**
 * AgentsView — screen 2a. Three columns: the AgentRail (262), the AgentDetail
 * center, and the fixed Inspector (308). It owns the fleet array (listAgents +
 * live onAgentUpdated/onAgentsChanged patches), the per-agent log buffer streamed
 * through onAgentLog (re-rendering ONLY the visible ActivityStream, never this
 * whole view — so composer/search keystrokes are never dropped), the current
 * selection + bulk-check set, and the Setup / MCP modal open-state.
 *
 * All agent lifecycle goes through the real window.api (start/stop/restart/
 * removeFolder/openFolder/sendAgentMessage). Where the api lacks a field the
 * design wants, the nearest real value is used and marked // TODO(redesign).
 */
export function AgentsView(): React.JSX.Element {
  const [agents, setAgents] = React.useState<AgentState[]>([])
  const [selected, setSelected] = React.useState<string | undefined>(undefined)
  const [checked, setChecked] = React.useState<Set<string>>(new Set())
  const [detailTab, setDetailTab] = React.useState<DetailTab>('activity')

  const [configPath, setConfigPath] = React.useState<string | null>(null)
  const [mcpPath, setMcpPath] = React.useState<string | null>(null)
  const [menu, setMenu] = React.useState<{ x: number; y: number; agent: AgentState } | null>(null)

  // Log buffer + a listener set so streamed lines re-render only the visible pane.
  const logsRef = React.useRef<Map<string, string>>(new Map())
  const logListeners = React.useRef<Set<() => void>>(new Set())
  const subscribeLog = React.useCallback((cb: () => void) => {
    logListeners.current.add(cb)
    return () => {
      logListeners.current.delete(cb)
    }
  }, [])

  // Read-only mirror of `agents` for event handlers (autodev:open-agent) that
  // need the latest fleet without re-subscribing. NEVER mutate agents through
  // this — it exists so those handlers don't have to abuse a setAgents updater
  // (which is impure and double-fires under StrictMode) just to read state.
  const agentsRef = React.useRef<AgentState[]>([])
  React.useEffect(() => {
    agentsRef.current = agents
  }, [agents])

  const refresh = React.useCallback(async () => {
    const list = (await window.api.listAgents()) as AgentState[]
    setAgents(list)
    setSelected((cur) => cur ?? list[0]?.path)
    // Prune log buffers for agents no longer in the fleet so the Map can't grow
    // unbounded. Always diff against the live set — a size gate would leave stale
    // buffers behind whenever an agent is removed while another is added.
    const live = new Set(list.map((a) => a.path))
    for (const p of logsRef.current.keys()) if (!live.has(p)) logsRef.current.delete(p)
  }, [])

  React.useEffect(() => {
    void refresh()
    const offChanged = window.api.onAgentsChanged(() => void refresh())
    const offUpdated = window.api.onAgentUpdated((s: AgentState) => {
      setAgents((prev) => {
        const i = prev.findIndex((a) => a.path === s.path)
        if (i === -1) return [...prev, s]
        const next = prev.slice()
        next[i] = s
        return next
      })
    })
    const offLog = window.api.onAgentLog(({ path, line }: { path: string; line: string }) => {
      const cur = logsRef.current.get(path) ?? ''
      logsRef.current.set(path, (cur + line).slice(-20000))
      logListeners.current.forEach((cb) => cb())
    })
    const poll = window.setInterval(() => void refresh(), 5000)
    return () => {
      offChanged()
      offUpdated()
      offLog()
      window.clearInterval(poll)
    }
  }, [refresh])

  // Soft-hook: another screen (the Office view's "open this agent") asks us to
  // reveal a specific agent. App switches the top-nav to Agents; we own the
  // selection, so we resolve the office identity to a local workspace path and
  // select it here. Stays wired even while hidden (this view is kept mounted).
  React.useEffect(() => {
    const onOpen = (e: Event): void => {
      const d = (e as CustomEvent).detail as { path?: string; officeSlug?: string; agentSlug?: string }
      if (!d) return
      // Read the latest fleet from the ref (not a setAgents updater) so the match
      // is a pure lookup and the selection/tab/toast side-effects fire exactly
      // once — an updater would double-run them under StrictMode.
      const list = agentsRef.current
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

  const start = React.useCallback((path: string) => window.api.startAgent(path), [])
  const stop = React.useCallback((path: string) => window.api.stopAgent(path), [])
  const restart = React.useCallback(async (path: string) => {
    await window.api.stopAgent(path)
    // small delay so the child fully exits before we respawn
    await new Promise((r) => setTimeout(r, 400))
    await window.api.startAgent(path)
  }, [])
  const addTask = React.useCallback((path: string, text: string) => {
    logsRef.current.set(path, (logsRef.current.get(path) ?? '') + `\n${new Date().toTimeString().slice(0, 5)} ✉ queued task: ${text}\n`)
    logListeners.current.forEach((cb) => cb())
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
          await stop(p)
          break
        case 'restart':
          await restart(p)
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
            await window.api.removeAgentFolder(p)
            logsRef.current.delete(p)
            // The keep-alive host never unmounts a taken-over TerminalPane on
            // switch, so a removed agent's shell PTY would leak (the agent is
            // gone but its `agent-term:<path>` process keeps running). This is
            // the one case where killing that specific PTY is correct — mirror
            // TerminalPane's own [id] teardown so no zombie shell remains.
            void window.api.ptyKill(`agent-term:${p}`)
            if (selected === p) setSelected(undefined)
            void refresh()
          }
          break
        }
      }
    },
    [stop, restart, selected, refresh]
  )

  const onBulk = React.useCallback(
    async (action: BulkAction) => {
      const paths = Array.from(checked)
      for (const p of paths) {
        if (action === 'start') await window.api.startAgent(p)
        else if (action === 'stop') await window.api.stopAgent(p)
        else if (action === 'restart') await restart(p)
        // TODO(redesign): bulk 'add' needs a shared task-prompt UI — deferred to Stage 3.
      }
      if (action !== 'add') setChecked(new Set())
    },
    [checked, restart]
  )

  const getLog = React.useCallback(() => {
    if (!displayAgent) return ''
    return logsRef.current.get(displayAgent.path) || displayAgent.lastOutput || ''
  }, [displayAgent])

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
              getLog={getLog}
              subscribeLog={subscribeLog}
              tab={detailTab}
              onTabChange={setDetailTab}
              onStart={() => void start(displayAgent.path)}
              onStop={() => void stop(displayAgent.path)}
              onRestart={() => void restart(displayAgent.path)}
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
