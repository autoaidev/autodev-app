import React from 'react'
import { AppShell, ContextMenu, ContextMenuEntry, Modal, Button } from '@renderer/ui'
import { AgentRail, AgentAction, BulkAction } from '@renderer/components/agent/AgentRail'
import { AgentDetail, DetailTab } from '@renderer/components/agent/AgentDetail'
import { Inspector } from '@renderer/components/agent/Inspector'
import { useAgentTasks } from '@renderer/components/agent/useAgentTasks'
import { AgentState, ATTENTION_STATES } from '@renderer/services/model'
import { useAgents, getAgents, actions, refreshAgents } from '@renderer/services/agentStore'
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
  // Bumped whenever the Setup modal closes so the Inspector's inline Setup rows
  // re-read the persisted config after a modal Save (see Inspector `configRev`).
  // The `key={current.path}` on Inspector already remounts all per-agent transient
  // state when SWITCHING agents; this covers a modal Save on the SAME agent.
  const [configRev, setConfigRev] = React.useState(0)
  // "+ New agent" opens the single-agent create modal (AgentConfigModal in 'new'
  // mode) — a direct "add ONE local agent" path, distinct from the describe→team
  // wizard (reached via "Generate team…" → appActions.newAgent()).
  const [newAgentOpen, setNewAgentOpen] = React.useState(false)
  // When "Spawn new agent" is invoked from a folder group header, the new-agent
  // modal opens pre-scoped to that folder (a workspace path seeded inside it).
  const [newAgentFolder, setNewAgentFolder] = React.useState<string | undefined>(undefined)
  const [mcpPath, setMcpPath] = React.useState<string | null>(null)
  const [menu, setMenu] = React.useState<{ x: number; y: number; agent: AgentState } | null>(null)
  // Bulk "Add task" prompt: the checked agents captured at open + the one task
  // text typed once. Non-null = the modal is open. Enqueued to every path through
  // the SAME task path as the single-agent composer (addTask → sendAgentMessage).
  const [taskPrompt, setTaskPrompt] = React.useState<{ paths: string[]; text: string } | null>(null)

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
          window.api.openPath(p)
          break
        case 'openEditor': {
          // Open the workspace in an external editor via VS Code's URL handler
          // (a genuinely different action from openFolder, which reveals it in the
          // OS file manager). If no handler is registered — VS Code not installed —
          // fall back to revealing the folder so the item is never a dead-end.
          const uri = 'vscode://file' + p
          try {
            const r = (await window.api.openExternal(uri)) as { error?: string } | void
            if (r && typeof r === 'object' && r.error) window.api.openPath(p)
          } catch {
            window.api.openPath(p)
          }
          break
        }
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
      if (action === 'add') {
        // Open the shared task-prompt over the current selection; the enqueue and
        // the selection-clear happen once the user submits (submitBulkTask).
        if (paths.length > 0) setTaskPrompt({ paths, text: '' })
        return
      }
      for (const p of paths) {
        if (action === 'start') await actions.start(p)
        else if (action === 'stop') await actions.stop(p)
        else if (action === 'restart') await actions.restart(p)
      }
      setChecked(new Set())
    },
    [checked]
  )

  // Enqueue the one typed task to every agent captured when the prompt opened,
  // reusing addTask (→ window.api.sendAgentMessage) so a bulk task is delivered by
  // the exact same path as the single-agent composer. Clears the selection after.
  const submitBulkTask = React.useCallback(async () => {
    const prompt = taskPrompt
    const text = prompt?.text.trim()
    if (!prompt || !text) return
    await Promise.all(prompt.paths.map((p) => addTask(p, text)))
    setTaskPrompt(null)
    setChecked(new Set())
    const n = prompt.paths.length
    appActions.toast(`Queued task to ${n} agent${n === 1 ? '' : 's'}.`)
  }, [taskPrompt, addTask, appActions])

  // "Run all" on a folder group: start every agent in that folder that isn't
  // already running, via the SAME canonical start path as the row Start / bulk
  // Start (actions.start → startAgent with no -p, so each agent's own bound
  // provider/model is honored). Already-running agents are skipped so it can
  // never double-start. Fired in parallel and not awaited-in-sequence, so a big
  // folder doesn't freeze the rail; one fleet reload follows each start.
  const onRunFolder = React.useCallback((groupAgents: AgentState[]) => {
    const idle = groupAgents.filter((a) => !a.running)
    if (idle.length === 0) {
      appActions.toast('Every agent in that folder is already running.', false)
      return
    }
    idle.forEach((a) => void actions.start(a.path))
    appActions.toast(`Starting ${idle.length} agent${idle.length === 1 ? '' : 's'}…`)
  }, [appActions])

  // "Spawn new agent" on a folder group: open the new-agent modal pre-scoped to
  // this folder so the created workspace lands inside it. `folderDir` is the
  // directory that contains the group's agents; we seed a distinct subfolder so
  // the user can Create straight away without re-initializing the container.
  const onSpawnInFolder = React.useCallback((folderDir: string) => {
    const dir = folderDir.replace(/\/+$/, '')
    setNewAgentFolder(dir ? `${dir}/new-agent` : undefined)
    setNewAgentOpen(true)
  }, [])

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
          onNewAgent={() => {
            // The footer "New agent" is unscoped — clear any folder pre-seed.
            setNewAgentFolder(undefined)
            setNewAgentOpen(true)
          }}
          onGenerateTeam={() => appActions.newAgent()}
          onAction={(action, agent) => void onAction(action, agent)}
          onBulk={(action) => void onBulk(action)}
          onRunFolder={onRunFolder}
          onSpawnInFolder={onSpawnInFolder}
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
                background: 'var(--bg-detail)'
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
                    You have no agents yet. Add a single agent in a folder to start — or describe a task and let
                    AutoDev generate a whole team.
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                    <button
                      type="button"
                      onClick={() => setNewAgentOpen(true)}
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
                      onClick={() => appActions.newAgent()}
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
                      Generate team…
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => appActions.openHelp()}
                    style={{
                      marginTop: 2,
                      background: 'none',
                      border: 'none',
                      color: 'var(--accent)',
                      fontFamily: 'var(--font-sans)',
                      fontSize: 'var(--fs-meta)',
                      cursor: 'pointer'
                    }}
                  >
                    Getting started
                  </button>
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
            key={current.path}
            agent={current}
            todo={todo}
            configRev={configRev}
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

      <AgentConfigModal
        agentPath={configPath ?? ''}
        open={configPath != null}
        onClose={() => {
          setConfigPath(null)
          // A Save in this modal doesn't fire a fleet event for model/file-browser,
          // so nudge the Inspector's inline rows to re-read on close.
          setConfigRev((r) => r + 1)
        }}
      />
      {/* Single-agent create — "+ New agent". On success, refresh the fleet so the
          new agent shows at once (agents:add pushes no `changed` event) and select it. */}
      <AgentConfigModal
        mode="new"
        agentPath=""
        initialFolder={newAgentFolder}
        open={newAgentOpen}
        onClose={() => {
          setNewAgentOpen(false)
          setNewAgentFolder(undefined)
        }}
        onCreated={(p) => {
          refreshAgents()
          setSelected(p)
          setDetailTab('activity')
          setNewAgentFolder(undefined)
          appActions.toast('Agent added.')
        }}
      />
      <McpEditorModal agentPath={mcpPath ?? ''} open={mcpPath != null} onClose={() => setMcpPath(null)} />

      {/* Bulk "Add task": one task, typed once, queued to every checked agent. */}
      <Modal
        open={taskPrompt != null}
        onClose={() => setTaskPrompt(null)}
        title="Add task"
        subtitle={
          taskPrompt
            ? `Queues to ${taskPrompt.paths.length} selected agent${taskPrompt.paths.length === 1 ? '' : 's'}`
            : undefined
        }
        width={460}
        footer={
          <>
            <span style={{ marginRight: 'auto', fontSize: 'var(--fs-desc)', color: 'var(--tx-dim)' }}>
              ⌘⏎ to queue
            </span>
            <Button variant="secondary" size="sm" onClick={() => setTaskPrompt(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!taskPrompt?.text.trim()}
              onClick={() => void submitBulkTask()}
            >
              Queue task
            </Button>
          </>
        }
      >
        <textarea
          autoFocus
          value={taskPrompt?.text ?? ''}
          onChange={(e) => setTaskPrompt((cur) => (cur ? { ...cur, text: e.target.value } : cur))}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void submitBulkTask()
            }
          }}
          placeholder="Describe the task to queue for each selected agent…"
          rows={5}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            minHeight: 96,
            resize: 'vertical',
            padding: '8px 10px',
            borderRadius: 'var(--r-button)',
            background: 'var(--bg-input)',
            border: '1px solid var(--bd-1)',
            color: 'var(--tx-hi)',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-meta)',
            lineHeight: 1.5,
            outline: 'none'
          }}
        />
      </Modal>
    </AppShell>
  )
}

export default AgentsView
