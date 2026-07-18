import { useEffect, useRef, useState, useCallback } from 'react'
import TerminalPane from './TerminalPane'

interface SessionMeta {
  id: string; file: string; project: string; cwd: string
  title: string; mtime: number; sizeKb: number; msgs: number; live: boolean
}
interface SessionMsg { role: 'user' | 'assistant' | 'tool' | 'system'; text: string; ts?: number }

function ago(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
const base = (p: string): string => p.replace(/\/+$/, '').split('/').filter(Boolean).pop() || p

export default function SessionsBrowser({ visible = true }: { visible?: boolean }): JSX.Element {
  const [list, setList] = useState<SessionMeta[]>([])
  const [sel, setSel] = useState<SessionMeta | null>(null)
  const [msgs, setMsgs] = useState<SessionMsg[]>([])
  const [loading, setLoading] = useState(true)
  const [term, setTerm] = useState<{ id: string; cwd: string; command?: string; name?: string } | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)
  const [offices, setOffices] = useState<{ slug: string; id: number; name: string }[]>([])
  const [officeSel, setOfficeSel] = useState('')
  const [connectErr, setConnectErr] = useState('')
  const [connectBusy, setConnectBusy] = useState(false)
  const selFile = useRef<string | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    const l = (await window.api.sessionsDiscover()) as SessionMeta[]
    setList(l); setLoading(false)
  }, [])

  // Rescan on open and every 5s WHILE visible. The view stays mounted across tab
  // switches now (so a live Resume PTY survives), so a hidden tab shouldn't keep
  // rescanning ~/.claude in the background; it resumes the moment it's shown again.
  useEffect(() => { if (!visible) return; refresh(); const id = setInterval(refresh, 5000); return () => clearInterval(id) }, [refresh, visible])

  // live tail: append incoming lines for the currently-open transcript
  useEffect(() => {
    const off = window.api.onSessionData(({ file, msgs: incoming }: { file: string; msgs: SessionMsg[] }) => {
      // Cap retained messages so a long-running "live" session can't grow the
      // DOM / memory without bound (mirrors the 20k-char cap on agent logs).
      if (file === selFile.current) setMsgs((m) => {
        const next = [...m, ...incoming]
        return next.length > 1000 ? next.slice(-1000) : next
      })
    })
    return off
  }, [])

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [msgs])

  const openSession = useCallback(async (s: SessionMeta) => {
    // Update the UI immediately (before any await) so the click always feels live.
    const prev = selFile.current
    selFile.current = s.file
    setTerm(null)
    setSel(s)
    setMsgs([])
    try {
      if (prev && prev !== s.file) await window.api.sessionClose(prev)
      setMsgs((await window.api.sessionBacklog(s.file)) as SessionMsg[])
      await window.api.sessionOpen(s.file)
    } catch (e) { console.error('[openSession]', e) }
  }, [])

  const spawnClaude = useCallback(async () => {
    const cwd = (await window.api.pickFolder()) as string | null
    if (!cwd) return
    if (selFile.current) { await window.api.sessionClose(selFile.current); selFile.current = null }
    setSel(null); setMsgs([])
    setTerm({ id: `pty-${Date.now()}`, cwd })
  }, [])

  const openConnect = useCallback(async () => {
    const st = await window.api.officeStatus()
    // office._authed is in-memory and resets every launch; the Sessions tab may be
    // opened before the Pixel Office tab ever runs autoConnect. Try the durable
    // token here before wrongly claiming "not connected".
    if (!st.connected) {
      const ok = await window.api.officeAutoConnect()
      if (!ok) { setConnectErr('Connect a pixel-office first (☁ Pixel Office tab).'); setConnectOpen(true); return }
    }
    // officeOffices() THROWS on a dead session / network error (it doesn't return
    // {error}). Without this guard the whole handler rejects and the Connect modal
    // never opens — the button silently does nothing. Open it either way and show
    // the reason.
    let offs: { slug: string; id: number; name: string }[] = []
    try {
      offs = await window.api.officeOffices() as { slug: string; id: number; name: string }[]
    } catch (e) {
      setConnectErr(String((e as Error)?.message ?? e) || 'Could not load your offices — reconnect.')
      setOffices([]); setConnectOpen(true); return
    }
    setOffices(offs); setOfficeSel(offs[0]?.slug ?? ''); setConnectErr(''); setConnectOpen(true)
  }, [])

  const confirmConnect = useCallback(async () => {
    const off = offices.find((o) => o.slug === officeSel); if (!off || !sel) return
    setConnectBusy(true); setConnectErr('')
    const r = await window.api.officeConnectSession(off.slug, off.id, sel.cwd, sel.id, sel.title) as any
    setConnectBusy(false)
    if (r?.error) { setConnectErr(r.error); return }
    setConnectOpen(false)
    if (selFile.current) { await window.api.sessionClose(selFile.current); selFile.current = null }
    setSel(null); setMsgs([])
    setTerm({ id: `op-${Date.now()}`, cwd: r.cwd, command: `claude --resume ${r.sessionId}`, name: `${r.agentName} · live` })
  }, [offices, officeSel, sel])

  useEffect(() => () => { if (selFile.current) window.api.sessionClose(selFile.current) }, [])

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* session list */}
      <div style={{ width: 320, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 13 }}>🗂 Claude sessions</strong>
          <span className="badge">{list.length}</span>
          <div style={{ flex: 1 }} />
          <button className="primary" onClick={spawnClaude} title="Spawn a new interactive Claude session in a folder">＋ Spawn Claude</button>
          <button onClick={refresh} title="Rescan sessions" aria-label="Rescan sessions">↻</button>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {loading && <div className="empty" style={{ padding: 20, fontSize: 12 }}>Scanning ~/.claude…</div>}
          {!loading && list.length === 0 && <div className="empty" style={{ padding: 20, fontSize: 12 }}>No Claude sessions found on this machine.</div>}
          {list.map((s) => (
            <div key={s.file} role="button" tabIndex={0} aria-pressed={sel?.file === s.file}
              onClick={() => openSession(s)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSession(s) } }}
              className={'agent-row' + (sel?.file === s.file ? ' active' : '')}
              style={{ display: 'block', padding: '8px 12px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="dot" style={{ background: s.live ? 'var(--green,#3fb950)' : '#484f58' }} title={s.live ? 'live' : 'idle'} />
                <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</span>
                {s.live && <span className="badge" style={{ background: '#12351f', color: '#7ee2a0' }}>live</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted,#8b949e)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                📁 {base(s.cwd)} · {s.msgs} msgs · {ago(s.mtime)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* right pane: spawned terminal, or transcript reader */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {term && (
          <>
            <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="badge" style={{ background: '#12351f', color: '#7ee2a0' }}>● {term.name ?? 'claude'}</span>
              <div style={{ fontSize: 12, color: 'var(--muted,#8b949e)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{term.cwd}</div>
              <div style={{ flex: 1 }} />
              <button className="danger" onClick={() => setTerm(null)} title="End session &amp; close pane">■ Close</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, background: '#0d1117' }}>
              <TerminalPane key={term.id} id={term.id} cwd={term.cwd} command={term.command ?? 'claude'} keepShell={term.command ? false : undefined} onExit={() => refresh()} />
            </div>
          </>
        )}
        {!term && !sel && <div className="empty" style={{ margin: 'auto' }}>Select a session to capture &amp; stream it live<br />— or <b>＋ Spawn Claude</b> to start a new one</div>}
        {!term && sel && (
          <>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sel.title}</div>
                <div style={{ fontSize: 11, color: 'var(--muted,#8b949e)' }}>{sel.cwd} · {sel.id.slice(0, 8)}</div>
              </div>
              {sel.live && <span className="badge" style={{ background: '#12351f', color: '#7ee2a0' }}>● live</span>}
              <div style={{ flex: 1 }} />
              <button onClick={openConnect} title="Bind this session to a pixel office and resume it live as an agent">☁ Connect to office</button>
              <button onClick={() => window.api.openPath(sel.cwd)} title="Open workspace folder">📁 Open</button>
            </div>
            {connectOpen && (
              <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', background: '#0d1117' }}>
                <span id="connect-office-label" style={{ fontSize: 12, color: 'var(--muted,#8b949e)' }}>☁ Resume live as a character in:</span>
                <select aria-labelledby="connect-office-label" value={officeSel} onChange={(e) => setOfficeSel(e.target.value)} style={{ fontSize: 12, padding: '3px 6px' }}>
                  {offices.length === 0 && <option value="">(no offices)</option>}
                  {offices.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
                </select>
                <button className="primary" onClick={confirmConnect} disabled={connectBusy || !officeSel}>{connectBusy ? 'Connecting…' : 'Connect & resume live'}</button>
                <button onClick={() => setConnectOpen(false)}>Cancel</button>
                {connectErr && <span role="alert" style={{ fontSize: 12, color: '#f85149' }}>{connectErr}</span>}
              </div>
            )}
            <div ref={bodyRef} style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {msgs.length === 0 && <div className="empty" style={{ fontSize: 12 }}>(empty transcript)</div>}
              {msgs.map((m, i) => (
                <div key={i} style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                  background: m.role === 'user' ? '#16324a' : m.role === 'assistant' ? '#1b2230' : 'transparent',
                  border: m.role === 'system' ? '1px dashed var(--border)' : '1px solid var(--border)',
                  borderRadius: 8, padding: '6px 10px', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  color: m.role === 'system' ? 'var(--muted,#8b949e)' : 'var(--text,#e6edf3)'
                }}>
                  <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted,#8b949e)', marginBottom: 2 }}>{m.role}</div>
                  {m.text}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
