import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import SessionsBrowser from './SessionsBrowser'
import PixelOfficeView from './PixelOfficeView'
import MakeAppView from './MakeAppView'

type Activity = 'working' | 'idle' | 'stopped'
interface AgentState {
  path: string
  name: string
  provider?: string
  sessionName?: string
  wsUrl?: string
  running: boolean
  activity: Activity
  tasks: { total: number; remaining: number; done: number }
  lastOutput?: string
}

const PROVIDERS = ['claude-tui', 'claude-cli', 'copilot-cli', 'copilot-sdk', 'opencode-cli', 'opencode-sdk', 'grok-tui']

// Visually-hidden but screen-reader-available (for persistent aria-live regions).
const srOnly: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0
}

export default function App(): JSX.Element {
  const [agents, setAgents] = useState<AgentState[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [showSessions, setShowSessions] = useState(false)
  const [showOffice, setShowOffice] = useState(false)
  const [showMakeApp, setShowMakeApp] = useState(false)
  const [tab, setTab] = useState<'overview' | 'output' | 'sessions' | 'todo' | 'config'>('overview')
  const [creating, setCreating] = useState(false)
  const [connectFor, setConnectFor] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)
  const [cliMissing, setCliMissing] = useState(false)
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
  useEffect(() => { window.api.cliCheck().then((c: { found: boolean }) => setCliMissing(!c.found)) }, [])

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
  const stop = async (a: AgentState) => { await window.api.stopAgent(a.path) }

  const exportAgent = async (a: AgentState) => {
    const out = await window.api.saveFile(`${a.name.replace(/[^\w.-]+/g, '_')}.zip`)
    if (!out) return
    showToast('Exporting…')
    const r = await window.api.runCli(['export', a.path, '--output', out])
    if (r.code !== 0) showToast(r.stderr || 'Export failed', true)
    else showToast(`Exported → ${out}`)
  }

  const importAgent = async () => {
    const zip = await window.api.pickFile([{ name: 'Agent backup', extensions: ['zip'] }])
    if (!zip) return
    const dest = await window.api.pickFolder()
    if (!dest) return
    showToast('Importing…')
    const r = await window.api.runCli(['import', zip, dest])
    if (r.code !== 0) return showToast(r.stderr || 'Import failed', true)
    await window.api.addAgent(dest); await refresh(); setSelected(dest); showToast('Imported')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {cliMissing && (
        <div style={{ background: '#3d1c1c', borderBottom: '1px solid var(--red)', color: '#ffb4b0', padding: '8px 16px', fontSize: 12, flex: '0 0 auto' }}>
          ⚠ The <code>autodev</code> CLI was not found. Place <code>autodev-cli</code> beside the app or set the <code>AUTODEV_CLI_JS</code> environment variable to <code>autodev-cli/bin/autodev.js</code>.
        </div>
      )}
      <div className="app" style={{ flex: 1, minHeight: 0 }}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1><span className="logo">◆</span> AutoDev{runningCount > 0 && <span className="badge" style={{ marginLeft: 8 }}>{runningCount} running</span>}</h1>
          <div className="row">
            <button title="Add existing workspace" onClick={addExisting}>+ Add</button>
            <button title="Import agent backup" onClick={importAgent}>⬆</button>
          </div>
        </div>
        <div className="agent-list">
          {agents.length === 0 && <div className="empty" style={{ padding: 24, fontSize: 12 }}>No agents yet.<br />Create or add one.</div>}
          {agents.map((a) => (
            <div key={a.path} role="button" tabIndex={0} aria-pressed={a.path === selected}
              className={'agent-row' + (a.path === selected ? ' active' : '')}
              onClick={() => setSelected(a.path)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(a.path) } }}>
              <span className={'dot ' + a.activity} title={a.activity} />
              <div className="meta">
                <div className="name">{a.name}</div>
                <div className="sub">{a.provider ?? 'no provider'} · {a.tasks.remaining} left</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button style={{ width: '100%', background: showMakeApp ? 'var(--accent-dim,#1f6feb33)' : undefined, borderColor: showMakeApp ? 'var(--accent,#388bfd)' : undefined }}
            onClick={() => { setShowMakeApp((s) => !s); setShowOffice(false); setShowSessions(false) }} title="Describe an app and generate an office team to build it">✨ Make app</button>
          <button style={{ width: '100%', background: showOffice ? 'var(--accent-dim,#1f6feb33)' : undefined, borderColor: showOffice ? 'var(--accent,#388bfd)' : undefined }}
            onClick={() => { setShowOffice((s) => !s); setShowSessions(false); setShowMakeApp(false) }} title="Connect & operate your remote pixel-office agents">☁ Pixel Office</button>
          <button style={{ width: '100%', background: showSessions ? 'var(--accent-dim,#1f6feb33)' : undefined, borderColor: showSessions ? 'var(--accent,#388bfd)' : undefined }}
            onClick={() => { setShowSessions((s) => !s); setShowOffice(false); setShowMakeApp(false) }} title="Capture Claude sessions on this machine">🗂 Claude sessions</button>
          <button className="primary" style={{ width: '100%' }} onClick={() => setCreating(true)}>＋ Create agent</button>
        </div>
      </aside>

      <main className="main">
        {showMakeApp && <MakeAppView />}
        {showOffice && <PixelOfficeView />}
        {showSessions && <SessionsBrowser />}
        {!showMakeApp && !showOffice && !showSessions && !current && <div className="empty">Select an agent</div>}
        {!showMakeApp && !showOffice && !showSessions && current && (
          <>
            <div className="detail-head">
              <span className={'dot ' + current.activity} />
              <div>
                <h2>{current.name}</h2>
                <div className="path">{current.path}</div>
              </div>
              <span className="badge">{current.provider ?? '—'}</span>
              {current.wsUrl && <span className="badge">● office</span>}
              <div className="spacer" />
              {current.running
                ? <button className="danger" onClick={() => stop(current)}>■ Stop</button>
                : <button className="start" onClick={() => start(current)}>▶ Start</button>}
              <button title="Open workspace folder" onClick={() => window.api.openPath(current.path)}>📁 Open</button>
              <button title="Connect to pixel-office" onClick={() => setConnectFor(current.path)}>⚿ Connect</button>
              <button title="Export agent backup" onClick={() => exportAgent(current)}>⬇ Export</button>
              <button className="danger" title="Remove from list (does not delete files)" onClick={async () => { if (!window.confirm(`Remove "${current.name}" from the list? (workspace files are kept)`)) return; await window.api.removeAgent(current.path); setSelected(null); refresh() }}>Remove</button>
            </div>

            <div className="tabs" role="tablist">
              {(['overview', 'output', 'sessions', 'todo', 'config'] as const).map((t) => (
                <div key={t} role="tab" aria-selected={tab === t} tabIndex={tab === t ? 0 : -1}
                  className={'tab' + (tab === t ? ' active' : '')}
                  onClick={() => setTab(t)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>
                  {t[0].toUpperCase() + t.slice(1)}
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

            <MessageBar key={current.path} path={current.path} running={current.running} showToast={showToast} />
          </>
        )}
      </main>

      {creating && <CreateModal onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); refresh().then(() => setSelected(p)) }} showToast={showToast} />}
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
function MessageBar({ path, running, showToast }: { path: string; running: boolean; showToast: (m: string, e?: boolean) => void }): JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (): Promise<void> => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    const r = await window.api.sendAgentMessage(path, t) as { ok?: boolean; error?: string }
    setBusy(false)
    if (r?.error) { showToast(r.error, true); return }
    setText('')
    showToast(running ? 'Sent — the agent will pick it up shortly.' : 'Queued — the agent will act on it when you Start it.')
  }
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
  }
  return (
    <div className="msgbar">
      <textarea
        rows={1}
        value={text}
        aria-label="Message or task for this agent"
        placeholder="Send a message or task to this agent…  (Enter to send · Shift+Enter for newline)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <button className="primary" disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? '…' : '➤ Send'}</button>
    </div>
  )
}

function Overview({ a }: { a: AgentState }): JSX.Element {
  return (
    <>
      <div className="cards">
        <div className="card"><div className="k">Status</div><div className="v" style={{ textTransform: 'capitalize' }}>{a.activity}</div></div>
        <div className="card"><div className="k">Remaining</div><div className="v">{a.tasks.remaining}</div></div>
        <div className="card"><div className="k">Done</div><div className="v">{a.tasks.done}</div></div>
        <div className="card"><div className="k">Total</div><div className="v">{a.tasks.total}</div></div>
      </div>
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
  const load = useCallback(() => {
    setSessions(null)
    // Scope to the agent's configured provider so the list matches the selection
    // (grok agent → grok sessions, opencode → opencode, …). The listing itself
    // lives in the CLI (`autodev sessions --provider`) so it's shared, not duped.
    const args = provider ? ['sessions', path, '--provider', provider, '--json'] : ['sessions', path, '--json']
    window.api.runCli(args).then((r) => {
      try { setSessions(JSON.parse(r.stdout || '[]')) } catch { setSessions([]) }
    })
  }, [path, provider])
  useEffect(() => { load() }, [load])
  if (sessions === null) return <div style={{ color: 'var(--fg2)' }}>Loading sessions…</div>
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <strong>{sessions.length} session{sessions.length === 1 ? '' : 's'}</strong>
        <div className="spacer" />
        <button onClick={load}>↻ Refresh</button>
      </div>
      {sessions.length === 0 && <div style={{ color: 'var(--fg2)' }}>No inspectable sessions for this workspace yet.</div>}
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
    await window.api.runCli(['config', 'set', 'provider', provider, a.path])
    if (sessionName !== (a.sessionName ?? '')) await window.api.runCli(['config', 'set', 'sessionName', sessionName, a.path])
    await window.api.runCli(['config', 'set', modelKeyFor(provider), model, a.path])
    await window.api.runCli(['config', 'set', 'enableFileBrowser', fileBrowser ? 'true' : 'false', a.path])
    setBusy(false); showToast('Saved'); onSaved()
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
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>{PROVIDERS.map((p) => <option key={p}>{p}</option>)}</select>
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
        <button onClick={() => setShowMcp((s) => !s)}>{showMcp ? '▾' : '▸'} MCP servers (.mcp.json)</button>
        {showMcp && (
          <div style={{ marginTop: 10 }}>
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
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Connect to pixel-office</h3>
        <label className="field"><span className="lbl">Binding</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as 'setup' | 'url')}>
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

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{existing ? 'Connect existing agent' : 'Create agent'}</h3>
        <label className="field"><span className="lbl">Workspace folder</span>
          <div className="row"><input value={path} placeholder="/path/to/workspace" onChange={(e) => setPath(e.target.value)} /><button onClick={pick}>Browse</button></div>
        </label>
        {existing ? (
          <div className="field" style={{ background: '#0d2a17', border: '1px solid #16653a', borderRadius: 6, padding: '8px 10px', color: '#86efac', fontSize: 12 }}>
            ✓ This folder already has an agent{existing.provider ? ` (${existing.provider}` : ''}{existing.provider && existing.sessionName ? ` · ${existing.sessionName})` : existing.provider ? ')' : ''}.<br />
            Its settings will be kept — it'll just be connected.
          </div>
        ) : (
          <>
            <label className="field"><span className="lbl">Provider</span>
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>{PROVIDERS.map((p) => <option key={p}>{p}</option>)}</select>
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
