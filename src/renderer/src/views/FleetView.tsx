import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppShell, ContextMenu, Modal, Button } from '@renderer/ui'
import { FleetHeader } from '@renderer/components/fleet/FleetHeader'
import {
  NeedsYouTile,
  ThroughputTile,
  ProvidersTile,
  AttentionAction
} from '@renderer/components/fleet/StatTiles'
import { FleetTable, RowAction } from '@renderer/components/fleet/FleetTable'
import { FleetStatusBar, BulkVerb } from '@renderer/components/fleet/FleetStatusBar'
import {
  AgentState,
  ATTENTION_STATES,
  isAttention,
  formatElapsed
} from '@renderer/components/fleet/fleet-helpers'
import '@renderer/components/fleet/fleet.css'
import { MAIN_NAV, SETTINGS_NAV, navTo } from '@renderer/nav'

/**
 * 2b · Fleet — a single triage table that answers "what needs me" across the
 * whole fleet. Summary band (header + 3 stat tiles) over a data table, with a
 * bulk-action status bar at the bottom.
 *
 * Data is the same live fleet array the sidebar uses: `window.api.listAgents()`
 * seeded once, then patched in place via `onAgentUpdated` / reloaded on
 * `onAgentsChanged`. No new IPC — this is a richer render of AgentState.
 */

// window.api is exposed by the preload contextBridge (see src/preload/index.ts).
const api = (): any => (window as unknown as { api: any }).api

// Bulk actions here swallow per-agent errors; surface the outcome through the
// global toast wired in App.tsx (the 'redesign:toast' receiver) so feedback that
// previously had nowhere to go actually reaches the user.
const toast = (msg: string, err = false): void => {
  try {
    window.dispatchEvent(new CustomEvent('redesign:toast', { detail: { msg, err } }))
  } catch {
    /* ignore */
  }
}

const plural = (n: number): string => (n === 1 ? '' : 's')

// Flat provider list for the "Switch provider…" picker (mirrors App.tsx PROVIDER_GROUPS).
const PROVIDER_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'claude-tui', label: 'Claude — interactive' },
  { id: 'claude-cli', label: 'Claude — headless CLI' },
  { id: 'grok-tui', label: 'Grok — interactive' },
  { id: 'grok-cli', label: 'Grok — CLI' },
  { id: 'opencode-cli', label: 'OpenCode — CLI' },
  { id: 'opencode-sdk', label: 'OpenCode — SDK' },
  { id: 'copilot-cli', label: 'Copilot — CLI' },
  { id: 'copilot-sdk', label: 'Copilot — SDK' }
]

interface MenuState {
  path: string
  x: number
  y: number
}

