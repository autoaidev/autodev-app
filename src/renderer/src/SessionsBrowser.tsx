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

export default function SessionsBrowser(): JSX.Element {
  const [list, setList] = useState<SessionMeta[]>([])
  const [sel, setSel] = useState<SessionMeta | null>(null)
  const [msgs, setMsgs] = useState<SessionMsg[]>([])
  const [loading, setLoading] = useState(true)
  const [term, setTerm] = useState<{ id: string; cwd: string } | null>(null)
  const selFile = useRef<string | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    const l = (await window.api.sessionsDiscover()) as SessionMeta[]
    setList(l); setLoading(false)
  }, [])

  useEffect(() => { refresh(); const id = setInterval(refresh, 5000); return () => clearInterval(id) }, [refresh])

  // live tail: append incoming lines for the currently-open transcript
  useEffect(() => {
    const off = window.api.onSessionData(({ file, msgs: incoming }: { file: string; msgs: SessionMsg[] }) => {
      if (file === selFile.current) setMsgs((m) => [...m, ...incoming])
    })
    return off
  }, [])

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [msgs])

  const openSession = useCallback(async (s: SessionMeta) => {
    setTerm(null)
    if (selFile.current) await window.api.sessionClose(selFile.current)
    selFile.current = s.file
    setSel(s)
    const bl = (await window.api.sessionBacklog(s.file)) as SessionMsg[]
    setMsgs(bl)
    await window.api.sessionOpen(s.file)
  }, [])

  const spawnClaude = useCallback(async () => {
    const cwd = (await window.api.pickFolder()) as string | null
    if (!cwd) return
    if (selFile.current) { await window.api.sessionClose(selFile.current); selFile.current = null }
    setSel(null); setMsgs([])
    setTerm({ id: `pty-${Date.now()}`, cwd })
  }, [])

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
          <button onClick={refresh} title="Rescan">↻</button>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {loading && <div className="empty" style={{ padding: 20, fontSize: 12 }}>Scanning ~/.claude…</div>}
          {!loading && list.length === 0 && <div className="empty" style={{ padding: 20, fontSize: 12 }}>No Claude sessions found on this machine.</div>}
          {list.map((s) => (
            <div key={s.file} onClick={() => openSession(s)}
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
              <span className="badge" style={{ background: '#12351f', color: '#7ee2a0' }}>● claude</span>
              <div style={{ fontSize: 12, color: 'var(--muted,#8b949e)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{term.cwd}</div>
              <div style={{ flex: 1 }} />
              <button className="danger" onClick={() => setTerm(null)} title="End session &amp; close pane">■ Close</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, background: '#0d1117' }}>
              <TerminalPane key={term.id} id={term.id} cwd={term.cwd} command="claude" onExit={() => refresh()} />
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
              <button onClick={() => window.api.openPath(sel.cwd)} title="Open workspace folder">📁 Open</button>
            </div>
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
