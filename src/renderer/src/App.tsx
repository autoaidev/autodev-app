import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import SessionsBrowser from './SessionsBrowser'
import PixelOfficeView from './PixelOfficeView'
import MakeAppView from './MakeAppView'
import SettingsView from './SettingsView'
import OfficeSelector from './OfficeSelector'
import FileBrowserCheckbox from './FileBrowserCheckbox'
import { useOfficeSelection, connectAgentToNewCharacter } from './composables/useOfficeSelection'
import { extractFlagUrl } from './urlExtract'

type Activity = 'working' | 'idle' | 'stopped' | 'stalled' | 'needs-auth' | 'rate-limited' | 'crashed'
interface AgentState {
  path: string
  name: string
  provider?: string
  sessionName?: string
  wsUrl?: string
  running: boolean
  /** Running via a loop this app didn't start (external CLI / remote VM) — shown
   *  as "running (external)"; the app won't spawn a duplicate for these. */
  external?: boolean
  online?: boolean
  activity: Activity
  tasks: { total: number; remaining: number; done: number }
  currentTask?: string
  lastOutput?: string
  error?: string
  exitCode?: number | null
  // Office chat identity (surfaced by the main-process presence merge). The
  // endpoint/agent slug is always known when the workspace is office-bound; the
  // office slug + numeric agent id resolve once the office has been polled.
  officeAgentSlug?: string
  officeSlug?: string
  officeAgentId?: string
}

// Human labels + whether the state needs the operator's attention (drives the
// status pill/dot styling and the recovery CTA).
const ACTIVITY_LABEL: Record<Activity, string> = {
  working: 'Working', idle: 'Idle', stopped: 'Stopped', stalled: 'Stalled',
  'needs-auth': 'Needs re-auth', 'rate-limited': 'Rate-limited', crashed: 'Crashed'
}
const ATTENTION_STATES = new Set<Activity>(['stalled', 'needs-auth', 'rate-limited', 'crashed'])

// One vocabulary for "link this local agent to an office character" — shared by the
// header button, the ConnectModal title, and the Sessions browser, so the app's
// core flow is never named three different things.
export const CONNECT_LABEL = 'Connect to office'

// Grouped by vendor with human labels, so the first decision a new user makes
// isn't a wall of 8 cryptic slugs. claude-tui is the recommended default.
const PROVIDER_GROUPS: Array<{ vendor: string; options: Array<{ id: string; label: string }> }> = [
  { vendor: 'Claude', options: [{ id: 'claude-tui', label: 'Claude — interactive (recommended)' }, { id: 'claude-cli', label: 'Claude — headless CLI' }] },
  { vendor: 'GitHub Copilot', options: [{ id: 'copilot-cli', label: 'Copilot — CLI' }, { id: 'copilot-sdk', label: 'Copilot — SDK (API key)' }] },
  { vendor: 'OpenCode', options: [{ id: 'opencode-cli', label: 'OpenCode — CLI' }, { id: 'opencode-sdk', label: 'OpenCode — SDK (API key)' }] },
  { vendor: 'Grok', options: [{ id: 'grok-cli', label: 'Grok — CLI' }, { id: 'grok-tui', label: 'Grok — interactive' }] }
]
const PROVIDER_HINT = 'interactive = a terminal you can watch/log into · CLI = headless · SDK = needs an API key'

// Compact workspace label for the sidebar row: the last two path segments
// (parent/name), e.g. /home/epicmovies/public_html/homm_team/director →
// "homm_team/director". Enough to tell which agent lives where when several
// share a parent folder; the full path is the row's title tooltip.
const shortPath = (p?: string): string => {
  if (!p) return ''
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts.slice(-2).join('/') || p
}

// The containing folder of a workspace (its path minus the last segment) — the
// grouping key for "group by folder". `folderLabel` shortens it for the header.
const parentDir = (p?: string): string => {
  if (!p) return ''
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean)
  parts.pop()
  return '/' + parts.join('/')
}
const folderLabel = (dir: string): string => shortPath(dir) || dir || '(root)'

function ProviderSelect({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }): JSX.Element {
  return (
    <>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={id ? id + '-hint' : undefined}>
        {PROVIDER_GROUPS.map((g) => (
          <optgroup key={g.vendor} label={g.vendor}>
            {g.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </optgroup>
        ))}
      </select>
      <div id={id ? id + '-hint' : undefined} style={{ color: 'var(--fg2)', fontSize: 11, marginTop: 4, textTransform: 'none', letterSpacing: 0 }}>{PROVIDER_HINT}</div>
    </>
  )
}

// Visually-hidden but screen-reader-available (for persistent aria-live regions).
const srOnly: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0
}

// Keep Tab within a dialog and restore focus to the trigger on close, so keyboard
// and screen-reader users aren't dropped into the obscured sidebar behind the
// backdrop (which aria-modal claims is hidden).
function useFocusTrap<T extends HTMLElement>(): React.RefObject<T> {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const prev = document.activeElement as HTMLElement | null
    const sel = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusables = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>(sel))
    const first = focusables()[0]
    if (first && !el.contains(document.activeElement)) first.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const f = focusables()
      if (!f.length) return
      const a = f[0], b = f[f.length - 1]
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus() }
      else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus() }
    }
    el.addEventListener('keydown', onKey)
    return () => { el.removeEventListener('keydown', onKey); try { prev?.focus() } catch { /* gone */ } }
  }, [])
  return ref
}