export function FleetView(): React.JSX.Element {
  const [agents, setAgents] = useState<AgentState[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [bars, setBars] = useState<number[]>(() => new Array(10).fill(0))

  // TODO(redesign): AgentState exposes no task-start timestamp, so "elapsed" is
  // measured from when THIS session first observed the agent enter its current
  // task. It resets on app relaunch. A real per-task start time would need to be
  // surfaced from the hooks-events stream.
  const startedRef = useRef<Map<string, { task: string; since: number }>>(new Map())

  const trackElapsed = useCallback((list: AgentState[]) => {
    const m = startedRef.current
    const live = new Set<string>()
    const t = Date.now()
    for (const a of list) {
      const working = a.running || a.activity === 'working'
      const task = a.currentTask ?? ''
      if (working && task) {
        live.add(a.path)
        const cur = m.get(a.path)
        if (!cur || cur.task !== task) m.set(a.path, { task, since: t })
      } else {
        m.delete(a.path)
      }
    }
    for (const key of Array.from(m.keys())) if (!live.has(key)) m.delete(key)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const list = (await api().listAgents()) as AgentState[]
      trackElapsed(list)
      setAgents(list)
      // throughput sample: cumulative closed tasks across the fleet.
      const closed = list.reduce((s, a) => s + (a.tasks?.done ?? 0), 0)
      setBars((prev) => [...prev.slice(1), closed])
    } catch {
      /* transient — keep the last good list */
    }
  }, [trackElapsed])

  useEffect(() => {
    void refresh()
    const offUpdated = api().onAgentUpdated?.((s: AgentState) => {
      setAgents((prev) => {
        const next = prev.some((a) => a.path === s.path)
          ? prev.map((a) => (a.path === s.path ? s : a))
          : [...prev, s]
        trackElapsed(next)
        return next
      })
    })
    const offChanged = api().onAgentsChanged?.(() => void refresh())
    const poll = window.setInterval(() => void refresh(), 5000)
    const clock = window.setInterval(() => setNow(Date.now()), 15000)
    return () => {
      offUpdated?.()
      offChanged?.()
      window.clearInterval(poll)
      window.clearInterval(clock)
    }
  }, [refresh, trackElapsed])

  /* ------------------------------- derived -------------------------------- */

  // Attention first, then running, then idle; stable name order within a band.
  const sorted = useMemo(() => {
    const rank = (a: AgentState): number =>
      ATTENTION_STATES.has(a.activity) ? 0 : a.running ? 1 : 2
    return [...agents].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }, [agents])

  const attention = useMemo(() => sorted.filter(isAttention), [sorted])
  const runningCount = useMemo(() => agents.filter((a) => a.running).length, [agents])
  const officeCount = useMemo(
    () => new Set(agents.map((a) => a.officeSlug).filter(Boolean)).size,
    [agents]
  )
  const openTasks = useMemo(
    () => agents.reduce((s, a) => s + (a.tasks?.remaining ?? 0), 0),
    [agents]
  )
  // TODO(redesign): no historical/time-windowed source exists; "closed today"
  // is the live sum of TODO.md done counters, not a real 24h window.
  const closedToday = useMemo(
    () => agents.reduce((s, a) => s + (a.tasks?.done ?? 0), 0),
    [agents]
  )

  /* ------------------------------- actions -------------------------------- */

  const restart = useCallback(async (path: string) => {
    try {
      await api().stopAgent(path)
    } catch {
      /* may not be running */
    }
    try {
      await api().startAgent(path)
    } catch {
      /* surfaced via state */
    }
    void refresh()
  }, [refresh])

  const start = useCallback(
    async (path: string) => {
      try {
        await api().startAgent(path)
      } catch {
        /* ignore */
      }
      void refresh()
    },
    [refresh]
  )

  const stop = useCallback(
    async (path: string) => {
      try {
        await api().stopAgent(path)
      } catch {
        /* ignore */
      }
      void refresh()
    },
    [refresh]
  )

  const startAllIdle = useCallback(async () => {
    setBusy(true)
    const idle = agents.filter((a) => !a.running && !a.external)
    let failed = 0
    for (const a of idle) {
      try {
        await api().startAgent(a.path)
      } catch {
        failed++
      }
    }
    setBusy(false)
    if (failed) toast(`Couldn't start ${failed} of ${idle.length} agent${plural(idle.length)}`, true)
    void refresh()
  }, [agents, refresh])

  const stopAll = useCallback(async () => {
    setBusy(true)
    const running = agents.filter((a) => a.running)
    let failed = 0
    for (const a of running) {
      try {
        await api().stopAgent(a.path)
      } catch {
        failed++
      }
    }
    // mirror App.tsx: also kill any Operate PTYs owned by heavy views
    try {
      window.dispatchEvent(new Event('office:stop-all'))
    } catch {
      /* ignore */
    }
    setBusy(false)
    if (failed) toast(`Couldn't stop ${failed} of ${running.length} agent${plural(running.length)}`, true)
    void refresh()
  }, [agents, refresh])

  /* ---- attention verb per agent (NeedsYou tile + attention table rows) --- */

  const attentionAction = useCallback(
    (a: AgentState): AttentionAction => {
      switch (a.activity) {
        case 'needs-auth':
          // TODO(redesign): re-auth is interactive; restart is the closest the
          // app can drive headlessly. A true "Answer/Re-auth" flow would open
          // the provider login (not exposed on window.api for the fleet view).
          return { label: 'Re-auth', onClick: () => void restart(a.path) }
        case 'rate-limited':
          return { label: 'Retry', onClick: () => void restart(a.path) }
        case 'crashed':
        case 'stalled':
        default:
          return { label: 'Retry', onClick: () => void restart(a.path) }
      }
    },
    [restart]
  )

  /* -------------------------- add-task / provider -------------------------- */

  const [taskModal, setTaskModal] = useState<{ paths: string[] } | null>(null)
  const [taskText, setTaskText] = useState('')
  const [provModal, setProvModal] = useState<{ paths: string[] } | null>(null)
  const [provChoice, setProvChoice] = useState('claude-tui')

  const submitTask = useCallback(async () => {
    const text = taskText.trim()
    const paths = taskModal?.paths ?? []
    if (!text || paths.length === 0) {
      setTaskModal(null)
      return
    }
    let failed = 0
    for (const p of paths) {
      try {
        await api().sendAgentMessage(p, text) // appends "- [ ] text" to TODO.md
      } catch {
        failed++
      }
    }
    setTaskText('')
    setTaskModal(null)
    if (failed) toast(`Couldn't queue the task for ${failed} of ${paths.length} agent${plural(paths.length)}`, true)
    else toast(`Task queued for ${paths.length} agent${plural(paths.length)}`)
    void refresh()
  }, [taskText, taskModal, refresh])

  const submitProvider = useCallback(async () => {
    const paths = provModal?.paths ?? []
    let failed = 0
    for (const p of paths) {
      try {
        // TODO(redesign): no dedicated setProvider IPC; drive the CLI config.
        // Applies on the agent's NEXT task (needs a loop restart to take hold).
        await api().runCli(['config', 'set', 'provider', provChoice], p)
      } catch {
        failed++
      }
    }
    setProvModal(null)
    if (failed)
      toast(`Couldn't switch provider for ${failed} of ${paths.length} agent${plural(paths.length)}`, true)
    else if (paths.length)
      toast(`Provider set for ${paths.length} agent${plural(paths.length)} · restart to take hold`)
    void refresh()
  }, [provModal, provChoice, refresh])

  /* ------------------------------ row actions ----------------------------- */

  const rowAction = useCallback(
    (a: AgentState): RowAction => {
      if (isAttention(a)) {
        const act = attentionAction(a)
        return { kind: 'verb', label: act.label, onClick: () => act.onClick() }
      }
      if (!a.running) {
        return {
          kind: 'verb',
          label: 'Add',
          onClick: () => {
            setTaskText('')
            setTaskModal({ paths: [a.path] })
          }
        }
      }
      return {
        kind: 'more',
        label: 'More actions',
        onClick: (e) => setMenu({ path: a.path, x: e.clientX, y: e.clientY })
      }
    },
    [attentionAction]
  )

  const elapsedFor = useCallback(
    (a: AgentState): { text: string; color: string } => {
      const rec = startedRef.current.get(a.path)
      const ms = rec ? now - rec.since : null
      const text = formatElapsed(ms)
      let color = 'var(--tx-5)'
      if (ms == null) color = 'var(--tx-ghost)'
      else if (a.activity === 'crashed' || a.activity === 'stalled') color = 'var(--st-error)'
      else if (a.activity === 'needs-auth' || a.activity === 'rate-limited')
        color = 'var(--st-needsyou)'
      return { text, color }
    },
    [now]
  )

  const toggleSelect = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  /* --------------------------------- bulk --------------------------------- */

  const selPaths = useMemo(() => Array.from(selected), [selected])
  const bulkVerbs: BulkVerb[] = useMemo(
    () => [
      {
        label: 'Start',
        onClick: () => {
          selPaths.forEach((p) => {
            const a = agents.find((x) => x.path === p)
            if (a && !a.running) void start(p)
          })
        }
      },
      {
        label: 'Stop',
        onClick: () => {
          selPaths.forEach((p) => {
            const a = agents.find((x) => x.path === p)
            if (a && a.running) void stop(p)
          })
        }
      },
      { label: 'Switch provider…', onClick: () => setProvModal({ paths: selPaths }) },
      {
        label: 'Add task to all…',
        onClick: () => {
          setTaskText('')
          setTaskModal({ paths: selPaths })
        }
      }
    ],
    [selPaths, agents, start, stop]
  )

  const menuAgent = menu ? agents.find((a) => a.path === menu.path) : null

  /* --------------------------------- render ------------------------------- */

  return (
    <AppShell
      activeNav="fleet"
      nav={MAIN_NAV}
      rightNav={SETTINGS_NAV}
      onNavChange={(id) => navTo(id)}
      search
      running={runningCount}
      needsYou={attention.length}
      style={{ height: '100%' }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
        {/* summary band */}
        <div style={{ background: 'var(--bg-0)', padding: '18px 22px 0', flex: 'none' }}>
          <FleetHeader
            agentCount={agents.length}
            officeCount={officeCount}
            openTasks={openTasks}
            closedToday={closedToday}
            onStartAllIdle={() => void startAllIdle()}
            onStopAll={() => void stopAll()}
            busy={busy}
          />
          <div style={{ display: 'flex', gap: 12, marginTop: 16, marginBottom: 18 }}>
            <NeedsYouTile agents={attention} actionFor={attentionAction} />
            <ThroughputTile bars={bars} closed={closedToday} />
            <ProvidersTile agents={agents} />
          </div>
        </div>

        {/* data table (scrolls) */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--bg-0)', padding: '0 22px 20px' }}>
          <FleetTable
            agents={sorted}
            selected={selected}
            elapsedFor={elapsedFor}
            actionFor={rowAction}
            onToggleSelect={toggleSelect}
            onOpen={(path) => {
              // TODO(redesign): opening the 2a agent detail is Stage-3 routing;
              // for now selecting the row is the affordance.
              toggleSelect(path)
            }}
          />
        </div>

        <FleetStatusBar
          selectedCount={selected.size}
          verbs={bulkVerbs}
          showing={sorted.length}
          total={agents.length}
        />
      </div>

      {/* row "···" context menu */}
      {menu && menuAgent && (
        <div
          style={{
            position: 'fixed',
            // Clamp to the viewport so bottom/right rows don't open off-screen
            // (mirrors AgentsView).
            left: Math.min(menu.x, window.innerWidth - 240),
            top: Math.min(menu.y, window.innerHeight - 220),
            zIndex: 40
          }}
        >
          <ContextMenu
            header={menuAgent.name}
            onClose={() => setMenu(null)}
            items={[
              {
                label: 'Add task…',
                icon: 'plus',
                onClick: () => {
                  setTaskText('')
                  setTaskModal({ paths: [menuAgent.path] })
                  setMenu(null)
                }
              },
              {
                label: 'Restart',
                icon: 'restart',
                onClick: () => {
                  void restart(menuAgent.path)
                  setMenu(null)
                }
              },
              {
                label: 'Stop loop',
                icon: 'stop',
                danger: true,
                onClick: () => {
                  void stop(menuAgent.path)
                  setMenu(null)
                }
              },
              { separator: true },
              {
                label: 'Open folder',
                icon: 'folder',
                onClick: () => {
                  try {
                    api().openPath?.(menuAgent.path)
                  } catch {
                    /* ignore */
                  }
                  setMenu(null)
                }
              }
            ]}
          />
        </div>
      )}

      {/* add-task modal (single agent or bulk) */}
      <Modal
        open={!!taskModal}
        onClose={() => setTaskModal(null)}
        title="Add a task"
        subtitle={
          taskModal
            ? `Appends to TODO.md · ${taskModal.paths.length} agent${taskModal.paths.length === 1 ? '' : 's'} · applies on next task`
            : ''
        }
        subtitleMono
        width={460}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7 }}>
            <Button variant="secondary" size="sm" onClick={() => setTaskModal(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={() => void submitTask()}>
              Add task
            </Button>
          </div>
        }
      >
        <textarea
          value={taskText}
          onChange={(e) => setTaskText(e.target.value)}
          placeholder="Describe the task to queue…"
          autoFocus
          rows={3}
          style={{
            width: '100%',
            resize: 'vertical',
            background: 'var(--bg-input)',
            border: '1px solid var(--bd-1)',
            borderRadius: 'var(--r-input)',
            padding: '9px 11px',
            color: 'var(--tx-1)',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-meta)',
            outline: 'none'
          }}
        />
      </Modal>

      {/* switch-provider modal (bulk) */}
      <Modal
        open={!!provModal}
        onClose={() => setProvModal(null)}
        title="Switch provider"
        subtitle={
          provModal
            ? `${provModal.paths.length} agent${provModal.paths.length === 1 ? '' : 's'} · applies on next task (restart to take hold)`
            : ''
        }
        subtitleMono
        width={460}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7 }}>
            <Button variant="secondary" size="sm" onClick={() => setProvModal(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={() => void submitProvider()}>
              Apply
            </Button>
          </div>
        }
      >
        <select
          value={provChoice}
          onChange={(e) => setProvChoice(e.target.value)}
          style={{
            width: '100%',
            background: 'var(--bg-input)',
            border: '1px solid var(--bd-1)',
            borderRadius: 'var(--r-input)',
            padding: '8px 11px',
            color: 'var(--tx-hi)',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-body)',
            outline: 'none'
          }}
        >
          {PROVIDER_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Modal>
    </AppShell>
  )
}

export default FleetView
