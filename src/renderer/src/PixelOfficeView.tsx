import { useEffect, useRef, useState, useCallback } from 'react'
import TerminalPane from './TerminalPane'

interface OfficeAgent {
  office: string; officeSlug: string; id: string; name: string; slug: string; status?: string; online: boolean
}
interface OpenTerm { id: string; cwd: string; name: string; mcpUrl?: string; agentId: string }

const DEFAULT_BASE = 'https://autodev.code.aioffice.works'

/** True when an error means the session is dead and the user must sign in again. */
function isAuthError(msg: string): boolean {
  return /expired|reconnect|not connected|unauthenticated|\b401\b|\b419\b/i.test(msg)
}

export default function PixelOfficeView({ visible = true }: { visible?: boolean }): JSX.Element {
  const [connected, setConnected] = useState(false)
  const [base, setBase] = useState(DEFAULT_BASE)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')           // login-form error
  const [listErr, setListErr] = useState('')    // agents-list / operate error (connected view)
  const [agents, setAgents] = useState<OfficeAgent[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadingAgents, setLoadingAgents] = useState(false)
  const [operatingId, setOperatingId] = useState('')
  const [term, setTerm] = useState<OpenTerm | null>(null)
  const [ended, setEnded] = useState(false) // the operate session's `claude` exited
  // Instant-message (steer) composer for the operated office character.
  const [steerText, setSteerText] = useState('')
  const [steerBusy, setSteerBusy] = useState(false)
  const [steerMsg, setSteerMsg] = useState('')
  // "New character" (spawn an office agent from the app).
  const [offices, setOffices] = useState<{ slug: string; id: number; name: string }[]>([])
  const [newCharName, setNewCharName] = useState('')
  const [newCharOffice, setNewCharOffice] = useState<number | ''>('')
  const [creatingChar, setCreatingChar] = useState(false)
  const [createMsg, setCreateMsg] = useState('')
  const inFlight = useRef(false)
  // Mirror `term` into a ref so the background poll can tell whether a live PTY is
  // running WITHOUT re-creating (and re-scheduling) itself on every open/close.
  const termRef = useRef<OpenTerm | null>(null)
  useEffect(() => { termRef.current = term }, [term])

  const EXPIRED = 'Your office session expired — please sign in again.'

  const loadAgents = useCallback(async () => {
    setLoadingAgents(true); setListErr('')
    try {
      setAgents((await window.api.officeAgents()) as OfficeAgent[])
      setLoaded(true)
      // Populate the office picker for "New character" (best-effort; the list
      // still works without it).
      try {
        const offs = (await window.api.officeOffices()) as { slug: string; id: number; name: string }[]
        setOffices(offs)
        setNewCharOffice((prev) => (prev === '' && offs[0] ? offs[0].id : prev))
      } catch { /* non-fatal */ }
    } catch (e: any) {
      const msg = e?.message || 'Failed to load agents'
      if (isAuthError(msg)) {
        // Try one silent recovery with the durable token before demanding a
        // password; only bounce to the login form (with a shown reason) if it
        // fails. Previously the reason went to listErr, which the login form
        // never renders — the user landed on a blank Connect screen.
        try {
          if (await window.api.officeAutoConnect()) {
            setAgents((await window.api.officeAgents()) as OfficeAgent[])
            setLoaded(true); setLoadingAgents(false); return
          }
        } catch { /* fall through to login */ }
        // Don't tear down a live operate/resume PTY (see pollAgents): it holds its
        // own office key. Show a soft hint instead of bouncing to the login form.
        if (termRef.current) { setListErr('Office session needs reconnect — your running session is unaffected (use ↻ or ⏻ Disconnect).'); setLoadingAgents(false); return }
        setConnected(false); setLoaded(false); setErr(EXPIRED)
      } else {
        setListErr(msg)
      }
    }
    setLoadingAgents(false)
  }, [])

  // Silent background refresh so online dots stay fresh (esp. right after
  // Operate) without flashing the "Loading…" state or clobbering a shown error.
  const pollAgents = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      setAgents((await window.api.officeAgents()) as OfficeAgent[])
      setLoaded(true)
    } catch (e: any) {
      // A mid-session expiry (401) must NOT be swallowed — otherwise the view
      // keeps showing frozen green "online" dots for dead agents indefinitely and
      // never prompts a reconnect. Attempt one silent recovery with the durable
      // token; if that fails, bounce to the login form (the same branch loadAgents
      // uses) so stale online state stops being presented. Transient network
      // errors still fall through and keep the last-known list for the next tick.
      const msg = e?.message || ''
      if (isAuthError(msg)) {
        let recovered = false
        try { recovered = !!(await window.api.officeAutoConnect()) } catch { /* fall through */ }
        if (recovered) {
          try { setAgents((await window.api.officeAgents()) as OfficeAgent[]); setLoaded(true); return }
          catch { /* fall through to the bounce/guard below */ }
        }
        // A running operate/resume PTY authenticates via the office API key baked
        // into its own .mcp.json — independent of this browser cookie. A routine
        // list-refresh auth bounce must NEVER swap the view to the login form and
        // unmount (SIGKILL) that live session. Surface a soft reconnect hint and
        // leave the terminal running; the user can ↻/Reconnect deliberately.
        if (termRef.current) { setListErr('Office session needs reconnect — your running session is unaffected (use ↻ or ⏻ Disconnect).'); return }
        setConnected(false); setLoaded(false); setErr(EXPIRED)
      }
    }
    finally { inFlight.current = false }
  }, [])

  // While connected AND on-screen, poll every 8s and on window focus; cleared on
  // disconnect or when the view is hidden. The view now stays mounted across tab
  // switches (so its live Operate PTY survives), so gating on `visible` stops a
  // hidden tab from polling in the background.
  useEffect(() => {
    if (!connected || !visible) return
    const id = setInterval(pollAgents, 8000)
    const onFocus = (): void => { void pollAgents() }
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus) }
  }, [connected, visible, pollAgents])

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
    await window.api.officeLogout(); setConnected(false); setAgents([]); setLoaded(false); setTerm(null); setListErr('')
  }, [])

  const operate = useCallback(async (a: OfficeAgent) => {
    const rid = a.officeSlug + a.id
    if (operatingId) return // guard against duplicate in-flight operate calls
    setListErr(''); setOperatingId(rid)
    try {
      const r = (await window.api.officeOperate(a.officeSlug, a.id, a.slug)) as { ok?: boolean; cwd?: string; mcpUrl?: string; error?: string }
      if (r?.error || !r?.cwd) {
        // Don't swallow a 401 as a generic list error — the session is dead, so
        // bounce to the login form with a reason instead of staying falsely
        // connected while every subsequent call also 401s.
        if (r?.error && isAuthError(r.error)) { setConnected(false); setLoaded(false); setErr(EXPIRED) }
        else setListErr(r?.error || 'Could not prepare the operate workspace')
        return
      }
      setEnded(false)
      setTerm({ id: `op-${Date.now()}`, cwd: r.cwd, mcpUrl: r.mcpUrl, name: `${a.name} · ${a.office}`, agentId: a.id })
      // Reconcile the left-list online dot within one tick rather than waiting up
      // to 8s for the next poll (silent — no "Loading…" flash).
      void pollAgents()
    } finally { setOperatingId('') }
  }, [operatingId, pollAgents])

  // Send an INSTANT message (steer) to the operated office character — live, not a
  // queued TODO task (that is the local-agent composer's job).
  const sendSteer = useCallback(async () => {
    const t = termRef.current
    const text = steerText.trim()
    if (!t || !text || steerBusy) return
    setSteerBusy(true); setSteerMsg('')
    try {
      const r = (await window.api.officeSteer(t.agentId, text)) as { ok?: boolean; error?: string }
      if (r?.ok) { setSteerText(''); setSteerMsg('⚡ delivered') }
      else setSteerMsg(r?.error || 'Could not deliver — is the character online?')
    } catch (e) { setSteerMsg(String((e as Error)?.message ?? e)) }
    finally { setSteerBusy(false) }
  }, [steerText, steerBusy])

  // Spawn a new office character from the app (the in-app "+ Agent"), then refresh
  // the list so the user can Operate it right away.
  const createChar = useCallback(async () => {
    const name = newCharName.trim()
    if (!name || newCharOffice === '' || creatingChar) return
    setCreatingChar(true); setCreateMsg('')
    try {
      const r = (await window.api.officeCreateCharacter(Number(newCharOffice), name)) as { ok?: boolean; error?: string }
      if (r?.ok) { setNewCharName(''); setCreateMsg(`✓ created “${name}”`); void loadAgents() }
      else setCreateMsg(r?.error || 'Could not create the character')
    } catch (e) { setCreateMsg(String((e as Error)?.message ?? e)) }
    finally { setCreatingChar(false) }
  }, [newCharName, newCharOffice, creatingChar, loadAgents])

  // ── not connected: login form ──
  if (!connected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <form onSubmit={(e) => { e.preventDefault(); void connect() }} style={{ width: 340, background: '#111725', border: '1px solid var(--border)', borderRadius: 10, padding: 20 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>☁ Connect to your Pixel Office</h2>
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--muted,#8b949e)' }}>A Pixel Office is your team of remote agents. Sign in to list and operate them.</p>
          <label className="fld" htmlFor="office-base">Server URL</label>
          <input id="office-base" value={base} onChange={(e) => setBase(e.target.value)} placeholder={DEFAULT_BASE} style={inp} />
          <label className="fld" htmlFor="office-email">Email</label>
          <input id="office-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={inp} />
          <label className="fld" htmlFor="office-password">Password</label>
          <input id="office-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={inp} />
          {err && <div role="alert" style={{ color: '#ff8b80', fontSize: 12, margin: '6px 0' }}>{err}</div>}
          <button className="primary" type="submit" style={{ width: '100%', marginTop: 10 }} disabled={busy || !email || !password || !base}>{busy ? 'Connecting…' : 'Connect'}</button>
          <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--muted,#8b949e)' }}>
            New here? <a href="#" onClick={(e) => { e.preventDefault(); if (base.trim()) void window.api.openExternal(base.trim()) }} style={{ color: 'var(--accent)' }}>Open the office</a> to create an account. Stores the durable login token locally (not your password).
          </p>
        </form>
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
          <button onClick={loadAgents} disabled={loadingAgents} title="Refresh office agents" aria-label="Refresh office agents">↻</button>
          <button className="danger" title="Disconnect from office" aria-label="Disconnect from office"
            onClick={() => { if (term && !window.confirm(`Disconnect will end your running Operate session for "${term.name}" and take the character offline. Continue?`)) return; disconnect() }}>⏻</button>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {/* Spawn a new office character from the app (goal: "spawn agents from
              the app") — creates the character server-side, then Operate it. */}
          <form
            onSubmit={(e) => { e.preventDefault(); void createChar() }}
            style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}
          >
            <input
              value={newCharName}
              onChange={(e) => { setNewCharName(e.target.value); if (createMsg) setCreateMsg('') }}
              placeholder="New character name…"
              aria-label="New character name"
              maxLength={20}
              disabled={creatingChar}
              className="fld-input"
              style={{ flex: 1, minWidth: 110, background: '#0d1117', color: 'var(--fg,#e6edf3)', border: '1px solid var(--border,#30363d)', borderRadius: 6, padding: '6px 9px', fontSize: 12 }}
            />
            <select
              value={newCharOffice}
              onChange={(e) => setNewCharOffice(e.target.value ? Number(e.target.value) : '')}
              aria-label="Office for the new character"
              disabled={creatingChar || offices.length === 0}
              style={{ background: '#0d1117', color: 'var(--fg,#e6edf3)', border: '1px solid var(--border,#30363d)', borderRadius: 6, padding: '6px 8px', fontSize: 12 }}
            >
              {offices.length === 0 && <option value="">(no office)</option>}
              {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <button className="start" type="submit" disabled={creatingChar || !newCharName.trim() || newCharOffice === ''}>{creatingChar ? '…' : '＋ New character'}</button>
            {createMsg && <span style={{ flexBasis: '100%', fontSize: 11, color: createMsg.startsWith('✓') ? 'var(--green,#3fb950)' : '#f85149' }}>{createMsg}</span>}
          </form>
          {listErr && (
            <div role="alert" style={{ margin: 10, padding: '8px 10px', background: '#3b0d0d', color: '#fecaca', fontSize: 12, borderRadius: 6, border: '1px solid #7f1d1d' }}>
              {listErr}
              <div style={{ marginTop: 6 }}>
                <button onClick={loadAgents}>↻ Retry</button>
                <button style={{ marginLeft: 6 }} onClick={disconnect}>Reconnect</button>
              </div>
            </div>
          )}
          {loadingAgents && <div className="empty" style={{ padding: 20, fontSize: 12 }}>Loading…</div>}
          {!loadingAgents && !listErr && loaded && agents.length === 0 && (
            <div className="empty" style={{ padding: 20, fontSize: 12 }}>No agents in your offices yet.</div>
          )}
          {agents.map((a) => (
            <div key={a.officeSlug + a.id} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="dot" style={{ background: a.online ? 'var(--green,#3fb950)' : '#484f58' }} title={a.online ? 'online' : 'offline'} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</div>
                <div style={{ fontSize: 11, color: 'var(--muted,#8b949e)' }}>{a.office}{a.status ? ' · ' + a.status : ''}</div>
              </div>
              <button className="start" onClick={() => operate(a)} disabled={operatingId === a.officeSlug + a.id} title="Wire a local Claude session to this office character via MCP">{operatingId === a.officeSlug + a.id ? 'operating…' : '▶ Operate'}</button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {!term && (
          <div className="empty" style={{ margin: 'auto', maxWidth: 420, textAlign: 'center', lineHeight: 1.6 }}>
            <div style={{ fontSize: 22 }}>▶</div>
            <strong>Operate an office agent</strong><br />
            Wires a scratch workspace to that character's office-MCP and opens a
            local Claude terminal here. While the session runs, the character shows
            as MCP-connected (online) in the office.
          </div>
        )}
        {term && (
          <>
            <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {ended
                ? <span className="badge" style={{ background: '#3b0d0d', color: '#fecaca' }}>■ session ended — reopen</span>
                // Drive the badge from the character's REAL online state (pollAgents
                // keeps `agents` fresh), not merely "a PTY is open": until the office
                // MCP actually registers the character, show "connecting…".
                : agents.find((a) => a.id === term.agentId)?.online
                  ? <span className="badge" style={{ background: '#12351f', color: '#7ee2a0' }}>● operating (MCP)</span>
                  : <span className="badge" style={{ background: '#3a2f0a', color: '#f2cc60' }}>◐ connecting…</span>}
              <div style={{ fontSize: 12, fontWeight: 600 }}>{term.name}</div>
              <div style={{ flex: 1 }} />
              <button className="danger" title="End session"
                onClick={() => { if (!window.confirm(`End the Operate session for "${term.name}"? The character goes offline.`)) return; setTerm(null) }}>■ Close</button>
              <div style={{ flexBasis: '100%', fontSize: 10, color: 'var(--muted,#8b949e)', fontFamily: 'monospace' }}>
                {term.cwd}{term.mcpUrl ? '  →  ' + term.mcpUrl : ''}
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, background: '#0d1117' }}>
              <TerminalPane key={term.id} id={term.id} cwd={term.cwd} command="claude" keepShell={false} onExit={() => { setEnded(true); void pollAgents() }} />
            </div>
            {/* Instant-message composer — steers this office character LIVE over its
                WS (POST /api/agents/{id}/steer), unlike the local-agent composer
                which only queues a TODO task. */}
            <form
              onSubmit={(e) => { e.preventDefault(); void sendSteer() }}
              style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--border)' }}
            >
              <span title="Instant message — steers this character live (mid-turn if supported)" style={{ fontSize: 13 }}>⚡</span>
              <input
                value={steerText}
                onChange={(e) => { setSteerText(e.target.value); if (steerMsg) setSteerMsg('') }}
                placeholder={`Instant-message ${term.name.split(' · ')[0]} now…  (Enter to send)`}
                aria-label="Instant message to this office character"
                disabled={steerBusy}
                className="fld-input"
                style={{ flex: 1, background: '#0d1117', color: 'var(--fg,#e6edf3)', border: '1px solid var(--border,#30363d)', borderRadius: 6, padding: '7px 10px', fontSize: 13 }}
              />
              {steerMsg && <span style={{ fontSize: 11, color: steerMsg.startsWith('⚡') ? 'var(--green,#3fb950)' : '#f85149', whiteSpace: 'nowrap' }}>{steerMsg}</span>}
              <button className="start" type="submit" disabled={steerBusy || !steerText.trim()}>{steerBusy ? '…' : '⚡ Send'}</button>
            </form>
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