export default function App(): JSX.Element {
  const [agents, setAgents] = useState<AgentState[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [showSessions, setShowSessions] = useState(false)
  const [showOffice, setShowOffice] = useState(false)
  const [showMakeApp, setShowMakeApp] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  // Once a heavy view (Office / Sessions / Make-app) has been opened we keep it
  // MOUNTED and merely toggle its visibility with CSS `display` — switching tabs or
  // re-clicking a sidebar button must never unmount it, or its child TerminalPane's
  // cleanup would SIGKILL the live Operate/Resume PTY that keeps the office
  // character online (and lose the terminal scrollback). Lazy: nothing mounts until
  // first opened.
  const [openedSessions, setOpenedSessions] = useState(false)
  const [openedOffice, setOpenedOffice] = useState(false)
  const [openedMakeApp, setOpenedMakeApp] = useState(false)
  // Output-first: live activity is the evidence the agent is working, so it leads
  // instead of an Overview that mostly restates the head/sidebar chrome.
  const [tab, setTab] = useState<'overview' | 'chat' | 'output' | 'sessions' | 'todo' | 'config'>('output')
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'attention'>('all')
  const [sortBy, setSortBy] = useState<'folder' | 'name' | 'status' | 'provider'>('folder')
  const [groupByFolder, setGroupByFolder] = useState(true)
  const [creating, setCreating] = useState(false)
  // Sidebar quick-add: create a new agent inside a specific folder group, with the
  // provider + office preselected from that folder's existing agents.
  const [quickAdd, setQuickAdd] = useState<{ parent: string; provider?: string; officeSlug?: string } | null>(null)
  const [initPath, setInitPath] = useState<string | null>(null)    // "Add existing folder" chose an un-initialized folder → offer to init it here
  const [nudgePath, setNudgePath] = useState<string | null>(null)  // just-created agent: nudge the first task
  const [connectFor, setConnectFor] = useState<string | null>(null)
  const [connectOfficeFor, setConnectOfficeFor] = useState<AgentState[] | null>(null)  // "Connect to office" modal targets (single or bulk)
  const [removeFor, setRemoveFor] = useState<AgentState[] | null>(null)                // remove-with-options modal targets (single or bulk)
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)
  const [cliMissing, setCliMissing] = useState(false)
  const [ioBusy, setIoBusy] = useState(false)              // export/import in flight (long zips outlive the toast)
  const [stopping, setStopping] = useState<Set<string>>(new Set())  // agents mid-shutdown
  const [restarting, setRestarting] = useState<Set<string>>(new Set())  // agents mid-restart (stop→start)
  const [checked, setChecked] = useState<Set<string>>(new Set())    // multi-select for bulk actions
  const [bulkBusy, setBulkBusy] = useState<'start' | 'stop' | 'restart' | null>(null)  // bulk op in flight — disables the bar + spins the active button
  const logsRef = useRef<Map<string, string>>(new Map())
  // Log lines arrive at HIGH frequency — every running agent streams a chunk on each
  // stdout/stderr `data` event (7 loops in an office = many per second). Forcing a
  // whole-App re-render on each one used to reconcile the controlled composer/search
  // inputs mid-keystroke, silently dropping the character being typed — so the "Add a
  // task" box felt untypeable whenever agents were actively streaming (and mysteriously
  // worked once they went quiet). Instead of a top-level tick, notify ONLY the mounted
  // Output pane through this subscription, so the log storm never re-renders the inputs.
  const logListeners = useRef<Set<() => void>>(new Set())
  const subscribeLog = useCallback((cb: () => void) => {
    logListeners.current.add(cb)
    return () => { logListeners.current.delete(cb) }
  }, [])

  const refresh = useCallback(async () => {
    const list = await window.api.listAgents()
    setAgents(list)
    setSelected((s) => s ?? (list[0]?.path ?? null))
  }, [])

  useEffect(() => { refresh() }, [refresh])
  const recheckCli = useCallback(async () => { const c = await window.api.cliCheck(); setCliMissing(!c.found) }, [])
  useEffect(() => { recheckCli() }, [recheckCli])

  // Safety-net poll: file-watch pushes most updates, but a periodic refresh keeps
  // task counts / running state correct even if a watch event is missed.
  useEffect(() => {
    const id = setInterval(() => { window.api.listAgents().then(setAgents) }, 5000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const offUpd = window.api.onAgentUpdated((s: AgentState) =>
      setAgents((prev) => prev.map((a) => (a.path === s.path ? s : a))))
    const offChg = window.api.onAgentsChanged(() => refresh())
    const offLog = window.api.onAgentLog(({ path, line }) => {
      const cur = logsRef.current.get(path) ?? ''
      logsRef.current.set(path, (cur + line).slice(-20000))
      // Re-render only the Output pane (if mounted), never the whole App — see the
      // logListeners note above. Keeps typing in the composer/search uninterrupted.
      logListeners.current.forEach((cb) => cb())
    })
    return () => { offUpd(); offChg(); offLog() }
  }, [refresh])

  const showToast = (msg: string, err = false) => { setToast({ msg, err }); setTimeout(() => setToast(null), 4000) }
  const current = useMemo(() => agents.find((a) => a.path === selected) ?? null, [agents, selected])
  const runningCount = useMemo(() => agents.filter((a) => a.running).length, [agents])
  const attentionCount = useMemo(() => agents.filter((a) => ATTENTION_STATES.has(a.activity)).length, [agents])

  // Selecting an agent must also close whichever heavy view (Office/Sessions/
  // Make-app) is up — otherwise the click highlights the row but the main area
  // keeps showing the other view: a visible selection change with no result.
  const selectAgent = useCallback((path: string) => {
    setSelected(path); setShowOffice(false); setShowSessions(false); setShowMakeApp(false); setShowSettings(false)
  }, [])

  // Top-nav: which of the major surfaces is shown. 'agents' is the default
  // workspace (sidebar list + agent detail); the others are the heavy views.
  // Settings holds no PTY/terminal, so unlike the heavy views it isn't kept
  // mounted — it renders directly when active.
  const activeView = showMakeApp ? 'makeapp' : showOffice ? 'office' : showSessions ? 'sessions' : showSettings ? 'settings' : 'agents'
  const showView = (v: 'agents' | 'makeapp' | 'office' | 'sessions' | 'settings'): void => {
    setShowMakeApp(v === 'makeapp'); setShowOffice(v === 'office'); setShowSessions(v === 'sessions'); setShowSettings(v === 'settings')
    if (v === 'makeapp') setOpenedMakeApp(true)
    if (v === 'office') setOpenedOffice(true)
    if (v === 'sessions') setOpenedSessions(true)
  }

  // The list, filtered by search + status, with the agents that need attention
  // floated to the top (then running, then alphabetical) so trouble is never
  // buried at the bottom of a long fleet.
  const visibleAgents = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const rank = (a: AgentState) => (ATTENTION_STATES.has(a.activity) ? 0 : a.running ? 1 : 2)
    // Within-group ordering per the chosen Sort. Folder-sort orders by name inside
    // each folder; the folder itself is the primary key when sorting/grouping by folder.
    const within = (a: AgentState, b: AgentState): number =>
      sortBy === 'name' ? a.name.localeCompare(b.name)
        : sortBy === 'provider' ? (a.provider ?? '').localeCompare(b.provider ?? '') || a.name.localeCompare(b.name)
          : sortBy === 'status' ? rank(a) - rank(b) || a.name.localeCompare(b.name)
            : a.name.localeCompare(b.name)
    // Grouping (or an explicit folder sort) makes the containing folder the primary
    // key, so agents in the same folder are always contiguous — required for the
    // group headers, and what the user asked for (sort by folder/subfolder).
    const folderFirst = groupByFolder || sortBy === 'folder'
    return agents
      .filter((a) =>
        (!q || a.name.toLowerCase().includes(q) || (a.provider ?? '').toLowerCase().includes(q)
          || shortPath(a.path).toLowerCase().includes(q)) &&
        (statusFilter === 'all' ||
          (statusFilter === 'running' && a.running) ||
          (statusFilter === 'attention' && ATTENTION_STATES.has(a.activity))))
      .sort((a, b) => folderFirst
        ? (parentDir(a.path).localeCompare(parentDir(b.path)) || within(a, b))
        : within(a, b))
  }, [agents, filter, statusFilter, sortBy, groupByFolder])

  // Agent count per containing folder, for the group headers (over the visible set
  // so it respects the active search/status filter).
  const folderCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of visibleAgents) { const d = parentDir(a.path); m.set(d, (m.get(d) ?? 0) + 1) }
    return m
  }, [visibleAgents])

  const addExisting = async () => {
    const path = await window.api.pickFolder()
    if (!path) return
    const r = await window.api.addAgent(path)
    // A folder that isn't an AutoDev workspace yet used to dead-end on an error
    // toast ("Not an AutoDev workspace…"). Instead, offer to initialize it in
    // place: open the same Create/init dialog, pre-seeded with the chosen folder,
    // so the user picks a provider and we run `autodev init` there (or cancels,
    // no error). A TODO.md-only folder still adds directly (add() accepts it).
    if ((r as any).error) { setInitPath(path); return }
    await refresh(); setSelected(path)
  }

  const start = async (a: AgentState) => {
    const r = await window.api.startAgent(a.path)
    if ((r as any).error) showToast((r as any).error, true)
    // A loop (ours from a prior session, or an external `autodev start`) already
    // owns this workspace — the manager refuses to spawn a duplicate. Say so
    // instead of silently doing nothing, and refresh so it shows as running.
    else if ((r as any).alreadyRunning) { showToast(`${a.name} is already running`); await refresh() }
    else { logsRef.current.set(a.path, ''); setTab('output') }
  }
  const stop = async (a: AgentState) => { setStopping((s) => new Set(s).add(a.path)); await window.api.stopAgent(a.path) }
  // Clear the "stopping" flag once the child has actually exited (running flips
  // false on the next poll / watch tick), so the button doesn't stick on "Stopping…".
  useEffect(() => {
    setStopping((prev) => {
      if (!prev.size) return prev
      const next = new Set([...prev].filter((p) => agents.find((a) => a.path === p)?.running))
      return next.size === prev.size ? prev : next
    })
  }, [agents])
  // Stop-then-start, for applying config/MCP changes in one click on a running
  // agent (and recovering a crashed/stalled one).
  const restart = async (a: AgentState) => {
    if (restarting.has(a.path)) return
    setRestarting((s) => new Set(s).add(a.path))
    try {
      if (a.running) { await window.api.stopAgent(a.path); await new Promise((r) => setTimeout(r, 800)) }
      logsRef.current.set(a.path, '')
      const r = await window.api.startAgent(a.path)
      if ((r as any).error) showToast((r as any).error, true)
      else { selectAgent(a.path); setTab('output') }
    } finally {
      setRestarting((s) => { const n = new Set(s); n.delete(a.path); return n })
    }
  }

  // Fleet-wide lifecycle — the most frequent daily action, previously one agent
  // at a time. Bulk start does NOT yank you to a single agent's Output tab.
  const startAll = async () => {
    const stopped = agents.filter((a) => !a.running)
    if (!stopped.length) return showToast('All agents are already running')
    showToast(`Starting ${stopped.length} agent${stopped.length === 1 ? '' : 's'}…`)
    for (const a of stopped) await window.api.startAgent(a.path)
    refresh()
  }
  const stopAll = async () => {
    const running = agents.filter((a) => a.running)
    if (!running.length) return showToast('No agents are running')
    // Stopping is non-destructive (you can start again), so don't gate it behind
    // a confirm — the sandboxed renderer's window.confirm can silently return
    // false and no-op the whole action, which is exactly the "clicked Stop but
    // nothing stops" bug.
    showToast(`Stopping ${running.length}…`)
    for (const a of running) await window.api.stopAgent(a.path)
    refresh()
  }

  const toggleChecked = (path: string) => setChecked((s) => { const n = new Set(s); n.has(path) ? n.delete(path) : n.add(path); return n })

  // Select/deselect every (visible) agent in a folder group at once — for the
  // group header's select-all box. Operates over visibleAgents so it respects the
  // active search/status filter. If all are already selected, it clears them.
  const groupPaths = (dir: string): string[] => visibleAgents.filter((a) => parentDir(a.path) === dir).map((a) => a.path)
  const toggleGroup = (dir: string): void => setChecked((s) => {
    const n = new Set(s); const ps = groupPaths(dir)
    if (ps.every((p) => n.has(p))) ps.forEach((p) => n.delete(p)); else ps.forEach((p) => n.add(p))
    return n
  })
  // Drop checks for agents that no longer exist (removed/filtered out of registry).
  useEffect(() => {
    setChecked((prev) => {
      if (!prev.size) return prev
      const next = new Set([...prev].filter((p) => agents.some((a) => a.path === p)))
      return next.size === prev.size ? prev : next
    })
  }, [agents])
  // Bulk lifecycle over the checked subset — the "restart these 4 opencode agents"
  // case that Start-all / Stop-all can't target.
  // Non-destructive bulk lifecycle ops. Remove is destructive and routes through
  // RemoveModal (delete-with-options) instead of here.
  const bulk = async (kind: 'start' | 'stop' | 'restart') => {
    const paths = [...checked]
    // Ignore re-clicks while a bulk op is already running (feedback-at-button:
    // bulkBusy disables the bar, but guard here too against a stray dispatch).
    if (!paths.length || bulkBusy) return
    setBulkBusy(kind)
    try {
      for (const p of paths) {
        const a = agents.find((x) => x.path === p)
        if (!a) continue
        if (kind === 'start' && !a.running) await window.api.startAgent(p)
        else if (kind === 'stop' && a.running) await window.api.stopAgent(p)
        else if (kind === 'restart') { if (a.running) { await window.api.stopAgent(p); await new Promise((r) => setTimeout(r, 600)) } await window.api.startAgent(p) }
      }
      setChecked(new Set())
      refresh()
    } finally {
      setBulkBusy(null)
    }
  }

  // Power-operator keyboard shortcuts: j/k (or ↑/↓) move selection, s toggles
  // start/stop, r restarts, c creates. Ignored while typing or a modal is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey || creating || connectFor || cliMissing) return
      const list = visibleAgents
      if ((e.key === 'j' || e.key === 'ArrowDown') && list.length) {
        e.preventDefault(); const i = list.findIndex((a) => a.path === selected); selectAgent(list[Math.min(list.length - 1, i + 1)].path)
      } else if ((e.key === 'k' || e.key === 'ArrowUp') && list.length) {
        e.preventDefault(); const i = list.findIndex((a) => a.path === selected); selectAgent(list[Math.max(0, (i < 0 ? 0 : i) - 1)].path)
      } else if (e.key === 's' && current) {
        e.preventDefault(); if (current.running) stop(current); else start(current)
      } else if (e.key === 'r' && current?.running) {
        e.preventDefault(); restart(current)
      } else if (e.key === 'c') {
        e.preventDefault(); setCreating(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visibleAgents, selected, current, creating, connectFor, cliMissing, selectAgent])

  const exportAgent = async (a: AgentState) => {
    if (ioBusy) return
    const out = await window.api.saveFile(`${a.name.replace(/[^\w.-]+/g, '_')}.zip`)
    if (!out) return
    setIoBusy(true); showToast('Exporting…')
    const r = await window.api.runCli(['export', a.path, '--output', out])
    setIoBusy(false)
    if (r.code !== 0) showToast(r.stderr || 'Export failed', true)
    else showToast(`Exported → ${out}`)
  }

  // Provider-aware trace export (TraceX): grok agents emit their native session
  // trace tarball (`grok trace`); every other provider reuses the backup export,
  // which already bundles that provider's captured session trace.
  const exportTrace = async (a: AgentState) => {
    if (ioBusy) return
    const isGrok = (a.provider ?? '').startsWith('grok')
    const base = a.name.replace(/[^\w.-]+/g, '_')
    const out = await window.api.saveFile(isGrok ? `${base}-trace.tar.gz` : `${base}-trace.zip`)
    if (!out) return
    setIoBusy(true); showToast('Exporting trace…')
    const r = await window.api.exportTrace(a.path, out)
    setIoBusy(false)
    if ('error' in r) return showToast(r.error, true)
    showToast(`Trace exported → ${r.output}${r.note ? ' — ' + r.note : ''}`)
  }

  const importAgent = async () => {
    if (ioBusy) return
    const zip = await window.api.pickFile([{ name: 'Agent backup', extensions: ['zip'] }])
    if (!zip) return
    const dest = await window.api.pickFolder()
    if (!dest) return
    setIoBusy(true); showToast('Importing…')
    const r = await window.api.runCli(['import', zip, dest])
    if (r.code !== 0) { setIoBusy(false); return showToast(r.stderr || 'Import failed', true) }
    const added = await window.api.addAgent(dest)
    setIoBusy(false)
    if ((added as any)?.error) return showToast((added as any).error, true)
    await refresh(); setSelected(dest); showToast('Imported')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {cliMissing && (
        <div style={{ background: '#3d1c1c', borderBottom: '1px solid var(--red)', color: '#ffb4b0', padding: '8px 16px', fontSize: 12, flex: '0 0 auto' }}>
          ⚠ The <code>autodev</code> CLI isn't installed — agents can't run until it is. See the setup steps in the main panel.
        </div>
      )}
      {/* Top-level nav — the four major surfaces live here, separated from the
          agent-creation controls so navigation no longer reads as "create". */}
      <div className="topbar">
        <div className="brand"><span className="logo">◆</span> AutoDev</div>
        <nav className="topnav" role="tablist" aria-label="Main views">
          {([['agents', '🖥', 'Agents'], ['makeapp', '🐣', 'Spawn agents'], ['office', '☁', 'Pixel Office'], ['sessions', '🗂', 'Sessions'], ['settings', '⚙', 'Settings']] as const).map(([v, ico, label]) => (
            <button key={v} role="tab" aria-selected={activeView === v} className={'topnav-item' + (activeView === v ? ' active' : '')}
              onClick={() => showView(v)} title={label}>{ico} {label}</button>
          ))}
        </nav>
        <div className="spacer" />
        {runningCount > 0 && <span className="badge">{runningCount} running</span>}
        {attentionCount > 0 && <span className="attn-chip" title="Agents needing attention — click to filter"
          onClick={() => { showView('agents'); setStatusFilter((f) => (f === 'attention' ? 'all' : 'attention')) }}>⚠ {attentionCount}</span>}
      </div>
      <div className="app" style={{ flex: 1, minHeight: 0 }}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1>Agents{agents.length > 0 && <span className="badge" style={{ marginLeft: 8 }}>{agents.length}</span>}</h1>
        </div>
        {agents.length > 0 && (
          <div className="fleet-actions">
            <button className="start" onClick={startAll} disabled={cliMissing || runningCount === agents.length} title="Start every stopped agent">▶ Start all</button>
            <button className="danger" onClick={stopAll} disabled={runningCount === 0} title="Stop every running agent">■ Stop all</button>
          </div>
        )}
        {agents.length >= 4 && (
          <div className="list-filter">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search agents by name or provider" placeholder="Search agents…" />
            <div className="filter-chips" role="group" aria-label="Filter by status">
              {(['all', 'running', 'attention'] as const).map((f) => (
                <button key={f} className={statusFilter === f ? 'on' : ''} aria-pressed={statusFilter === f}
                  onClick={() => setStatusFilter(f)}>
                  {f === 'all' ? 'All' : f === 'running' ? 'Running' : 'Attention'}
                  <span className="n">{f === 'all' ? agents.length : f === 'running' ? runningCount : attentionCount}</span>
                </button>
              ))}
            </div>
            <div className="list-sort" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                Sort
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} aria-label="Sort agents by"
                  style={{ fontSize: 12, padding: '3px 6px', width: 'auto' }}>
                  <option value="folder">Folder</option>
                  <option value="name">Name</option>
                  <option value="status">Status</option>
                  <option value="provider">Provider</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
                title="Group agents under their containing folder">
                <input type="checkbox" checked={groupByFolder} onChange={(e) => setGroupByFolder(e.target.checked)} />
                Group by folder
              </label>
            </div>
          </div>
        )}
        {checked.size > 0 && (
          <div className="bulk-bar" role="toolbar" aria-label="Bulk actions for selected agents" aria-busy={!!bulkBusy}>
            <strong>{checked.size} selected</strong>
            <div className="spacer" />
            {/* Feedback-at-button: while a bulk op runs the whole bar disables and the
                active action shows a "…" so it can't be double-fired and isn't silent. */}
            <button title="Start selected" aria-label="Start selected" disabled={!!bulkBusy} onClick={() => bulk('start')}>{bulkBusy === 'start' ? '…' : '▶'}</button>
            <button className="danger" title="Stop selected" aria-label="Stop selected" disabled={!!bulkBusy} onClick={() => bulk('stop')}>{bulkBusy === 'stop' ? '…' : '■'}</button>
            <button title="Restart selected" aria-label="Restart selected" disabled={!!bulkBusy} onClick={() => bulk('restart')}>{bulkBusy === 'restart' ? '…' : '↻'}</button>
            <button title="Connect selected to office" aria-label="Connect selected to office" disabled={!!bulkBusy} onClick={() => { const t = agents.filter((a) => checked.has(a.path)); if (t.length) setConnectOfficeFor(t) }}>☁</button>
            <button className="danger" title="Remove selected from list" aria-label="Remove selected from list" disabled={!!bulkBusy} onClick={() => { const t = agents.filter((a) => checked.has(a.path)); if (t.length) setRemoveFor(t) }}>🗑</button>
            <button title="Clear selection" aria-label="Clear selection" disabled={!!bulkBusy} onClick={() => setChecked(new Set())}>✕</button>
          </div>
        )}
        <div className="agent-list">
          {agents.length === 0 && <div className="empty" style={{ padding: 24, fontSize: 12 }}>No agents yet.<br />Create or add one.</div>}
          {agents.length > 0 && visibleAgents.length === 0 && <div className="no-match">No agents match.</div>}
          {visibleAgents.map((a, i) => {
            // With "Group by folder" on, print a sticky folder header before the
            // first agent of each folder (visibleAgents is sorted folder-first, so
            // same-folder rows are contiguous). The per-row folder line is then
            // redundant, so it's shown only when NOT grouped.
            const dir = parentDir(a.path)
            const showHead = groupByFolder && (i === 0 || parentDir(visibleAgents[i - 1].path) !== dir)
            return (
            <Fragment key={a.path}>
              {showHead && (() => {
                const ps = groupPaths(dir)
                const sel = ps.filter((p) => checked.has(p)).length
                const allSel = sel > 0 && sel === ps.length
                return (
                <div className="folder-group-head" title={dir}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px 4px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 1 }}>
                  <input type="checkbox" className="group-check" checked={allSel}
                    ref={(el) => { if (el) el.indeterminate = sel > 0 && !allSel }}
                    onChange={() => toggleGroup(dir)}
                    title={allSel ? `Deselect all in ${folderLabel(dir)}` : `Select all ${ps.length} in ${folderLabel(dir)}`}
                    aria-label={`Select all agents in ${folderLabel(dir)}`} />
                  📁 {folderLabel(dir)} <span className="n" style={{ opacity: .65, fontWeight: 600 }}>{sel ? `${sel}/${ps.length}` : ps.length}</span>
                  <button className="group-add" style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 4px', borderRadius: 5 }}
                    title={`Add an agent in ${folderLabel(dir)}`} aria-label={`Add an agent in ${folderLabel(dir)}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      const sibs = agents.filter((x) => parentDir(x.path) === dir)
                      setQuickAdd({ parent: dir, provider: sibs.find((x) => x.provider)?.provider, officeSlug: sibs.find((x) => x.officeSlug)?.officeSlug })
                    }}>＋</button>
                </div>
                )
              })()}
              <div role="button" tabIndex={0} aria-pressed={a.path === selected}
                className={'agent-row' + (a.path === selected ? ' active' : '') + (checked.has(a.path) ? ' checked' : '')}
                onClick={() => selectAgent(a.path)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAgent(a.path) } }}>
                <input type="checkbox" className="row-check" checked={checked.has(a.path)} aria-label={`Select ${a.name} for bulk actions`}
                  onClick={(e) => e.stopPropagation()} onChange={() => toggleChecked(a.path)} />
                <span className={'dot ' + a.activity} title={a.error || ACTIVITY_LABEL[a.activity]} />
                <div className="meta">
                  <div className="name">{a.name}{ATTENTION_STATES.has(a.activity) && <span className="attn-tag" title={a.error || ACTIVITY_LABEL[a.activity]}>{a.activity === 'needs-auth' ? '🔑' : a.activity === 'rate-limited' ? '⏳' : '⚠'}</span>}{a.wsUrl && <span className={'office-chip' + (a.online ? ' online' : ' offline')} title={a.online ? 'Online in the office' : 'Bound to an office — currently offline'}>● office</span>}</div>
                  <div className="sub" title={a.running && a.currentTask ? a.currentTask : undefined}>{a.provider ?? 'no provider'} · {ATTENTION_STATES.has(a.activity) ? ACTIVITY_LABEL[a.activity] : a.running && a.currentTask ? a.currentTask : `${a.tasks.remaining} left`}</div>
                  {!groupByFolder && <div className="sub folder" title={a.path} style={{ opacity: .7, fontSize: 11 }}>📁 {shortPath(a.path)}</div>}
                </div>
              </div>
            </Fragment>
            )
          })}
        </div>
        {/* One consolidated entry point for getting an agent into the list —
            create / add existing / import — instead of three scattered controls. */}
        <div className="sidebar-foot">
          <OverflowMenu full up trigger="＋ New agent" triggerClass="primary" triggerLabel="Add an agent"
            triggerDisabled={cliMissing}
            items={[
              { label: '＋ Create new agent', onClick: () => setCreating(true) },
              { label: '📁 Add existing folder', onClick: addExisting },
              { label: '⬆ Import from backup', onClick: importAgent }
            ]} />
        </div>
      </aside>

      <main className="main">
        {/* Heavy views stay mounted once opened (see openedX above) and only hide via
            `display`, so a live Operate/Resume terminal survives tab switches. */}
        {openedMakeApp && <div style={{ display: showMakeApp ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}><MakeAppView /></div>}
        {openedOffice && <div style={{ display: showOffice ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}><PixelOfficeView visible={showOffice} /></div>}
        {openedSessions && <div style={{ display: showSessions ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}><SessionsBrowser visible={showSessions} /></div>}
        {/* Settings is lightweight (no PTY) — rendered directly when active, not kept mounted. */}
        {showSettings && <SettingsView showToast={showToast} />}
        {!showMakeApp && !showOffice && !showSessions && !showSettings && cliMissing && <CliSetup onRecheck={recheckCli} />}
        {!showMakeApp && !showOffice && !showSessions && !showSettings && !cliMissing && !current && (
          agents.length === 0 ? (
            <div className="welcome">
              <div className="mark">◆</div>
              <h2>Welcome to AutoDev</h2>
              <p>Run AI coding agents on your own machine and steer a team of them. Start by creating your first agent, or connect to a remote Pixel Office.</p>
              <div className="ctas">
                <button className="cta primary" onClick={() => setCreating(true)}>
                  <span className="ico">＋</span><span>Create your first agent<span className="sub">Pick a folder and a provider — you'll add tasks after</span></span>
                </button>
                <button className="cta" onClick={addExisting}>
                  <span className="ico">📁</span><span>Add an existing workspace<span className="sub">Already have an AutoDev folder? Point at it</span></span>
                </button>
                <button className="cta" onClick={() => { setShowMakeApp(true); setOpenedMakeApp(true) }}>
                  <span className="ico">🐣</span><span>Spawn agents<span className="sub">Describe an idea, generate a team, tweak & spawn them</span></span>
                </button>
                <button className="cta" onClick={() => { setShowOffice(true); setOpenedOffice(true) }}>
                  <span className="ico">☁</span><span>Connect a Pixel Office<span className="sub">Operate your remote office characters</span></span>
                </button>
              </div>
            </div>
          ) : <div className="empty">Select an agent</div>
        )}
        {!showMakeApp && !showOffice && !showSessions && !showSettings && !cliMissing && current && (
          <>
            <div className="detail-head">
              <span className={'dot ' + current.activity} />
              <div className="head-id">
                <h2>{current.name}</h2>
                <div className="path" title={current.path}>{current.path}</div>
              </div>
              <span className="badge">{current.provider ?? '—'}</span>
              {/* Bound state: a GREEN pill (not a passive grey badge) that opens a
                  small menu to change the binding or disconnect. */}
              {current.wsUrl && (
                <OverflowMenu trigger={<>● office{current.online ? '' : ' (offline)'}</>} triggerClass={'office-pill' + (current.online ? '' : ' offline')} triggerLabel={current.online ? 'Online in the office — change or disconnect' : 'Bound to office (offline) — change or disconnect'}
                  items={[
                    { label: '☁ Change binding', onClick: () => setConnectFor(current.path) },
                    { label: '⏻ Disconnect', danger: true, sep: true, onClick: () => showToast('Disconnecting a bound agent isn’t wired yet — use “Change binding” to rebind it for now.', true) }
                  ]} />
              )}
              <span className={'status-pill ' + current.activity} title={current.error || ACTIVITY_LABEL[current.activity]}>{ACTIVITY_LABEL[current.activity]}</span>
              {current.external && <span className="status-pill external" title="Running via a loop this app didn’t start (external CLI or a remote VM). The app won’t start a duplicate.">external</span>}
              <div className="spacer" />
              {current.running
                ? <button className="danger" disabled={stopping.has(current.path)} onClick={() => stop(current)}>{stopping.has(current.path) ? 'Stopping…' : '■ Stop'}</button>
                : <button className="start" onClick={() => start(current)}>▶ Start</button>}
              {current.running && <button title="Restart (stop then start) — applies Config / MCP changes" disabled={restarting.has(current.path)} onClick={() => restart(current)}>{restarting.has(current.path) ? '↻ Restarting…' : '↻ Restart'}</button>}
              <button title="Open workspace folder" onClick={() => window.api.openPath(current.path)}>📁 Open</button>
              {/* Connecting a local agent to an office is the app's core flow — promote
                  it to a first-class accent button (only while unbound; a bound agent
                  shows the green office pill instead). */}
              {!current.wsUrl && <button className="primary" title="Link this agent to a character in your pixel office" onClick={() => setConnectFor(current.path)}>☁ {CONNECT_LABEL}</button>}
              <OverflowMenu items={[
                { label: ioBusy ? '⬇ Exporting…' : '⬇ Export backup', onClick: () => { if (!ioBusy) exportAgent(current) } },
                { label: ioBusy ? '🧵 Exporting…' : '🧵 Export trace (TraceX)', onClick: () => { if (!ioBusy) exportTrace(current) } },
                { label: '☁ Connect to office', sep: true, onClick: () => setConnectOfficeFor([current]) },
                { label: '🗑 Remove…', danger: true, onClick: () => setRemoveFor([current]) }
              ]} />
            </div>

            {ATTENTION_STATES.has(current.activity) && current.error && (
              <div className={'attention-banner ' + current.activity} role="alert">
                <span className="attention-icon" aria-hidden="true">{current.activity === 'needs-auth' ? '🔑' : current.activity === 'rate-limited' ? '⏳' : '⚠'}</span>
                <div className="attention-text">
                  <strong>{ACTIVITY_LABEL[current.activity]}</strong> — {current.error}
                  {current.activity === 'needs-auth' && <span className="attention-hint"> Re-authenticate <b>{current.provider ?? 'the provider'}</b> for this workspace: open a terminal in the folder and run its login (e.g. <code>{loginCommandFor(current.provider)}</code>). The loop resumes on its own once the login succeeds.</span>}
                </div>
                {current.activity === 'needs-auth' && (
                  <button className="start" title="Open the workspace folder so you can run the provider login in a terminal" onClick={() => window.api.openPath(current.path)}>📁 Open workspace</button>
                )}
                {(current.activity === 'crashed' || current.activity === 'stalled') && (
                  <button className="start" disabled={restarting.has(current.path)} onClick={() => restart(current)}>{restarting.has(current.path) ? '↻ Restarting…' : '↻ Restart'}</button>
                )}
              </div>
            )}

            <div className="tabs" role="tablist"
              onKeyDown={(e) => {
                // Roving-tabindex tablist needs arrow-key nav (WAI-ARIA): move both
                // selection AND focus, else the inactive tabIndex=-1 tabs are
                // unreachable by keyboard.
                const tabs = ['overview', 'chat', 'output', 'sessions', 'todo', 'config'] as const
                const i = tabs.indexOf(tab)
                let ni = i
                if (e.key === 'ArrowRight') ni = (i + 1) % tabs.length
                else if (e.key === 'ArrowLeft') ni = (i - 1 + tabs.length) % tabs.length
                else if (e.key === 'Home') ni = 0
                else if (e.key === 'End') ni = tabs.length - 1
                else return
                e.preventDefault()
                setTab(tabs[ni])
                ;(e.currentTarget.children[ni] as HTMLElement | undefined)?.focus()
              }}>
              {(['overview', 'chat', 'output', 'sessions', 'todo', 'config'] as const).map((t) => (
                <div key={t} role="tab" aria-selected={tab === t} tabIndex={tab === t ? 0 : -1}
                  className={'tab' + (tab === t ? ' active' : '')}
                  title={t === 'sessions' ? 'Resume a past provider session for this workspace'
                    : t === 'chat' ? "This agent's live office conversation — read and message it" : undefined}
                  onClick={() => setTab(t)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>
                  {t === 'sessions' ? 'Resume' : t[0].toUpperCase() + t.slice(1)}
                </div>
              ))}
            </div>

            <div className="panel">
              {tab === 'overview' && <Overview a={current} />}
              {tab === 'chat' && <ChatTab key={current.path} agent={current} showToast={showToast} />}
              {tab === 'output' && <Output getText={() => logsRef.current.get(current.path) || current.lastOutput || 'No output yet. Start the agent.'} subscribe={subscribeLog} />}
              {tab === 'sessions' && <SessionsTab path={current.path} provider={current.provider} showToast={showToast} />}
              {tab === 'todo' && <TodoTab path={current.path} />}
              {tab === 'config' && <Config a={current} onSaved={refresh} showToast={showToast} />}
            </div>

            {/* The Chat tab has its own live-steer composer, so the task-queue bar
                would be a confusing second input there — hide it on that tab only. */}
            {tab !== 'chat' && (
              <MessageBar key={current.path} path={current.path} running={current.running} showToast={showToast}
                nudge={nudgePath === current.path && current.tasks.total === 0} onSent={() => setNudgePath(null)} />
            )}
          </>
        )}
      </main>

      {creating && <CreateModal onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); setNudgePath(p); refresh().then(() => selectAgent(p)) }} showToast={showToast} />}
      {quickAdd && <CreateModal defaultParent={quickAdd.parent} defaultProvider={quickAdd.provider} defaultOfficeSlug={quickAdd.officeSlug}
        onClose={() => setQuickAdd(null)} onCreated={(p) => { setQuickAdd(null); setNudgePath(p); refresh().then(() => selectAgent(p)) }} showToast={showToast} />}
      {initPath && <CreateModal initialPath={initPath} initMode onClose={() => setInitPath(null)} onCreated={(p) => { setInitPath(null); setNudgePath(p); refresh().then(() => selectAgent(p)) }} showToast={showToast} />}
      {connectFor && <ConnectModal path={connectFor} agent={agents.find((a) => a.path === connectFor)} onClose={() => setConnectFor(null)} onDone={() => { setConnectFor(null); refresh() }} showToast={showToast} />}
      {connectOfficeFor && <ConnectOfficeModal targets={connectOfficeFor} onClose={() => setConnectOfficeFor(null)} onDone={() => { setConnectOfficeFor(null); setChecked(new Set()); refresh() }} showToast={showToast} />}
      {removeFor && <RemoveModal targets={removeFor} onClose={() => setRemoveFor(null)} onDone={() => { const removed = removeFor.map((a) => a.path); setRemoveFor(null); setChecked(new Set()); if (selected && removed.includes(selected)) setSelected(null); refresh() }} showToast={showToast} />}
      {/* Persistent live regions (always in DOM) so screen readers announce
          status/error changes; polite for info, assertive for errors. */}
      <div aria-live="polite" aria-atomic="true" role="status" style={srOnly}>{toast && !toast.err ? toast.msg : ''}</div>
      <div aria-live="assertive" aria-atomic="true" role="alert" style={srOnly}>{toast && toast.err ? toast.msg : ''}</div>
      {toast && <div className={'toast' + (toast.err ? ' err' : '')} aria-hidden="true">{toast.msg}</div>}
      </div>
    </div>
  )
}

// Persistent composer at the bottom of the agent detail — sends a message/task
// to the agent (appended to its TODO.md; the loop picks it up).
// One normalized row of an office character's conversation (mirrors the main
// process's OfficeMessage). role drives the bubble side/accent; kind refines it.
interface ChatMessage { id: string; role: 'user' | 'assistant' | 'a2a' | 'system'; author: string; text: string; kind: string; at: number }
type ChatResult = { ok: true; agentId: string; agentName: string; messages: ChatMessage[] } | { error: string }

function fmtChatTime(ms: number): string {
  if (!ms) return ''
  try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
}

/**
 * The Chat tab: an office character's live conversation, read + reply, right in
 * the app. The workspace only knows its endpoint/agent slug locally, so the fetch
 * (office:messages) resolves the numeric office-agent id server-side and hands it
 * back — we steer with THAT id. Polls every few seconds so it stays live while the
 * agent works. Local-only agents (no office link) get a hint, not a crash.
 */
function ChatTab({ agent, showToast }: { agent: AgentState; showToast: (m: string, e?: boolean) => void }): JSX.Element {
  const ref = agent.officeAgentId || agent.officeAgentSlug || ''
  const officeSlug = agent.officeSlug || ''
  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  const [resolvedId, setResolvedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Track whether the user is pinned to the bottom, so a poll refresh only
  // auto-scrolls when they haven't scrolled up to read history.
  const onScroll = (): void => {
    const el = feedRef.current
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  const scrollToBottom = (): void => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  useEffect(() => {
    if (!ref) { setLoading(false); return }
    let alive = true
    const load = async (initial: boolean): Promise<void> => {
      if (initial) setLoading(true)
      const r = (await window.api.officeMessages(officeSlug, ref)) as ChatResult
      if (!alive) return
      if ('error' in r) {
        // Keep any messages already shown on a transient poll error.
        if (initial) setError(r.error)
      } else {
        setError('')
        setResolvedId(r.agentId)
        setMsgs(r.messages)
      }
      if (initial) setLoading(false)
    }
    void load(true)
    const timer = setInterval(() => void load(false), 4000)
    return () => { alive = false; clearInterval(timer) }
  }, [ref, officeSlug])

  // Auto-scroll to the newest row when pinned to the bottom.
  useEffect(() => { if (atBottomRef.current) scrollToBottom() }, [msgs.length])

  const send = async (): Promise<void> => {
    const t = draft.trim()
    if (!t || sending) return
    const targetId = resolvedId || agent.officeAgentId
    if (!targetId) { showToast('Still linking this agent to its office — try again in a moment.', true); return }
    setSending(true)
    const r = (await window.api.officeSteer(targetId, t)) as { ok?: boolean; error?: string }
    setSending(false)
    if (r?.error) { showToast(r.error, true); return }
    setDraft('')
    atBottomRef.current = true
    // Optimistically echo the sent message; the next poll reconciles it with the
    // server's own record (matched away by the dedupe in the feed builder).
    setMsgs((m) => [...m, { id: `local-${Date.now()}`, role: 'user', author: 'You', text: t, kind: 'steer', at: Date.now() }])
    taRef.current?.focus()
  }
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
  }

  // Local-only workspace with no office character — chat needs an office link.
  if (!ref) {
    return (
      <div className="empty" style={{ maxWidth: 420 }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>💬</div>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>No office conversation</div>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          This is a local agent. Connect it to a Pixel Office character
          (“{CONNECT_LABEL}”) to read and message its conversation here.
        </div>
      </div>
    )
  }

  return (
    <div className="chat-tab">
      <div className="chat-feed" ref={feedRef} onScroll={onScroll} role="log" aria-label="Office conversation" aria-live="polite">
        {loading && <div className="chat-status">Loading conversation…</div>}
        {!loading && error && <div className="chat-status err">{error}</div>}
        {!loading && !error && msgs.length === 0 && (
          <div className="chat-status">No messages yet. Say hello below — it steers the agent live.</div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={'chat-row ' + m.role}>
            {m.role === 'system' ? (
              <div className="chat-marker"><span>{m.text}</span><time>{fmtChatTime(m.at)}</time></div>
            ) : (
              <div className="chat-bubble">
                <div className="chat-meta"><span className="chat-author">{m.author}</span><time>{fmtChatTime(m.at)}</time></div>
                <div className="chat-text">{m.text}</div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="chat-composer">
        <textarea
          ref={taRef}
          rows={1}
          value={draft}
          aria-label="Message this office agent (steers it live)"
          placeholder={agent.online ? 'Message the agent…  (Enter to send · Shift+Enter for newline)' : 'Agent is offline — a steer may not be delivered until it reconnects'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
        <button className="primary" disabled={sending || !draft.trim()} onClick={() => void send()}>{sending ? 'Sending…' : '➤ Send'}</button>
      </div>
    </div>
  )
}

function MessageBar({ path, running, showToast, nudge, onSent }: { path: string; running: boolean; showToast: (m: string, e?: boolean) => void; nudge?: boolean; onSent?: () => void }): JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // A brand-new agent has an empty TODO, so Start would do nothing visible — pull
  // the operator straight to the composer so the create → give-it-work path is
  // obvious rather than discovered by accident.
  useEffect(() => { if (nudge) taRef.current?.focus() }, [nudge])
  const send = async (): Promise<void> => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    const r = await window.api.sendAgentMessage(path, t) as { ok?: boolean; error?: string }
    setBusy(false)
    if (r?.error) { showToast(r.error, true); return }
    setText('')
    onSent?.()
    showToast(running ? 'Queued — added to TODO; the agent runs it on its next cycle.' : 'Queued — added to TODO; the agent runs it when you Start it.')
  }
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
  }
  return (
    // NB: this queues a TODO task (not a live chat/steer). The honest labels below
    // set that expectation — a real-time "instant message" lives on the Pixel
    // Office → Operate pane (office characters), via the steer endpoint.
    <>
      {nudge && <div className="composer-hint">👇 This agent has no tasks yet — add its first task to get it working.</div>}
      <div className="msgbar">
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          aria-label="Add a task to this agent's queue"
          placeholder="Add a task to this agent's TODO…  (Enter to add · Shift+Enter for newline)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <button className="primary" disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? 'Adding…' : '＋ Add task'}</button>
      </div>
    </>
  )
}

// Secondary/destructive actions collapsed behind a "⋯" so the primary Start/Stop/
// Restart stand out and the destructive Remove isn't one slot from a benign
// button with identical styling.
function OverflowMenu({ items, trigger = '⋯', triggerClass, triggerLabel = 'More actions', full = false, up = false, triggerDisabled = false }: {
  items: Array<{ label: string; onClick: () => void; danger?: boolean; sep?: boolean }>
  trigger?: React.ReactNode; triggerClass?: string; triggerLabel?: string; full?: boolean; up?: boolean; triggerDisabled?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onEsc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc) }
  }, [open])
  return (
    <div className={'overflow' + (full ? ' full' : '')} ref={ref}>
      <button className={triggerClass} disabled={triggerDisabled} aria-haspopup="menu" aria-expanded={open} aria-label={triggerLabel} title={triggerLabel} onClick={() => setOpen((o) => !o)}>{trigger}</button>
      {open && (
        <div className={'overflow-menu' + (up ? ' up' : '')} role="menu">
          {items.map((it, i) => (
            <button key={i} role="menuitem" className={(it.danger ? 'danger' : '') + (it.sep ? ' sep' : '')}
              onClick={() => { setOpen(false); it.onClick() }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

// Blocking setup screen when the autodev CLI is absent — the app can't create,
// start, or configure agents without it. Plain-language, with a recheck button,
// instead of leaving the feature buttons live to fail one by one.
function CliSetup({ onRecheck }: { onRecheck: () => Promise<void> }): JSX.Element {
  const [checking, setChecking] = useState(false)
  return (
    <div className="welcome">
      <div className="mark">⚙</div>
      <h2>Set up the AutoDev CLI</h2>
      <p>AutoDev runs your agents through the <code>autodev</code> command-line tool, and the app can't find it yet. Install it, then recheck.</p>
      <div style={{ textAlign: 'left', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', fontSize: 12.5, lineHeight: 1.6 }}>
        <div style={{ color: 'var(--fg2)' }}>Install it globally:</div>
        <pre className="todo" style={{ margin: '6px 0 10px' }}>npm install -g autodev-cli</pre>
        <div style={{ color: 'var(--fg2)' }}>…or point <code>AUTODEV_CLI_JS</code> at <code>autodev-cli/bin/autodev.js</code>.</div>
      </div>
      <div className="ctas" style={{ marginTop: 18 }}>
        <button className="cta primary" disabled={checking} onClick={async () => { setChecking(true); await onRecheck(); setChecking(false) }}>
          <span className="ico">↻</span><span>{checking ? 'Checking…' : 'Recheck'}</span>
        </button>
      </div>
    </div>
  )
}

function Overview({ a }: { a: AgentState }): JSX.Element {
  return (
    <>
      <div className="cards">
        <div className="card"><div className="k">Status</div><div className="v"><span className={'dot ' + a.activity} /> {ACTIVITY_LABEL[a.activity]}{typeof a.exitCode === 'number' && a.exitCode !== 0 ? ` (exit ${a.exitCode})` : ''}</div>{a.error && ATTENTION_STATES.has(a.activity) && <div className="card-note">{a.error}</div>}</div>
        <div className="card"><div className="k">Remaining</div><div className="v">{a.tasks.remaining}</div></div>
        <div className="card"><div className="k">Done</div><div className="v">{a.tasks.done}</div></div>
        <div className="card"><div className="k">Total</div><div className="v">{a.tasks.total}</div></div>
      </div>
      {a.currentTask && <><div className="card"><div className="k">{a.running ? 'Working on' : 'Next task'}</div><div style={{ marginTop: 4, lineHeight: 1.4 }}>{a.currentTask}</div></div><div style={{ height: 12 }} /></>}
      {/* Provider is already in the detail-head badge + sidebar sub-line — don't repeat it here. */}
      <div className="card"><div className="k">Session name</div><div style={{ marginTop: 4 }}>{a.sessionName || '(folder name)'}</div></div>
      {a.wsUrl && <><div style={{ height: 12 }} /><div className="card"><div className="k">Pixel-office</div><div style={{ marginTop: 4, wordBreak: 'break-all', fontSize: 11 }}>{a.wsUrl}</div></div></>}
    </>
  )
}

function Output({ getText, subscribe }: { getText: () => string; subscribe: (cb: () => void) => () => void }): JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  // Self-subscribe to the log stream: new lines re-render ONLY this pane, so the
  // parent App — and the composer/search inputs it holds — is never re-rendered by
  // streaming output, and typing is never interrupted. Reads the latest buffer via
  // getText() on each of its own renders.
  const [, force] = useState(0)
  useEffect(() => subscribe(() => force((t) => t + 1)), [subscribe])
  const text = getText()
  // Stick to the bottom on new output ONLY if the user was already at the bottom,
  // so scrolling up to read history isn't yanked back on the next streamed line.
  const stick = useRef(true)
  const onScroll = (): void => {
    const el = ref.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }
  useEffect(() => { if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [text])
  return <pre className="output" ref={ref} onScroll={onScroll}>{text}</pre>
}

interface SessionInfo { provider: string; id: string; name: string; updated: number }
function SessionsTab({ path, provider, showToast }: { path: string; provider?: string; showToast: (m: string, e?: boolean) => void }): JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => {
    setSessions(null); setErr(null)
    // Scope to the agent's configured provider so the list matches the selection
    // (grok agent → grok sessions, opencode → opencode, …). The listing itself
    // lives in the CLI (`autodev sessions --provider`) so it's shared, not duped.
    const args = provider ? ['sessions', path, '--provider', provider, '--json'] : ['sessions', path, '--json']
    window.api.runCli(args).then((r) => {
      // Distinguish a broken query from a genuinely empty one — a failed CLI call
      // must not masquerade as "0 sessions".
      if (r.code !== 0) { setErr(r.stderr || 'Failed to list sessions.'); setSessions([]); return }
      try { setSessions(JSON.parse(r.stdout || '[]')) } catch { setErr('Could not parse the session list from the CLI.'); setSessions([]) }
    })
  }, [path, provider])
  useEffect(() => { load() }, [load])
  if (sessions === null) return <div style={{ color: 'var(--fg2)' }}>Loading sessions…</div>
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <strong>{err ? 'Sessions unavailable' : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}</strong>
        <div className="spacer" />
        <button onClick={load}>↻ Refresh</button>
      </div>
      {err && (
        <div role="alert" style={{ padding: '10px 12px', background: 'rgba(248,81,73,0.08)', border: '1px solid var(--red)', borderRadius: 8, color: '#ffb4b0', fontSize: 12, marginBottom: 12 }}>
          {err}<div style={{ marginTop: 8 }}><button onClick={load}>↻ Retry</button></div>
        </div>
      )}
      {!err && sessions.length === 0 && <div style={{ color: 'var(--fg2)' }}>No inspectable sessions for this workspace yet.</div>}
      {sessions.map((s) => (
        <div className="card" key={s.provider + s.id} style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="badge">{s.provider}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{s.name}</div>
            <div style={{ color: 'var(--fg2)', fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>{s.id}</div>
          </div>
          <div style={{ color: 'var(--fg2)', fontSize: 11 }}>{s.updated ? new Date(s.updated).toLocaleString() : '—'}</div>
          <button title="Resume this session on next start" onClick={async () => {
            const r = await window.api.runCli(['resume', s.id, path, '-p', `${s.provider}-cli`])
            showToast(r.code === 0 ? `Will resume "${s.name}" on next start` : (r.stderr || 'Resume failed'), r.code !== 0)
          }}>▶ Resume</button>
        </div>
      ))}
    </>
  )
}

function TodoTab({ path }: { path: string }): JSX.Element {
  const [text, setText] = useState('Loading…')
  useEffect(() => {
    window.api.runCli(['status', path, '--all']).then((r) => setText((r.stdout || r.stderr || '').replace(/\x1b\[[0-9;]*m/g, '')))
  }, [path])
  return <pre className="todo">{text}</pre>
}

const MODEL_KEY: Record<string, string> = { claude: 'claudeModel', opencode: 'opencodeModel', copilot: 'copilotModel', grok: 'grokModel' }
function modelKeyFor(provider: string): string { return MODEL_KEY[provider.split('-')[0]] ?? 'claudeModel' }

// The interactive login command per provider family — shown in the needs-auth
// banner so the user knows exactly what to run in the workspace terminal.
const LOGIN_CMD: Record<string, string> = { claude: 'claude  (then /login)', grok: 'grok  (sign in when prompted)', copilot: 'copilot  (then /login)', opencode: 'opencode auth login' }
function loginCommandFor(provider?: string): string { return LOGIN_CMD[(provider ?? '').split('-')[0]] ?? 'the provider login' }

interface McpStat {
  name: string; kind: 'remote' | 'stdio'; detail: string; builtin: boolean; enabled: boolean
  status: 'connected' | 'unreachable' | 'ready' | 'missing' | 'disabled'; latencyMs?: number; error?: string
}
const MCP_STATUS_META: Record<McpStat['status'], { dot: string; color: string; label: string }> = {
  connected:   { dot: '●', color: 'var(--ok, #3fb950)',   label: 'connected' },
  ready:       { dot: '●', color: 'var(--ok, #3fb950)',   label: 'ready' },
  unreachable: { dot: '✗', color: 'var(--bad, #f85149)',  label: 'unreachable' },
  missing:     { dot: '✗', color: 'var(--bad, #f85149)',  label: 'missing' },
  disabled:    { dot: '○', color: 'var(--fg2, #8b949e)',  label: 'disabled' }
}
function McpRow({ s }: { s: McpStat }): JSX.Element {
  const m = MCP_STATUS_META[s.status]
  return (
    <li style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 0', fontSize: 12, borderBottom: '1px solid var(--border)' }}>
      <span title={m.label} style={{ color: m.color, fontSize: 13 }}>{m.dot}</span>
      <span style={{ fontWeight: 600 }}>{s.name}</span>
      <span style={{ color: 'var(--fg2)', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px' }}>
        {s.kind}{s.builtin ? ' · builtin' : ''}
      </span>
      <span style={{ color: 'var(--fg2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.detail}>{s.detail}</span>
      <span style={{ color: m.color, whiteSpace: 'nowrap' }}>
        {m.label}{s.latencyMs != null ? ` · ${s.latencyMs}ms` : ''}{s.error && s.status !== 'disabled' ? ` · ${s.error}` : ''}
      </span>
    </li>
  )
}

function Config({ a, onSaved, showToast }: { a: AgentState; onSaved: () => void; showToast: (m: string, e?: boolean) => void }): JSX.Element {
  const [provider, setProvider] = useState(a.provider ?? 'claude-tui')
  const [sessionName, setSessionName] = useState(a.sessionName ?? '')
  const [model, setModel] = useState('')
  const [fileBrowser, setFileBrowser] = useState(false)
  const [busy, setBusy] = useState(false)
  // MCP editor (raw .mcp.json)
  const [mcpText, setMcpText] = useState('')
  const [showMcp, setShowMcp] = useState(false)
  const [mcpBusy, setMcpBusy] = useState(false)
  // MCP live connectivity
  const [mcpStat, setMcpStat] = useState<McpStat[] | null>(null)
  const [mcpStatBusy, setMcpStatBusy] = useState(false)
  const loadMcpStat = useCallback(async (): Promise<void> => {
    setMcpStatBusy(true)
    const r = await window.api.agentMcpStatus(a.path) as { servers?: McpStat[]; error?: string }
    setMcpStatBusy(false)
    setMcpStat(r?.servers ?? [])
  }, [a.path])
  // Probe once when the panel is first opened; reset when switching agents.
  useEffect(() => { setMcpStat(null) }, [a.path])
  useEffect(() => { if (showMcp && mcpStat === null && !mcpStatBusy) void loadMcpStat() }, [showMcp, mcpStat, mcpStatBusy, loadMcpStat])

  // load the current model for the active provider
  useEffect(() => {
    window.api.runCli(['config', 'get', modelKeyFor(provider), a.path]).then((r) => setModel((r.stdout || '').trim()))
  }, [a.path, provider])
  // load file-browser flag + .mcp.json once per agent
  useEffect(() => {
    window.api.runCli(['config', 'get', 'enableFileBrowser', a.path]).then((r) => setFileBrowser((r.stdout || '').trim() === 'true'))
    window.api.readAgentMcp(a.path).then((r: { content?: string }) => { if (r?.content != null) setMcpText(r.content) })
  }, [a.path])

  const save = async (): Promise<void> => {
    setBusy(true)
    // Each key is a separate CLI write; check every exit code so a failed write
    // can't be reported as a green "Saved" (silent loss of intent on a settings
    // screen). Stop at the first failure and surface its stderr.
    const writes: Array<[string, string]> = [['provider', provider]]
    if (sessionName !== (a.sessionName ?? '')) writes.push(['sessionName', sessionName])
    writes.push([modelKeyFor(provider), model], ['enableFileBrowser', fileBrowser ? 'true' : 'false'])
    for (const [k, v] of writes) {
      const r = await window.api.runCli(['config', 'set', k, v, a.path])
      if (r.code !== 0) { setBusy(false); return showToast(r.stderr || `Save failed writing "${k}"`, true) }
    }
    setBusy(false)
    // A running loop won't pick up a new provider/model until it restarts — say so.
    showToast(a.running ? 'Saved — restart the agent to apply' : 'Saved')
    onSaved()
  }
  const saveMcp = async (): Promise<void> => {
    setMcpBusy(true)
    const r = await window.api.writeAgentMcp(a.path, mcpText) as { ok?: boolean; error?: string }
    setMcpBusy(false)
    if (r?.error) { showToast(r.error, true); return }
    showToast(a.running ? 'MCP saved — restart the agent to apply.' : 'MCP saved.')
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <label className="field"><span className="lbl">Provider</span>
        <ProviderSelect value={provider} onChange={setProvider} id="config-provider" />
      </label>
      <label className="field"><span className="lbl">Model ({modelKeyFor(provider)})</span>
        <input value={model} placeholder="(provider default)" onChange={(e) => setModel(e.target.value)} />
      </label>
      <label className="field"><span className="lbl">Session display name</span>
        <input value={sessionName} placeholder="(folder name)" onChange={(e) => setSessionName(e.target.value)} />
      </label>
      <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={fileBrowser} onChange={(e) => setFileBrowser(e.target.checked)} style={{ width: 'auto' }} />
        <span className="lbl" style={{ margin: 0 }}>Enable file browser <span style={{ color: 'var(--fg2)', textTransform: 'none', letterSpacing: 0 }}>— browse & edit this agent's files from the office</span></span>
      </label>
      <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>

      <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        <button aria-expanded={showMcp} aria-controls="mcp-panel" onClick={() => setShowMcp((s) => !s)}>{showMcp ? '▾' : '▸'} MCP servers (.mcp.json)</button>
        {showMcp && (
          <div id="mcp-panel" style={{ marginTop: 10 }}>
            <div style={{ marginBottom: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span className="lbl" style={{ margin: 0 }}>Connectivity</span>
                <button onClick={() => void loadMcpStat()} disabled={mcpStatBusy} title="Re-probe each server (remote: MCP handshake; stdio: runner on PATH)">{mcpStatBusy ? 'Checking…' : '↻ Recheck'}</button>
              </div>
              {mcpStat === null
                ? <div style={{ color: 'var(--fg2)', fontSize: 12 }}>{mcpStatBusy ? 'Checking…' : ''}</div>
                : mcpStat.length === 0
                  ? <div style={{ color: 'var(--fg2)', fontSize: 12 }}>No MCP servers configured.</div>
                  : <ul style={{ listStyle: 'none', padding: 0, margin: 0, borderTop: '1px solid var(--border)' }}>
                      {mcpStat.map((s) => <McpRow key={s.name} s={s} />)}
                    </ul>}
            </div>
            <textarea value={mcpText} onChange={(e) => setMcpText(e.target.value)} rows={14} spellCheck={false} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="primary" disabled={mcpBusy} onClick={() => void saveMcp()}>{mcpBusy ? 'Saving…' : 'Save MCP'}</button>
              <span style={{ color: 'var(--fg2)', fontSize: 12 }}>Raw config — restart the agent to apply changes.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

interface PickAgent { office: string; officeSlug: string; id: string; name: string; slug: string; online: boolean }

function ConnectModal({ path, agent, onClose, onDone, showToast }: { path: string; agent?: AgentState; onClose: () => void; onDone: () => void; showToast: (m: string, e?: boolean) => void }): JSX.Element {
  const [mode, setMode] = useState<'setup' | 'url' | 'pick'>('setup')
  const [value, setValue] = useState('')
  // "Create a new character" (charId === '__new__') name input.
  const [newCharName, setNewCharName] = useState('')
  const [fileBrowser, setFileBrowser] = useState(false)
  const [busy, setBusy] = useState(false)
  // "Pick from my office" state — only meaningful when already logged in.
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [offices, setOffices] = useState<{ slug: string; id: number; name: string }[]>([])
  const [pickAgents, setPickAgents] = useState<PickAgent[]>([])
  const [officeSlug, setOfficeSlug] = useState('')
  const [charId, setCharId] = useState('')
  const [pickErr, setPickErr] = useState('')
  const [loadingPick, setLoadingPick] = useState(false)

  // Lazily load the user's offices + characters the first time the picker mode
  // is chosen. Reuses the app's already-authenticated pixel-office session (the
  // same one the Office view uses) — no separate login here. If there's no live
  // session, we don't invent one: we surface it and the paste flows still work.
  useEffect(() => {
    if (mode !== 'pick' || authed !== null) return
    (async () => {
      setLoadingPick(true); setPickErr('')
      try {
        const st = (await window.api.officeStatus()) as { connected: boolean }
        const ok = st.connected || (await window.api.officeAutoConnect())
        setAuthed(!!ok)
        if (!ok) { setLoadingPick(false); return }
        const offs = (await window.api.officeOffices()) as { slug: string; id: number; name: string }[]
        const ags = (await window.api.officeAgents()) as PickAgent[]
        setOffices(offs)
        setPickAgents(ags)
        if (offs.length) setOfficeSlug((cur) => cur || offs[0].slug)
      } catch (e) {
        setAuthed(false)
        setPickErr(String((e as Error)?.message ?? e))
      } finally { setLoadingPick(false) }
    })()
  }, [mode, authed])

  // Keep the character select consistent with the selected office.
  const charsForOffice = pickAgents.filter((a) => a.officeSlug === officeSlug)
  useEffect(() => {
    if (charsForOffice.length && !charsForOffice.some((a) => a.id === charId) && charId !== '__new__') setCharId(charsForOffice[0].id)
    // An office with no characters defaults to "create a new one" so it's never a dead end.
    if (!charsForOffice.length) setCharId('__new__')
  }, [officeSlug, pickAgents]) // eslint-disable-line react-hooks/exhaustive-deps

  // Run the CLI connect + restart-if-running dance. Shared by every binding mode
  // so the picker proceeds EXACTLY like the paste flow does.
  const runConnect = async (bind: { setupUrl?: string; wsUrl?: string }) => {
    const args = bind.setupUrl
      ? ['connect', '--setup-url', bind.setupUrl, path]
      : ['connect', '--url', bind.wsUrl as string, path]
    if (fileBrowser) args.push('--file-browser')
    const r = await window.api.runCli(args)
    if (r.code !== 0) { showToast(r.stderr || 'Connect failed', true); return false }
    // A running agent won't pick up the new office binding until its loop is
    // restarted — so bounce it automatically instead of making the user do it.
    if (agent?.running) {
      showToast('Connected — restarting agent to join the office…')
      await window.api.stopAgent(path)
      await new Promise((res) => setTimeout(res, 700))
      await window.api.startAgent(path, agent.provider)
    } else {
      showToast('Connected to pixel-office')
    }
    return true
  }

  const connect = async () => {
    if (mode === 'pick') {
      if (!authed) return showToast('Log in to your pixel office first (Office tab).', true)
      setBusy(true)
      let targetCharId = charId
      // Create a brand-new character in the office when requested, then bind to it.
      if (charId === '__new__') {
        const nm = newCharName.trim()
        if (!nm) { setBusy(false); return showToast('Name the new character first', true) }
        const office = offices.find((o) => o.slug === officeSlug)
        if (!office) { setBusy(false); return showToast('Pick an office first', true) }
        const created = (await window.api.officeCreateCharacter(office.id, nm)) as { ok?: boolean; id?: string; error?: string }
        if (created?.error || !created?.id) { setBusy(false); return showToast(created?.error || 'Could not create the character', true) }
        targetCharId = created.id
      }
      if (!targetCharId) { setBusy(false); return showToast('Pick a character first', true) }
      const su = (await window.api.officeSetupUrl(officeSlug, targetCharId)) as { ok?: boolean; setupUrl?: string; error?: string }
      if (su?.error || !su?.setupUrl) { setBusy(false); return showToast(su?.error || 'Could not get a setup URL for that character', true) }
      const ok = await runConnect({ setupUrl: su.setupUrl })
      setBusy(false)
      if (ok) onDone()
      return
    }
    if (!value.trim()) return showToast('Paste the URL (or the whole connect command) first', true)
    // Accept a bare URL OR the full copied command (autodev --setup-url='…').
    const flag = mode === 'setup' ? '--setup-url' : '--url'
    const url = extractFlagUrl(value, flag)
    if (!url) return showToast(mode === 'setup'
      ? "Couldn't find a setup URL there — paste the signed https://… URL or the whole autodev --setup-url=… command"
      : "Couldn't find a ws:// URL there — paste the full wss://… URL or the whole connect command", true)
    setBusy(true)
    const ok = await runConnect(mode === 'setup' ? { setupUrl: url } : { wsUrl: url })
    setBusy(false)
    if (ok) onDone()
  }
  // Pasting the whole copied `autodev --setup-url=…` command? Silently pull the
  // URL out and drop just the clean URL into the field, so the user sees exactly
  // what was captured. A bare URL (or anything we can't parse) pastes normally.
  const onPasteExtract = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = e.clipboardData.getData('text')
    const url = extractFlagUrl(pasted, mode === 'setup' ? '--setup-url' : '--url')
    if (url && url !== pasted.trim()) {
      e.preventDefault()
      setValue(url)
      showToast('Captured the URL from the pasted command')
    }
  }
  const trapRef = useFocusTrap<HTMLDivElement>()
  return (
    <div className="modal-bg" onClick={onClose} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="modal" ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="connect-modal-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="connect-modal-title">{CONNECT_LABEL}</h3>
        <p style={{ marginTop: 0, fontSize: 12, color: 'var(--fg2)', lineHeight: 1.5 }}>
          {mode === 'pick'
            ? <>Links this local agent to a character in your pixel office. Pick the office and character below — no copy-paste needed while you're logged in.</>
            : <>Links this local agent to a character in your pixel office. Open the office in your browser, pick the character, and paste its <em>signed setup URL</em> — or the whole <code>autodev --setup-url=…</code> command — here.</>}
        </p>
        <label className="field"><span className="lbl">Binding</span>
          <select autoFocus value={mode} onChange={(e) => setMode(e.target.value as 'setup' | 'url' | 'pick')}>
            <option value="pick">Pick from my office (logged in)</option>
            <option value="setup">Signed setup URL (from the office UI)</option>
            <option value="url">Full ws:// URL (token + endpoint)</option>
          </select>
        </label>
        {mode === 'pick' ? (
          loadingPick ? (
            <p style={{ fontSize: 12, color: 'var(--fg2)' }}>Loading your offices…</p>
          ) : authed === false ? (
            <p style={{ fontSize: 12, color: 'var(--fg2)', lineHeight: 1.5 }}>
              Not logged in to a pixel office. Open the <strong>Office</strong> tab to connect, or use one of the paste-URL bindings above.
              {pickErr && <><br /><span style={{ color: 'var(--danger,#ff6b6b)' }}>{pickErr}</span></>}
            </p>
          ) : (
            <>
              <label className="field"><span className="lbl">Office</span>
                <select value={officeSlug} onChange={(e) => setOfficeSlug(e.target.value)}>
                  {offices.length === 0 && <option value="">(no office)</option>}
                  {offices.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
                </select>
              </label>
              <label className="field"><span className="lbl">Character</span>
                <select value={charId} onChange={(e) => setCharId(e.target.value)}>
                  {charsForOffice.map((a) => <option key={a.id} value={a.id}>{a.name}{a.online ? ' · online' : ''}</option>)}
                  <option value="__new__">＋ Create a new character…</option>
                </select>
              </label>
              {charId === '__new__' && (
                <label className="field"><span className="lbl">New character name</span>
                  <input value={newCharName} placeholder="e.g. Researcher" autoFocus onChange={(e) => setNewCharName(e.target.value)} />
                </label>
              )}
            </>
          )
        ) : (
          <label className="field"><span className="lbl">{mode === 'setup' ? 'Setup URL' : 'WebSocket URL'}</span>
            <textarea rows={3} value={value} placeholder={mode === 'setup' ? "https://…/api/cli/setup/…   — or paste:  autodev --setup-url='…'" : 'wss://host/ws?token=…&endpoint=…'} onPaste={onPasteExtract} onChange={(e) => setValue(e.target.value)} />
          </label>
        )}
        <FileBrowserCheckbox checked={fileBrowser} onChange={setFileBrowser} id="connect-file-browser" />
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</button>
        </div>
      </div>
    </div>
  )
}

/**
 * Connect one or more already-spawned LOCAL agents to an office. Pick an office;
 * each target is bound to a character matched BY NAME (bindWorkspaceToOffice writes
 * the presence binding + office-MCP). A running loop is restarted so it reconnects
 * as the bound character. Drives both the single-agent menu item and the bulk bar.
 */
function ConnectOfficeModal({ targets, onClose, onDone, showToast }: { targets: AgentState[]; onClose: () => void; onDone: () => void; showToast: (m: string, e?: boolean) => void }): JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [offices, setOffices] = useState<{ slug: string; id: number; name: string }[]>([])
  const [officeSlug, setOfficeSlug] = useState('')
  const [fileBrowser, setFileBrowser] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const trapRef = useFocusTrap<HTMLDivElement>()

  // Reuse the app's existing pixel-office session (same one the Office view uses).
  useEffect(() => {
    (async () => {
      setLoading(true); setErr('')
      try {
        const st = (await window.api.officeStatus()) as { connected: boolean }
        const ok = st.connected || (await window.api.officeAutoConnect())
        setAuthed(!!ok)
        if (!ok) { setLoading(false); return }
        const offs = (await window.api.officeOffices()) as { slug: string; id: number; name: string }[]
        setOffices(offs)
        if (offs.length) setOfficeSlug((cur) => cur || offs[0].slug)
      } catch (e) { setAuthed(false); setErr(String((e as Error)?.message ?? e)) }
      finally { setLoading(false) }
    })()
  }, [])

  const connect = async () => {
    if (!authed) return showToast('Log in to your pixel office first (Office tab).', true)
    if (!officeSlug) return showToast('Pick an office first', true)
    setBusy(true)
    let bound = 0
    const missing: string[] = []
    for (const a of targets) {
      const b = (await window.api.officeBindWorkspace(a.path, officeSlug, { name: a.name }, fileBrowser)) as { ok?: boolean; error?: string }
      if (b?.ok) {
        bound++
        // A running loop won't pick up the new binding until restarted — bounce it
        // so the character reconnects live in the office.
        if (a.running) {
          await window.api.stopAgent(a.path)
          await new Promise((r) => setTimeout(r, 700))
          await window.api.startAgent(a.path, a.provider)
        }
      } else { missing.push(a.name) }
    }
    setBusy(false)
    const miss = missing.length ? ` — no office match for: ${missing.join(', ')}` : ''
    showToast(bound ? `Connected ${bound}/${targets.length} to the office${miss}` : `Couldn't connect any${miss}`, bound === 0)
    onDone()
  }

  return (
    <div className="modal-bg" onClick={onClose} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="modal" ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="connect-office-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="connect-office-title">☁ Connect {targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} agents`} to office</h3>
        <p style={{ marginTop: 0, fontSize: 12, color: 'var(--fg2)', lineHeight: 1.5 }}>
          Binds {targets.length === 1 ? 'this agent' : 'each selected agent'} to an office character matched <strong>by name</strong>, writing its office presence + MCP wiring. Running agents are restarted so they reconnect.
        </p>
        {loading ? (
          <p style={{ fontSize: 12, color: 'var(--fg2)' }}>Loading your offices…</p>
        ) : authed === false ? (
          <p style={{ fontSize: 12, color: 'var(--fg2)', lineHeight: 1.5 }}>
            Not logged in to a pixel office. Open the <strong>Office</strong> tab to connect first.
            {err && <><br /><span style={{ color: 'var(--danger,#ff6b6b)' }}>{err}</span></>}
          </p>
        ) : (
          <>
            <label className="field"><span className="lbl">Office</span>
              <select autoFocus value={officeSlug} onChange={(e) => setOfficeSlug(e.target.value)}>
                {offices.length === 0 && <option value="">(no office)</option>}
                {offices.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
              </select>
            </label>
            <FileBrowserCheckbox checked={fileBrowser} onChange={setFileBrowser} id="connect-office-file-browser" />
          </>
        )}
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || loading || authed === false || !officeSlug} onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</button>
        </div>
      </div>
    </div>
  )
}

/**
 * Remove one or more agents with options: remove from the list (always), and
 * optionally (both default OFF) delete the workspace folder from disk and/or
 * delete the linked office character. The checkboxes apply to ALL targets, so one
 * modal serves both the single-agent menu and the bulk bar. Character deletion is
 * only offered when at least one target carries resolved office info.
 */
function RemoveModal({ targets, onClose, onDone, showToast }: { targets: AgentState[]; onClose: () => void; onDone: () => void; showToast: (m: string, e?: boolean) => void }): JSX.Element {
  const [delFolder, setDelFolder] = useState(false)
  const [delChar, setDelChar] = useState(false)
  const [busy, setBusy] = useState(false)
  const trapRef = useFocusTrap<HTMLDivElement>()
  // Character deletion needs the office id + slug the presence poll resolves.
  const withOffice = targets.filter((a) => a.officeAgentId && a.officeSlug)
  const canDeleteChar = withOffice.length > 0

  const apply = async () => {
    setBusy(true)
    let removed = 0, folders = 0, chars = 0
    const errors: string[] = []
    for (const a of targets) {
      // Delete the office character FIRST — it needs the still-resolved office info.
      if (delChar && a.officeAgentId && a.officeSlug) {
        const d = (await window.api.officeDeleteAgent(a.officeSlug, a.officeAgentId)) as { ok?: boolean; error?: string }
        if (d?.ok) chars++
        else if (d?.error) errors.push(`${a.name} (character): ${d.error}`)
      }
      if (delFolder) {
        const r = (await window.api.removeAgentFolder(a.path)) as { ok?: boolean; error?: string }
        if (r?.ok) { folders++; removed++ }
        else {
          // Guard refused / rm failed — still take it out of the list.
          errors.push(`${a.name}: ${r?.error ?? 'folder delete failed'}`)
          await window.api.removeAgent(a.path); removed++
        }
      } else {
        await window.api.removeAgent(a.path); removed++
      }
    }
    setBusy(false)
    const parts = [`Removed ${removed}`]
    if (delFolder) parts.push(`${folders} folder${folders === 1 ? '' : 's'} deleted`)
    if (delChar) parts.push(`${chars} character${chars === 1 ? '' : 's'} deleted`)
    showToast(parts.join(' · ') + (errors.length ? ` — ${errors.length} error${errors.length === 1 ? '' : 's'}` : ''), errors.length > 0)
    onDone()
  }

  const destructive = delFolder || delChar
  return (
    <div className="modal-bg" onClick={onClose} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="modal" ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="remove-modal-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="remove-modal-title">🗑 Remove {targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} agents`}</h3>
        <p style={{ marginTop: 0, fontSize: 12, color: 'var(--fg2)', lineHeight: 1.5 }}>
          {targets.length === 1 ? 'This agent' : 'These agents'} will be removed from the list. By default the workspace files and any office character are kept — check below to also delete them.
        </p>
        <label className="field-check" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '8px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={delFolder} onChange={(e) => setDelFolder(e.target.checked)} />
          <span><strong>Delete workspace folder from disk</strong><br /><span style={{ fontSize: 11, color: 'var(--fg2)' }}>Permanently removes the folder{targets.length === 1 ? '' : 's'} and all files. Cannot be undone.</span></span>
        </label>
        <label className="field-check" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '8px 0', cursor: canDeleteChar ? 'pointer' : 'not-allowed', opacity: canDeleteChar ? 1 : 0.5 }}>
          <input type="checkbox" checked={delChar} disabled={!canDeleteChar} onChange={(e) => setDelChar(e.target.checked)} />
          <span><strong>Delete character from pixel office</strong><br /><span style={{ fontSize: 11, color: 'var(--fg2)' }}>{canDeleteChar ? `Deletes the linked office character${withOffice.length === targets.length ? '' : ` (${withOffice.length}/${targets.length} linked)`}.` : 'No office-linked character resolved for these agents.'}</span></span>
        </label>
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className={destructive ? 'danger' : 'primary'} disabled={busy} onClick={apply}>{busy ? 'Removing…' : destructive ? 'Remove & delete' : 'Remove from list'}</button>
        </div>
      </div>
    </div>
  )
}

function CreateModal({ onClose, onCreated, showToast, initialPath, initMode, defaultParent, defaultProvider, defaultOfficeSlug }: { onClose: () => void; onCreated: (p: string) => void; showToast: (m: string, e?: boolean) => void; initialPath?: string; initMode?: boolean; defaultParent?: string; defaultProvider?: string; defaultOfficeSlug?: string }): JSX.Element {
  // initMode: reached from "Add existing folder" when the chosen folder isn't an
  // AutoDev workspace yet — pre-seed the path and frame the modal as "initialize
  // this folder" instead of a blank "create". Same init path either way.
  // defaultParent: sidebar quick-add — create a new agent INSIDE that folder group;
  // the workspace folder is derived from the typed name, and defaultProvider /
  // defaultOfficeSlug preselect what the folder's existing agents already use.
  const [path, setPath] = useState(initialPath ?? '')
  const [provider, setProvider] = useState(defaultProvider ?? 'claude-tui')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [fileBrowser, setFileBrowser] = useState(false)
  // Shared "connect to pixel office?" selection (checkbox + office dropdown),
  // same composable the Spawn-agents view uses. Pick an existing office only here.
  const officeSel = useOfficeSelection({ defaultUseOffice: !!defaultOfficeSlug })
  // When the chosen folder is already an AutoDev agent, we must NOT re-init it
  // (that overwrites its settings + office binding) — we connect it instead.
  const [existing, setExisting] = useState<{ provider?: string; sessionName?: string } | null>(null)

  // This dialog picks an EXISTING office only (no ＋New option), so keep the
  // selection pointed at a real office once the box is checked and the list loads.
  const { useOffice: selUseOffice, offices: selOffices, selectedOfficeId: selId, setSelectedOfficeId: setSelId } = officeSel
  useEffect(() => {
    if (selUseOffice && selOffices.length && !selOffices.some((o) => String(o.id) === selId)) {
      setSelId(String(selOffices[0].id))
    }
  }, [selUseOffice, selOffices, selId, setSelId])

  // ── Sidebar quick-add (defaultParent) ──────────────────────────────────────
  // Derive the workspace folder from the typed name, inside the group's parent
  // folder — so "add an agent here" just needs a name.
  useEffect(() => {
    if (!defaultParent) return
    const seg = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    setPath(seg ? `${defaultParent.replace(/\/+$/, '')}/${seg}` : '')
  }, [name, defaultParent])
  // Preselect the office the folder's existing agents are bound to (load the list
  // if it isn't in yet), matching what a same-folder add should default to.
  useEffect(() => {
    if (defaultOfficeSlug) void officeSel.loadOffices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!defaultOfficeSlug || !officeSel.offices.length) return
    const match = officeSel.offices.find((o) => o.slug === defaultOfficeSlug)
    if (match) { officeSel.setUseOffice(true); officeSel.setSelectedOfficeId(String(match.id)) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultOfficeSlug, officeSel.offices])

  // Detect an existing workspace whenever the path changes (browse or typed).
  const probe = useCallback(async (p: string) => {
    if (!p) { setExisting(null); return }
    const info = await window.api.workspaceInfo(p)
    setExisting(info?.exists ? { provider: info.provider, sessionName: info.sessionName } : null)
  }, [])
  useEffect(() => { probe(path) }, [path, probe])

  const pick = async () => { const p = await window.api.pickFolder(); if (p) setPath(p) }

  const submit = async () => {
    if (!path) return showToast('Pick a folder first', true)
    setBusy(true)
    // Re-probe at submit time so we never clobber based on stale UI state.
    const info = await window.api.workspaceInfo(path)
    if (info?.exists) {
      // Existing agent: keep its settings, just register + connect it.
      const added = await window.api.addAgent(path)
      if ((added as { error?: string })?.error) { setBusy(false); return showToast((added as { error: string }).error, true) }
      const started = await window.api.startAgent(path)   // provider omitted → uses its own settings
      setBusy(false)
      if ((started as { error?: string })?.error) return showToast((started as { error: string }).error, true)
      showToast(`Connected existing agent — settings kept`)
      onCreated(path)
      return
    }
    // New folder → initialise a fresh agent.
    const args = ['init', path, '--provider', provider]
    if (name) args.push('--session-name', name)
    const r = await window.api.runCli(args)
    if (r.code !== 0) { setBusy(false); return showToast(r.stderr || 'init failed', true) }
    // Enable the file browser at init-time via the settings key (the init-flow
    // way — works whether or not we also bind to an office below).
    if (fileBrowser) await window.api.runCli(['config', 'set', 'enableFileBrowser', 'true', path])
    await window.api.addAgent(path)
    // Optionally bind the fresh agent to a pixel office by creating a new
    // character there and connecting (mirrors ConnectModal's ＋New-character path).
    const choice = officeSel.resolve()
    if (choice.kind === 'office') {
      const charName = name.trim() || path.split('/').filter(Boolean).pop() || 'Agent'
      const res = await connectAgentToNewCharacter(choice.office, charName, path, fileBrowser)
      if (!res.ok) {
        setBusy(false)
        // The local agent exists and is registered — surface the binding failure
        // but still hand control back so the user isn't stuck.
        showToast(res.error || 'Created, but could not connect to the office', true)
        onCreated(path)
        return
      }
      setBusy(false)
      showToast(`Created and connected to “${choice.office.name}”`)
      onCreated(path)
      return
    }
    setBusy(false)
    onCreated(path)
  }

  const trapRef = useFocusTrap<HTMLDivElement>()
  return (
    <div className="modal-bg" onClick={onClose} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="modal" ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="create-modal-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="create-modal-title">{existing ? 'Connect existing agent' : initMode ? 'Initialize this folder?' : 'Create agent'}</h3>
        {initMode && !existing && (
          <div className="field" style={{ background: '#2a230d', border: '1px solid #7a5c16', borderRadius: 6, padding: '8px 10px', color: '#fcd34d', fontSize: 12 }}>
            This folder isn't an AutoDev agent yet. Pick a provider to initialize it here.
          </div>
        )}
        {defaultParent ? (
          <label className="field"><span className="lbl">New agent name</span>
            <input autoFocus value={name} placeholder="e.g. Sound Designer" onChange={(e) => setName(e.target.value)} />
            <div className="sub" style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>Creates in <code>{path || `${defaultParent.replace(/\/+$/, '')}/…`}</code></div>
          </label>
        ) : (
          <label className="field"><span className="lbl">Workspace folder</span>
            <div className="row"><input autoFocus value={path} placeholder="/path/to/workspace" onChange={(e) => setPath(e.target.value)} /><button onClick={pick}>Browse</button></div>
          </label>
        )}
        {existing ? (
          <div className="field" style={{ background: '#0d2a17', border: '1px solid #16653a', borderRadius: 6, padding: '8px 10px', color: '#86efac', fontSize: 12 }}>
            ✓ This folder already has an agent{existing.provider ? ` (${existing.provider}` : ''}{existing.provider && existing.sessionName ? ` · ${existing.sessionName})` : existing.provider ? ')' : ''}.<br />
            Its settings will be kept — it'll just be connected.
          </div>
        ) : (
          <>
            <label className="field"><span className="lbl">Provider</span>
              <ProviderSelect value={provider} onChange={setProvider} id="create-provider" />
            </label>
            {!defaultParent && (
              <label className="field"><span className="lbl">Session name (optional)</span>
                <input value={name} placeholder="My Agent" onChange={(e) => setName(e.target.value)} />
              </label>
            )}
            {/* Optionally attach the new agent to a pixel office (shown only while
                connected). Pick an existing office — a new character is created there. */}
            <OfficeSelector
              connected={officeSel.connected}
              useOffice={officeSel.useOffice}
              onToggle={officeSel.setUseOffice}
              offices={officeSel.offices}
              selectedOfficeId={officeSel.selectedOfficeId}
              onSelect={officeSel.setSelectedOfficeId}
              disabled={busy}
              idPrefix="create"
              boxed={false}
              noOfficesNote="No offices yet — create one in the Office view first."
              uncheckedNote="Leave off to create a purely local agent (not attached to any pixel office)."
            />
            <FileBrowserCheckbox checked={fileBrowser} onChange={setFileBrowser} disabled={busy} id="create-file-browser" />
          </>
        )}
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={submit}>{busy ? (existing ? 'Connecting…' : initMode ? 'Initializing…' : 'Creating…') : (existing ? 'Connect' : initMode ? 'Initialize' : 'Create')}</button>
        </div>
      </div>
    </div>
  )
}
