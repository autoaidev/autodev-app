import { useEffect, useMemo, useRef, useState, useCallback } from 'react'

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

const PROVIDERS = ['claude-cli', 'claude-tui', 'copilot-cli', 'copilot-sdk', 'opencode-cli', 'opencode-sdk', 'grok-tui']

export default function App(): JSX.Element {
  const [agents, setAgents] = useState<AgentState[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'overview' | 'output' | 'todo' | 'config'>('overview')
  const [creating, setCreating] = useState(false)
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)
  const logsRef = useRef<Map<string, string>>(new Map())
  const [logTick, setLogTick] = useState(0)

  const refresh = useCallback(async () => {
    const list = await window.api.listAgents()
    setAgents(list)
    setSelected((s) => s ?? (list[0]?.path ?? null))
  }, [])

  useEffect(() => { refresh() }, [refresh])

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

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1><span className="logo">◆</span> AutoDev</h1>
          <div className="row">
            <button title="Add existing workspace" onClick={addExisting}>+ Add</button>
          </div>
        </div>
        <div className="agent-list">
          {agents.length === 0 && <div className="empty" style={{ padding: 24, fontSize: 12 }}>No agents yet.<br />Create or add one.</div>}
          {agents.map((a) => (
            <div key={a.path} className={'agent-row' + (a.path === selected ? ' active' : '')} onClick={() => setSelected(a.path)}>
              <span className={'dot ' + a.activity} title={a.activity} />
              <div className="meta">
                <div className="name">{a.name}</div>
                <div className="sub">{a.provider ?? 'no provider'} · {a.tasks.remaining} left</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
          <button className="primary" style={{ width: '100%' }} onClick={() => setCreating(true)}>＋ Create agent</button>
        </div>
      </aside>

      <main className="main">
        {!current && <div className="empty">Select an agent</div>}
        {current && (
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
              <button className="danger" title="Remove from list" onClick={async () => { await window.api.removeAgent(current.path); setSelected(null); refresh() }}>Remove</button>
            </div>

            <div className="tabs">
              {(['overview', 'output', 'todo', 'config'] as const).map((t) => (
                <div key={t} className={'tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</div>
              ))}
            </div>

            <div className="panel">
              {tab === 'overview' && <Overview a={current} />}
              {tab === 'output' && <Output key={logTick} text={logsRef.current.get(current.path) || current.lastOutput || 'No output yet. Start the agent.'} />}
              {tab === 'todo' && <TodoTab path={current.path} />}
              {tab === 'config' && <Config a={current} onSaved={refresh} showToast={showToast} />}
            </div>
          </>
        )}
      </main>

      {creating && <CreateModal onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); refresh().then(() => setSelected(p)) }} showToast={showToast} />}
      {toast && <div className={'toast' + (toast.err ? ' err' : '')}>{toast.msg}</div>}
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
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [text])
  return <pre className="output" ref={ref}>{text}</pre>
}

function TodoTab({ path }: { path: string }): JSX.Element {
  const [text, setText] = useState('Loading…')
  useEffect(() => {
    window.api.runCli(['status', path, '--all']).then((r) => setText((r.stdout || r.stderr || '').replace(/\x1b\[[0-9;]*m/g, '')))
  }, [path])
  return <pre className="todo">{text}</pre>
}

function Config({ a, onSaved, showToast }: { a: AgentState; onSaved: () => void; showToast: (m: string, e?: boolean) => void }): JSX.Element {
  const [provider, setProvider] = useState(a.provider ?? 'claude-cli')
  const [sessionName, setSessionName] = useState(a.sessionName ?? '')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    await window.api.runCli(['config', 'set', 'provider', provider, a.path])
    if (sessionName !== (a.sessionName ?? '')) await window.api.runCli(['config', 'set', 'sessionName', sessionName, a.path])
    setBusy(false); showToast('Saved'); onSaved()
  }
  return (
    <div style={{ maxWidth: 460 }}>
      <label className="field"><span className="lbl">Provider</span>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>{PROVIDERS.map((p) => <option key={p}>{p}</option>)}</select>
      </label>
      <label className="field"><span className="lbl">Session display name</span>
        <input value={sessionName} placeholder="(folder name)" onChange={(e) => setSessionName(e.target.value)} />
      </label>
      <button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
    </div>
  )
}

function CreateModal({ onClose, onCreated, showToast }: { onClose: () => void; onCreated: (p: string) => void; showToast: (m: string, e?: boolean) => void }): JSX.Element {
  const [path, setPath] = useState('')
  const [provider, setProvider] = useState('claude-cli')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const pick = async () => { const p = await window.api.pickFolder(); if (p) setPath(p) }
  const create = async () => {
    if (!path) return showToast('Pick a folder first', true)
    setBusy(true)
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
        <h3>Create agent</h3>
        <label className="field"><span className="lbl">Workspace folder</span>
          <div className="row"><input value={path} placeholder="/path/to/workspace" onChange={(e) => setPath(e.target.value)} /><button onClick={pick}>Browse</button></div>
        </label>
        <label className="field"><span className="lbl">Provider</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>{PROVIDERS.map((p) => <option key={p}>{p}</option>)}</select>
        </label>
        <label className="field"><span className="lbl">Session name (optional)</span>
          <input value={name} placeholder="My Agent" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </div>
  )
}
