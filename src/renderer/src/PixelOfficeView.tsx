import { useEffect, useState, useCallback } from 'react'
import TerminalPane from './TerminalPane'

interface OfficeAgent {
  office: string; officeSlug: string; id: string; name: string; slug: string; status?: string; online: boolean
}
interface OpenTerm { id: string; cwd: string; name: string }

export default function PixelOfficeView(): JSX.Element {
  const [connected, setConnected] = useState(false)
  const [base, setBase] = useState('https://autodev.code.aioffice.works')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [agents, setAgents] = useState<OfficeAgent[]>([])
  const [loadingAgents, setLoadingAgents] = useState(false)
  const [term, setTerm] = useState<OpenTerm | null>(null)

  const loadAgents = useCallback(async () => {
    setLoadingAgents(true); setErr('')
    try { setAgents((await window.api.officeAgents()) as OfficeAgent[]) }
    catch (e: any) { setErr(e?.message || 'Failed to load agents') }
    setLoadingAgents(false)
  }, [])

  useEffect(() => {
    (async () => {
      const st = (await window.api.officeStatus()) as { connected: boolean; base: string; email?: string }
      if (st.base) setBase(st.base); if (st.email) setEmail(st.email)
      const ok = st.connected || (await window.api.officeAutoConnect())
      setConnected(!!ok)
      if (ok) loadAgents()
    })()
  }, [loadAgents])

  const connect = useCallback(async () => {
    setBusy(true); setErr('')
    const r = (await window.api.officeLogin(base, email, password)) as { ok?: boolean; error?: string }
    setBusy(false)
    if (r?.error) { setErr(r.error); return }
    setPassword(''); setConnected(true); loadAgents()
  }, [base, email, password, loadAgents])

  const disconnect = useCallback(async () => {
    await window.api.officeLogout(); setConnected(false); setAgents([]); setTerm(null)
  }, [])

  const operate = useCallback(async (a: OfficeAgent) => {
    setErr('')
    const r = (await window.api.officeOperate(a.officeSlug, a.id, a.slug)) as { ok?: boolean; cwd?: string; error?: string }
    if (r?.error || !r?.cwd) { setErr(r?.error || 'Could not prepare operate workspace'); return }
    setTerm({ id: `op-${Date.now()}`, cwd: r.cwd, name: `${a.name} · ${a.office}` })
  }, [])

  // ── not connected: login form ──
  if (!connected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <div style={{ width: 340, background: '#111725', border: '1px solid var(--border)', borderRadius: 10, padding: 20 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>☁ Connect a pixel-office</h2>
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--muted,#8b949e)' }}>Sign in to list and operate your remote office agents.</p>
          <label className="fld">Server URL</label>
          <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://…" style={inp} />
          <label className="fld">Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={inp} />
          <label className="fld">Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && connect()} style={inp} />
          {err && <div style={{ color: '#ff8b80', fontSize: 12, margin: '6px 0' }}>{err}</div>}
          <button className="primary" style={{ width: '100%', marginTop: 10 }} disabled={busy || !email || !password} onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</button>
          <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--muted,#8b949e)' }}>Stores the durable login token locally (not your password).</p>
        </div>
      </div>
    )
  }

  // ── connected: agents (left) + operate terminal (right) ──
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ width: 320, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 13 }}>☁ Office agents</strong>
          <span className="badge">{agents.length}</span>
          <div style={{ flex: 1 }} />
          <button onClick={loadAgents} title="Refresh">↻</button>
          <button className="danger" onClick={disconnect} title="Disconnect">⏻</button>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {loadingAgents && <div className="empty" style={{ padding: 20, fontSize: 12 }}>Loading…</div>}
          {!loadingAgents && agents.length === 0 && <div className="empty" style={{ padding: 20, fontSize: 12 }}>No agents in your offices yet.</div>}
          {agents.map((a) => (
            <div key={a.officeSlug + a.id} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="dot" style={{ background: a.online ? 'var(--green,#3fb950)' : '#484f58' }} title={a.online ? 'online' : 'offline'} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</div>
                <div style={{ fontSize: 11, color: 'var(--muted,#8b949e)' }}>{a.office}{a.status ? ' · ' + a.status : ''}</div>
              </div>
              <button className="start" onClick={() => operate(a)} title="Operate via a Claude session">▶ Operate</button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {err && <div style={{ background: '#3b0d0d', color: '#fecaca', fontSize: 12, padding: '6px 12px' }}>{err}</div>}
        {!term && <div className="empty" style={{ margin: 'auto' }}>▶ Operate an agent to drive it live via Claude<br />(it comes online in the office while the session runs)</div>}
        {term && (
          <>
            <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="badge" style={{ background: '#12351f', color: '#7ee2a0' }}>● operating</span>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{term.name}</div>
              <div style={{ flex: 1 }} />
              <button className="danger" onClick={() => setTerm(null)} title="End session">■ Close</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, background: '#0d1117' }}>
              <TerminalPane key={term.id} id={term.id} cwd={term.cwd} command="claude" onExit={loadAgents} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', marginBottom: 8, padding: '7px 9px',
  background: '#1b2233', border: '1px solid #2a3350', borderRadius: 6, color: '#e6edf3', fontSize: 13
}
