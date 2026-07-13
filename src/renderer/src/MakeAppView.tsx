import { useEffect, useState, useCallback } from 'react'

interface RosterAgent { name: string; role?: string; emoji: string; color: string }

/** Derive a short, human office name from a free-text description. */
function deriveName(desc: string): string {
  const clean = desc.replace(/[\r\n]+/g, ' ').trim()
  if (!clean) return 'New App'
  const words = clean.split(/\s+/).slice(0, 4).join(' ')
  const n = words.replace(/[^\w .-]+/g, '').slice(0, 40).trim()
  return n || 'New App'
}

/**
 * "✨ Make app" flow: describe what you want → we create an office and
 * AI-generate a team, then hand off to the office setup page in the browser.
 * Reuses the pixel-office connection (prompts login first if not connected).
 */
export default function MakeAppView(): JSX.Element {
  const [connected, setConnected] = useState(false)
  const [base, setBase] = useState('https://autodev.code.aioffice.works')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // make-app form
  const [desc, setDesc] = useState('')
  const [count, setCount] = useState(4)
  const [creating, setCreating] = useState(false)
  const [office, setOffice] = useState<{ slug: string; id: number; name: string } | null>(null)
  const [roster, setRoster] = useState<RosterAgent[] | null>(null)

  useEffect(() => {
    (async () => {
      const st = (await window.api.officeStatus()) as { connected: boolean; base: string; email?: string }
      if (st.base) setBase(st.base)
      if (st.email) setEmail(st.email)
      const ok = st.connected || (await window.api.officeAutoConnect())
      setConnected(!!ok)
    })()
  }, [])

  const connect = useCallback(async () => {
    setBusy(true); setErr('')
    const r = (await window.api.officeLogin(base, email, password)) as { ok?: boolean; error?: string }
    setBusy(false)
    if (r?.error) { setErr(r.error); return }
    setPassword(''); setConnected(true)
    const st = (await window.api.officeStatus()) as { base: string }
    if (st.base) setBase(st.base)
  }, [base, email, password])

  const make = useCallback(async () => {
    if (!desc.trim()) { setErr('Describe what you want to build first.'); return }
    setCreating(true); setErr(''); setOffice(null); setRoster(null)
    try {
      const name = deriveName(desc)
      const oc = (await window.api.officeCreateOffice(name, desc.trim())) as
        { ok?: boolean; office?: { slug: string; id: number; name: string }; error?: string }
      if (oc?.error || !oc?.office) { setErr(oc?.error || 'Could not create the office.'); setCreating(false); return }
      setOffice(oc.office)
      const gt = (await window.api.officeGenerateTeam(oc.office.id, desc.trim(), count)) as
        { ok?: boolean; agents?: RosterAgent[]; error?: string }
      if (gt?.error) { setErr(gt.error); setRoster([]); setCreating(false); return }
      setRoster(gt.agents ?? [])
    } catch (e: any) {
      setErr(e?.message || 'Something went wrong.')
    }
    setCreating(false)
  }, [desc, count])

  const openSetup = useCallback(() => {
    if (!office) return
    window.api.openExternal(`${base.replace(/\/+$/, '')}/office/${office.slug}/setup`)
  }, [base, office])

  const reset = useCallback(() => { setOffice(null); setRoster(null); setDesc(''); setErr('') }, [])

  // ── not connected: login form (mirrors the pixel-office connect) ──
  if (!connected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <div style={{ width: 340, background: '#111725', border: '1px solid var(--border)', borderRadius: 10, padding: 20 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>✨ Make an app</h2>
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--muted,#8b949e)' }}>Sign in to your pixel-office first, then describe what you want to build.</p>
          <label className="fld" htmlFor="makeapp-base">Server URL</label>
          <input id="makeapp-base" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://…" style={inp} />
          <label className="fld" htmlFor="makeapp-email">Email</label>
          <input id="makeapp-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={inp} />
          <label className="fld" htmlFor="makeapp-password">Password</label>
          <input id="makeapp-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && connect()} style={inp} />
          {err && <div role="alert" style={{ color: '#ff8b80', fontSize: 12, margin: '6px 0' }}>{err}</div>}
          <button className="primary" style={{ width: '100%', marginTop: 10 }} disabled={busy || !email || !password} onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</button>
        </div>
      </div>
    )
  }

  // ── connected: make-app form + generated roster ──
  return (
    <div style={{ display: 'flex', justifyContent: 'center', height: '100%', overflow: 'auto' }}>
      <div style={{ width: 560, maxWidth: '100%', padding: 24 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>✨ Make an app</h2>
        <p style={{ margin: '0 0 18px', fontSize: 12, color: 'var(--muted,#8b949e)' }}>
          Describe your idea and we spin up an office with an AI-picked team to build it.
        </p>

        <label className="fld">What do you want to build?</label>
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="e.g. A recipe app that suggests meals from ingredients I have at home"
          rows={4}
          style={{ ...inp, resize: 'vertical', minHeight: 90 }}
          disabled={creating}
        />

        <label className="fld">Team size</label>
        <input
          type="number" min={1} max={12} value={count}
          onChange={(e) => setCount(Math.max(1, Math.min(12, parseInt(e.target.value) || 1)))}
          style={{ ...inp, width: 100 }}
          disabled={creating}
        />

        {err && <div style={{ color: '#ff8b80', fontSize: 12, margin: '6px 0' }}>{err}</div>}

        {!roster && (
          <button className="primary" style={{ width: '100%', marginTop: 12 }} disabled={creating || !desc.trim()} onClick={make}>
            {creating ? (office ? 'Assembling team…' : 'Creating office…') : '✨ Make it'}
          </button>
        )}

        {roster && office && (
          <div style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <strong style={{ fontSize: 14 }}>{office.name}</strong>
              <span className="badge">{roster.length} agents</span>
            </div>
            {roster.length === 0 && <div className="empty" style={{ fontSize: 12, padding: 12 }}>No team was generated — you can still set it up in the browser.</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {roster.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#111725', border: '1px solid var(--border)', borderRadius: 8 }}>
                  <span style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, fontSize: 16, background: (a.color || '#2a3350') + '22', border: `1px solid ${a.color || '#2a3350'}` }}>{a.emoji || '🧑'}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{a.name}</div>
                    {a.role && <div style={{ fontSize: 11, color: 'var(--muted,#8b949e)' }}>{a.role}</div>}
                  </div>
                  <span className="dot" style={{ background: a.color || '#484f58' }} />
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="primary" style={{ flex: 1 }} onClick={openSetup}>↗ Open in browser</button>
              <button onClick={reset} title="Start another">＋ New</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', marginBottom: 8, padding: '7px 9px',
  background: '#1b2233', border: '1px solid #2a3350', borderRadius: 6, color: '#e6edf3', fontSize: 13
}
