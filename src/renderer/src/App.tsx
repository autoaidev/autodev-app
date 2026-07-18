import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import SessionsBrowser from './SessionsBrowser'
import PixelOfficeView from './PixelOfficeView'
import MakeAppView from './MakeAppView'

type Activity = 'working' | 'idle' | 'stopped' | 'stalled' | 'needs-auth' | 'rate-limited' | 'crashed'
interface AgentState {
  path: string
  name: string
  provider?: string
  sessionName?: string
  wsUrl?: string
  running: boolean
  activity: Activity
  tasks: { total: number; remaining: number; done: number }
  currentTask?: string
  lastOutput?: string
  error?: string
  exitCode?: number | null
}

// Human labels + whether the state needs the operator's attention (drives the
// status pill/dot styling and the recovery CTA).
const ACTIVITY_LABEL: Record<Activity, string> = {
  working: 'Working', idle: 'Idle', stopped: 'Stopped', stalled: 'Stalled',
  'needs-auth': 'Needs re-auth', 'rate-limited': 'Rate-limited', crashed: 'Crashed'
}
const ATTENTION_STATES = new Set<Activity>(['stalled', 'needs-auth', 'rate-limited', 'crashed'])

// Grouped by vendor with human labels, so the first decision a new user makes
// isn't a wall of 8 cryptic slugs. claude-tui is the recommended default.
const PROVIDER_GROUPS: Array<{ vendor: string; options: Array<{ id: string; label: string }> }> = [
  { vendor: 'Claude', options: [{ id: 'claude-tui', label: 'Claude — interactive (recommended)' }, { id: 'claude-cli', label: 'Claude — headless CLI' }] },
  { vendor: 'GitHub Copilot', options: [{ id: 'copilot-cli', label: 'Copilot — CLI' }, { id: 'copilot-sdk', label: 'Copilot — SDK (API key)' }] },
  { vendor: 'OpenCode', options: [{ id: 'opencode-cli', label: 'OpenCode — CLI' }, { id: 'opencode-sdk', label: 'OpenCode — SDK (API key)' }] },
  { vendor: 'Grok', options: [{ id: 'grok-cli', label: 'Grok — CLI' }, { id: 'grok-tui', label: 'Grok — interactive' }] }
]
const PROVIDER_HINT = 'interactive = a terminal you can watch/log into · CLI = headless · SDK = needs an API key'

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
  // Once a heavy view (Office / Sessions / Make-app) has been opened we keep it
  // MOUNTED and merely toggle its visibility with CSS `display` — switching tabs or
  // re-clicking a sidebar button must never unmount it, or its child TerminalPane's
  // cleanup would SIGKILL the live Operate/Resume PTY that keeps the office
  // character online (and lose the terminal scrollback). Lazy: nothing mounts until
  // first opened.
  const [openedSessions, setOpenedSessions] = useState(false)
  const [openedOffice, setOpenedOffice] = useState(false)
  const [openedMakeApp, setOpenedMakeApp] = useState(false)
  const [tab, setTab] = useState<'overview' | 'output' | 'sessions' | 'todo' | 'config'>('overview')
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'attention'>('all')
  const [creating, setCreating] = useState(false)
  const [nudgePath, setNudgePath] = useState<string | null>(null)  // just-created agent: nudge the first task
  const [connectFor, setConnectFor] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)
  const [cliMissing, setCliMissing] = useState(false)
  const [ioBusy, setIoBusy] = useState(false)              // export/import in flight (long zips outlive the toast)
  const [stopping, setStopping] = useState<Set<string>>(new Set())  // agents mid-shutdown
  const [checked, setChecked] = useState<Set<string>>(new Set())    // multi-select for bulk actions
  const logsRef = useRef<Map<string, string>>(new Map())
  // Bump this to force a re-render when a log line lands in logsRef (a ref, so it
  // doesn't itself trigger renders). The value is unused — only the re-render is.
  const [, setLogTick] = useState(0)

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
      setLogTick((t) => t + 1)
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
    setSelected(path); setShowOffice(false); setShowSessions(false); setShowMakeApp(false)
  }, [])

  // The list, filtered by search + status, with the agents that need attention
  // floated to the top (then running, then alphabetical) so trouble is never
  // buried at the bottom of a long fleet.
  const visibleAgents = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const rank = (a: AgentState) => (ATTENTION_STATES.has(a.activity) ? 0 : a.running ? 1 : 2)
    return agents
      .filter((a) =>
        (!q || a.name.toLowerCase().includes(q) || (a.provider ?? '').toLowerCase().includes(q)) &&
        (statusFilter === 'all' ||
          (statusFilter === 'running' && a.running) ||
          (statusFilter === 'attention' && ATTENTION_STATES.has(a.activity))))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }, [agents, filter, statusFilter])

  const addExisting = async () => {
    const path = await window.api.pickFolder()
    if (!path) return
    const r = await window.api.addAgent(path)
    if ((r as any).error) return showToast((r as any).error, true)
    await refresh(); setSelected(path)
  }

  const start = async (a: AgentState) => {
    const r = await window.api.startAgent(a.path)
    if ((r as any).error) showToast((r as any).error, true)
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
    if (a.running) { await window.api.stopAgent(a.path); await new Promise((r) => setTimeout(r, 800)) }
    logsRef.current.set(a.path, '')
    const r = await window.api.startAgent(a.path)
    if ((r as any).error) showToast((r as any).error, true)
    else { selectAgent(a.path); setTab('output') }
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
    if (!window.confirm(`Stop all ${running.length} running agent${running.length === 1 ? '' : 's'}?`)) return
    showToast(`Stopping ${running.length}…`)
    for (const a of running) await window.api.stopAgent(a.path)
    refresh()
  }

  const toggleChecked = (path: string) => setChecked((s) => { const n = new Set(s); n.has(path) ? n.delete(path) : n.add(path); return n })
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
  const bulk = async (kind: 'start' | 'stop' | 'restart' | 'remove') => {
    const paths = [...checked]
    if (!paths.length) return
    if (kind === 'stop' && !window.confirm(`Stop ${paths.length} selected agent${paths.length === 1 ? '' : 's'}?`)) return
    if (kind === 'remove' && !window.confirm(`Remove ${paths.length} selected agent${paths.length === 1 ? '' : 's'} from the list? (workspace files are kept)`)) return
    for (const p of paths) {
      const a = agents.find((x) => x.path === p)
      if (!a) continue
      if (kind === 'start' && !a.running) await window.api.startAgent(p)
      else if (kind === 'stop' && a.running) await window.api.stopAgent(p)
      else if (kind === 'restart') { if (a.running) { await window.api.stopAgent(p); await new Promise((r) => setTimeout(r, 600)) } await window.api.startAgent(p) }
      else if (kind === 'remove') { await window.api.removeAgent(p); if (selected === p) setSelected(null) }
    }
    setChecked(new Set())
    refresh()
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
      <div className="app" style={{ flex: 1, minHeight: 0 }}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1><span className="logo">◆</span> AutoDev{runningCount > 0 && <span className="badge" style={{ marginLeft: 8 }}>{runningCount} running</span>}
            {attentionCount > 0 && <span className="attn-chip" style={{ marginLeft: 6 }} title="Agents needing attention — click to filter"
              onClick={() => setStatusFilter((f) => (f === 'attention' ? 'all' : 'attention'))}>⚠ {attentionCount}</span>}</h1>
          <div className="row">
            <button title="Add existing workspace" onClick={addExisting} disabled={cliMissing}>+ Add</button>
            <button title="Import agent backup" aria-label="Import agent backup" onClick={importAgent} disabled={cliMissing || ioBusy}>⬆</button>
          </div>
        </div>
        {agents.length > 0 && (
          <div className="fleet-actions">
            <button onClick={startAll} disabled={cliMissing || runningCount === agents.length} title="Start every stopped agent">▶ Start all</button>
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
          </div>
        )}
        {checked.size > 0 && (
          <div className="bulk-bar" role="toolbar" aria-label="Bulk actions for selected agents">
            <strong>{checked.size} selected</strong>
            <div className="spacer" />
            <button title="Start selected" aria-label="Start selected" onClick={() => bulk('start')}>▶</button>
            <button className="danger" title="Stop selected" aria-label="Stop selected" onClick={() => bulk('stop')}>■</button>
            <button title="Restart selected" aria-label="Restart selected" onClick={() => bulk('restart')}>↻</button>
            <button className="danger" title="Remove selected from list" aria-label="Remove selected from list" onClick={() => bulk('remove')}>🗑</button>
            <button title="Clear selection" aria-label="Clear selection" onClick={() => setChecked(new Set())}>✕</button>
          </div>
        )}
        <div className="agent-list">
          {agents.length === 0 && <div className="empty" style={{ padding: 24, fontSize: 12 }}>No agents yet.<br />Create or add one.</div>}
          {agents.length > 0 && visibleAgents.length === 0 && <div className="no-match">No agents match.</div>}
          {visibleAgents.map((a) => (
            <div key={a.path} role="button" tabIndex={0} aria-pressed={a.path === selected}
              className={'agent-row' + (a.path === selected ? ' active' : '') + (checked.has(a.path) ? ' checked' : '')}
              onClick={() => selectAgent(a.path)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAgent(a.path) } }}>
              <input type="checkbox" className="row-check" checked={checked.has(a.path)} aria-label={`Select ${a.name} for bulk actions`}
                onClick={(e) => e.stopPropagation()} onChange={() => toggleChecked(a.path)} />
              <span className={'dot ' + a.activity} title={a.error || ACTIVITY_LABEL[a.activity]} />
              <div className="meta">
                <div className="name">{a.name}{ATTENTION_STATES.has(a.activity) && <span className="attn-tag" title={a.error || ACTIVITY_LABEL[a.activity]}>{a.activity === 'needs-auth' ? '🔑' : a.activity === 'rate-limited' ? '⏳' : '⚠'}</span>}</div>
                <div className="sub" title={a.running && a.currentTask ? a.currentTask : undefined}>{a.provider ?? 'no provider'} · {ATTENTION_STATES.has(a.activity) ? ACTIVITY_LABEL[a.activity] : a.running && a.currentTask ? a.currentTask : `${a.tasks.remaining} left`}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button aria-pressed={showMakeApp} style={{ width: '100%', background: showMakeApp ? 'var(--accent-dim,#1f6feb33)' : undefined, borderColor: showMakeApp ? 'var(--accent,#388bfd)' : undefined }}
            onClick={() => { setShowMakeApp((s) => !s); setShowOffice(false); setShowSessions(false); setOpenedMakeApp(true) }} title="Describe an app and generate an office team to build it">✨ Make app</button>
          <button aria-pressed={showOffice} style={{ width: '100%', background: showOffice ? 'var(--accent-dim,#1f6feb33)' : undefined, borderColor: showOffice ? 'var(--accent,#388bfd)' : undefined }}
            onClick={() => { setShowOffice((s) => !s); setShowSessions(false); setShowMakeApp(false); setOpenedOffice(true) }} title="Connect & operate your remote pixel-office agents">☁ Pixel Office</button>
          <button aria-pressed={showSessions} style={{ width: '100%', background: showSessions ? 'var(--accent-dim,#1f6feb33)' : undefined, borderColor: showSessions ? 'var(--accent,#388bfd)' : undefined }}
            onClick={() => { setShowSessions((s) => !s); setShowOffice(false); setShowMakeApp(false); setOpenedSessions(true) }} title="Capture Claude sessions on this machine">🗂 Claude sessions</button>
          <button className="primary" style={{ width: '100%' }} onClick={() => setCreating(true)} disabled={cliMissing} title={cliMissing ? 'Install the autodev CLI first' : undefined}>＋ Create agent</button>
        </div>
      </aside>

      <main className="main">
        {/* Heavy views stay mounted once opened (see openedX above) and only hide via
            `display`, so a live Operate/Resume terminal survives tab switches. */}
        {openedMakeApp && <div style={{ display: showMakeApp ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}><MakeAppView /></div>}
        {openedOffice && <div style={{ display: showOffice ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}><PixelOfficeView visible={showOffice} /></div>}
        {openedSessions && <div style={{ display: showSessions ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}><SessionsBrowser visible={showSessions} /></div>}
        {!showMakeApp && !showOffice && !showSessions && cliMissing && <CliSetup onRecheck={recheckCli} />}
        {!showMakeApp && !showOffice && !showSessions && !cliMissing && !current && (
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
                  <span className="ico">✨</span><span>Make an app<span className="sub">Describe an app and generate a team to build it</span></span>
                </button>
                <button className="cta" onClick={() => { setShowOffice(true); setOpenedOffice(true) }}>
                  <span className="ico">☁</span><span>Connect a Pixel Office<span className="sub">Operate your remote office characters</span></span>
                </button>
              </div>
            </div>
          ) : <div className="empty">Select an agent</div>
        )}
        {!showMakeApp && !showOffice && !showSessions && !cliMissing && current && (
          <>
            <div className="detail-head">
              <span className={'dot ' + current.activity} />
              <div className="head-id">
                <h2>{current.name}</h2>
                <div className="path" title={current.path}>{current.path}</div>
              </div>
              <span className="badge">{current.provider ?? '—'}</span>
              {current.wsUrl && <span className="badge">● office</span>}
              <span className={'status-pill ' + current.activity} title={current.error || ACTIVITY_LABEL[current.activity]}>{ACTIVITY_LABEL[current.activity]}</span>
              <div className="spacer" />
              {current.running
                ? <button className="danger" disabled={stopping.has(current.path)} onClick={() => stop(current)}>{stopping.has(current.path) ? 'Stopping…' : '■ Stop'}</button>
                : <button className="start" onClick={() => start(current)}>▶ Start</button>}
              {current.running && <button title="Restart (stop then start) — applies Config / MCP changes" onClick={() => restart(current)}>↻ Restart</button>}
              <button title="Open workspace folder" onClick={() => window.api.openPath(current.path)}>📁 Open</button>
              <OverflowMenu items={[
                { label: '⚿ Bind to office', onClick: () => setConnectFor(current.path) },
                { label: ioBusy ? '⬇ Exporting…' : '⬇ Export backup', onClick: () => { if (!ioBusy) exportAgent(current) } },
                { label: '🗑 Remove from list', danger: true, sep: true, onClick: async () => { if (!window.confirm(`Remove "${current.name}" from the list? (workspace files are kept)`)) return; await window.api.removeAgent(current.path); setSelected(null); refresh() } }
              ]} />
            </div>

            {ATTENTION_STATES.has(current.activity) && current.error && (
              <div className={'attention-banner ' + current.activity} role="alert">
                <span className="attention-icon" aria-hidden="true">{current.activity === 'needs-auth' ? '🔑' : current.activity === 'rate-limited' ? '⏳' : '⚠'}</span>
                <div className="attention-text">
                  <strong>{ACTIVITY_LABEL[current.activity]}</strong> — {current.error}
                  {current.activity === 'needs-auth' && <span className="attention-hint"> Sign in to {current.provider ?? 'the provider'} (open the Terminal below and run its login), then the loop resumes automatically.</span>}
                </div>
                {(current.activity === 'crashed' || current.activity === 'stalled') && (
                  <button className="start" onClick={() => restart(current)}>↻ Restart</button>
                )}
              </div>
            )}

            <div className="tabs" role="tablist"
              onKeyDown={(e) => {
                // Roving-tabindex tablist needs arrow-key nav (WAI-ARIA): move both
                // selection AND focus, else the inactive tabIndex=-1 tabs are
                // unreachable by keyboard.
                const tabs = ['overview', 'output', 'sessions', 'todo', 'config'] as const
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
              {(['overview', 'output', 'sessions', 'todo', 'config'] as const).map((t) => (
                <div key={t} role="tab" aria-selected={tab === t} tabIndex={tab === t ? 0 : -1}
                  className={'tab' + (tab === t ? ' active' : '')}
                  title={t === 'sessions' ? 'Resume a past provider session for this workspace' : undefined}
                  onClick={() => setTab(t)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>
                  {t === 'sessions' ? 'Resume' : t[0].toUpperCase() + t.slice(1)}
                </div>
              ))}
            </div>

            <div className="panel">
              {tab === 'overview' && <Overview a={current} />}
              {tab === 'output' && <Output text={logsRef.current.get(current.path) || current.lastOutput || 'No output yet. Start the agent.'} />}
              {tab === 'sessions' && <SessionsTab path={current.path} provider={current.provider} showToast={showToast} />}
              {tab === 'todo' && <TodoTab path={current.path} />}
              {tab === 'config' && <Config a={current} onSaved={refresh} showToast={showToast} />}
            </div>

            <MessageBar key={current.path} path={current.path} running={current.running} showToast={showToast}
              nudge={nudgePath === current.path && current.tasks.total === 0} onSent={() => setNudgePath(null)} />
          </>
        )}
      </main>

      {creating && <CreateModal onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); setNudgePath(p); refresh().then(() => selectAgent(p)) }} showToast={showToast} />}
      {connectFor && <ConnectModal path={connectFor} agent={agents.find((a) => a.path === connectFor)} onClose={() => setConnectFor(null)} onDone={() => { setConnectFor(null); refresh() }} showToast={showToast} />}
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
        <button className="primary" disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? '…' : '＋ Add task'}</button>
      </div>
    </>
  )
}

// Secondary/destructive actions collapsed behind a "⋯" so the primary Start/Stop/
// Restart stand out and the destructive Remove isn't one slot from a benign
// button with identical styling.
function OverflowMenu({ items }: { items: Array<{ label: string; onClick: () => void; danger?: boolean; sep?: boolean }> }): JSX.Element {
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
    <div className="overflow" ref={ref}>
      <button aria-haspopup="menu" aria-expanded={open} aria-label="More actions" title="More actions" onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && (
        <div className="overflow-menu" role="menu">
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
      <div className="card"><div className="k">Provider</div><div style={{ marginTop: 4 }}>{a.provider ?? '—'}</div></div>
      <div style={{ height: 12 }} />
      <div className="card"><div className="k">Session name</div><div style={{ marginTop: 4 }}>{a.sessionName || '(folder name)'}</div></div>
      {a.wsUrl && <><div style={{ height: 12 }} /><div className="card"><div className="k">Pixel-office</div><div style={{ marginTop: 4, wordBreak: 'break-all', fontSize: 11 }}>{a.wsUrl}</div></div></>}
    </>
  )
}

function Output({ text }: { text: string }): JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
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

function ConnectModal({ path, agent, onClose, onDone, showToast }: { path: string; agent?: AgentState; onClose: () => void; onDone: () => void; showToast: (m: string, e?: boolean) => void }): JSX.Element {
  const [mode, setMode] = useState<'setup' | 'url'>('setup')
  const [value, setValue] = useState('')
  const [fileBrowser, setFileBrowser] = useState(false)
  const [busy, setBusy] = useState(false)
  const connect = async () => {
    if (!value.trim()) return showToast('Paste a URL first', true)
    setBusy(true)
    const args = mode === 'setup' ? ['connect', '--setup-url', value.trim(), path] : ['connect', '--url', value.trim(), path]
    if (fileBrowser) args.push('--file-browser')
    const r = await window.api.runCli(args)
    if (r.code !== 0) { setBusy(false); return showToast(r.stderr || 'Connect failed', true) }
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
    setBusy(false)
    onDone()
  }
  const trapRef = useFocusTrap<HTMLDivElement>()
  return (
    <div className="modal-bg" onClick={onClose} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="modal" ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="connect-modal-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="connect-modal-title">Connect to pixel-office</h3>
        <p style={{ marginTop: 0, fontSize: 12, color: 'var(--fg2)', lineHeight: 1.5 }}>
          Links this local agent to a character in your pixel office. Open the office in your browser, pick the character, and copy its <em>signed setup URL</em> (or a full ws:// URL) here.
        </p>
        <label className="field"><span className="lbl">Binding</span>
          <select autoFocus value={mode} onChange={(e) => setMode(e.target.value as 'setup' | 'url')}>
            <option value="setup">Signed setup URL (from the office UI)</option>
            <option value="url">Full ws:// URL (token + endpoint)</option>
          </select>
        </label>
        <label className="field"><span className="lbl">{mode === 'setup' ? 'Setup URL' : 'WebSocket URL'}</span>
          <textarea rows={3} value={value} placeholder={mode === 'setup' ? 'https://…/api/cli/setup/…?signature=…' : 'wss://host/ws?token=…&endpoint=…'} onChange={(e) => setValue(e.target.value)} />
        </label>
        <label className="check" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0 10px', cursor: 'pointer' }}>
          <input type="checkbox" checked={fileBrowser} onChange={(e) => setFileBrowser(e.target.checked)} />
          <span>Enable file browser <span style={{ color: 'var(--fg2,#8b95a7)', fontSize: 12 }}>— browse & edit this agent's files from the office</span></span>
        </label>
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</button>
        </div>
      </div>
    </div>
  )
}

function CreateModal({ onClose, onCreated, showToast }: { onClose: () => void; onCreated: (p: string) => void; showToast: (m: string, e?: boolean) => void }): JSX.Element {
  const [path, setPath] = useState('')
  const [provider, setProvider] = useState('claude-tui')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  // When the chosen folder is already an AutoDev agent, we must NOT re-init it
  // (that overwrites its settings + office binding) — we connect it instead.
  const [existing, setExisting] = useState<{ provider?: string; sessionName?: string } | null>(null)

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
    setBusy(false)
    if (r.code !== 0) return showToast(r.stderr || 'init failed', true)
    await window.api.addAgent(path)
    onCreated(path)
  }

  const trapRef = useFocusTrap<HTMLDivElement>()
  return (
    <div className="modal-bg" onClick={onClose} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="modal" ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="create-modal-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="create-modal-title">{existing ? 'Connect existing agent' : 'Create agent'}</h3>
        <label className="field"><span className="lbl">Workspace folder</span>
          <div className="row"><input autoFocus value={path} placeholder="/path/to/workspace" onChange={(e) => setPath(e.target.value)} /><button onClick={pick}>Browse</button></div>
        </label>
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
            <label className="field"><span className="lbl">Session name (optional)</span>
              <input value={name} placeholder="My Agent" onChange={(e) => setName(e.target.value)} />
            </label>
          </>
        )}
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={submit}>{busy ? (existing ? 'Connecting…' : 'Creating…') : (existing ? 'Connect' : 'Create')}</button>
        </div>
      </div>
    </div>
  )
}
