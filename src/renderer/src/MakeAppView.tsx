import { useEffect, useState, useCallback } from 'react'

interface RosterAgent { name: string; role?: string; emoji: string; color: string }
/** Per-agent editable fields the user can tweak before spawning. */
interface AgentEdit { name: string; role?: string; emoji: string; color: string; provider: string; model: string }

const PROVIDER_GROUPS: Array<{ vendor: string; options: Array<{ id: string; label: string }> }> = [
  { vendor: 'Claude', options: [{ id: 'claude-tui', label: 'Claude — interactive' }, { id: 'claude-cli', label: 'Claude — CLI' }] },
  { vendor: 'GitHub Copilot', options: [{ id: 'copilot-cli', label: 'Copilot — CLI' }, { id: 'copilot-sdk', label: 'Copilot — SDK' }] },
  { vendor: 'OpenCode', options: [{ id: 'opencode-cli', label: 'OpenCode — CLI' }, { id: 'opencode-sdk', label: 'OpenCode — SDK' }] },
  { vendor: 'Grok', options: [{ id: 'grok-cli', label: 'Grok — CLI' }, { id: 'grok-tui', label: 'Grok — interactive' }] }
]
const MODEL_KEY: Record<string, string> = { claude: 'claudeModel', opencode: 'opencodeModel', copilot: 'copilotModel', grok: 'grokModel' }
const modelKeyFor = (p: string): string => MODEL_KEY[p.split('-')[0]] ?? 'claudeModel'
const slugify = (s: string, i: number): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `agent-${i + 1}`

/** Derive a short, human office name from a free-text description. */
function deriveName(desc: string): string {
  const clean = desc.replace(/[\r\n]+/g, ' ').trim()
  if (!clean) return 'New App'
  const words = clean.split(/\s+/).slice(0, 4).join(' ')
  const n = words.replace(/[^\w .-]+/g, '').slice(0, 40).trim()
  return n || 'New App'
}

/**
 * "Spawn agents" flow: describe what you want → generate a team, tweak each
 * agent's NAME and MODEL, then either open the office in the browser OR spawn the
 * team as LOCAL autodev agents into a folder you pick (one workspace per agent).
 * Reuses the pixel-office connection (prompts login first if not connected).
 */
export default function MakeAppView(): JSX.Element {
  const [connected, setConnected] = useState(false)
  const [base, setBase] = useState('https://autodev.code.aioffice.works')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const [desc, setDesc] = useState('')
  const [count, setCount] = useState(4)
  const [defaultProvider, setDefaultProvider] = useState('claude-tui')
  const [creating, setCreating] = useState(false)
  const [office, setOffice] = useState<{ slug: string; id: number; name: string } | null>(null)
  const [edits, setEdits] = useState<AgentEdit[] | null>(null)
  const [folder, setFolder] = useState('')
  const [spawning, setSpawning] = useState(false)
  const [spawnMsg, setSpawnMsg] = useState('')

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
    setCreating(true); setErr(''); setOffice(null); setEdits(null); setSpawnMsg('')
    try {
      const name = deriveName(desc)
      const oc = (await window.api.officeCreateOffice(name, desc.trim())) as
        { ok?: boolean; office?: { slug: string; id: number; name: string }; error?: string }
      if (oc?.error || !oc?.office) { setErr(oc?.error || 'Could not create the office.'); setCreating(false); return }
      setOffice(oc.office)
      const gt = (await window.api.officeGenerateTeam(oc.office.id, desc.trim(), count)) as
        { ok?: boolean; agents?: RosterAgent[]; error?: string }
      if (gt?.error) { setErr(gt.error); setEdits([]); setCreating(false); return }
      // Seed each agent's editable name + model, defaulting the provider.
      setEdits((gt.agents ?? []).map((a) => ({ name: a.name, role: a.role, emoji: a.emoji, color: a.color, provider: defaultProvider, model: '' })))
    } catch (e: any) {
      setErr(e?.message || 'Something went wrong.')
    }
    setCreating(false)
  }, [desc, count, defaultProvider])

  const patchEdit = (i: number, p: Partial<AgentEdit>): void =>
    setEdits((prev) => prev ? prev.map((e, k) => (k === i ? { ...e, ...p } : e)) : prev)

  const pickFolder = useCallback(async () => {
    const f = await window.api.pickFolder()
    if (f) setFolder(f)
  }, [])

  // Spawn each edited agent as a LOCAL autodev workspace under the chosen folder.
  const spawnLocal = useCallback(async () => {
    if (!edits?.length) return
    if (!folder) { setErr('Pick a folder to spawn the agents into first.'); return }
    setSpawning(true); setErr(''); setSpawnMsg('')
    let ok = 0
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]
      const path = `${folder.replace(/\/+$/, '')}/${slugify(e.name, i)}`
      const args = ['init', path, '--provider', e.provider]
      if (e.name.trim()) args.push('--session-name', e.name.trim())
      const r = await window.api.runCli(args)
      if (r.code !== 0) continue
      if (e.model.trim()) await window.api.runCli(['config', 'set', modelKeyFor(e.provider), e.model.trim(), path])
      const added = await window.api.addAgent(path)
      if (!(added as { error?: string })?.error) ok++
    }
    setSpawning(false)
    setSpawnMsg(`Spawned ${ok}/${edits.length} agent${edits.length === 1 ? '' : 's'} into ${folder}. They're in your sidebar — Start them there.`)
  }, [edits, folder])

  const openSetup = useCallback(() => {
    if (!office) return
    window.api.openExternal(`${base.replace(/\/+$/, '')}/office/${office.slug}/setup`)
  }, [base, office])

  const reset = useCallback(() => { setOffice(null); setEdits(null); setDesc(''); setErr(''); setSpawnMsg(''); setFolder('') }, [])

  // ── not connected: login form ──
  if (!connected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <form onSubmit={(e) => { e.preventDefault(); void connect() }} style={{ width: 340, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: 20 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>🐣 Spawn agents</h2>
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--muted)' }}>Describe what you want built and generate a team. Sign in first.</p>
          <label className="fld" htmlFor="makeapp-base">Server URL</label>
          <input className="fld-input" id="makeapp-base" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://…" style={inp} />
          <label className="fld" htmlFor="makeapp-email">Email</label>
          <input className="fld-input" id="makeapp-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={inp} />
          <label className="fld" htmlFor="makeapp-password">Password</label>
          <input className="fld-input" id="makeapp-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={inp} />
          {err && <div role="alert" style={{ color: 'var(--red)', fontSize: 12, margin: '6px 0' }}>{err}</div>}
          <button className="primary" type="submit" style={{ width: '100%', marginTop: 10 }} disabled={busy || !email || !password}>{busy ? 'Connecting…' : 'Connect'}</button>
          <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--muted)' }}>
            New here? <a href="#" onClick={(e) => { e.preventDefault(); if (base.trim()) void window.api.openExternal(base.trim()) }} style={{ color: 'var(--accent)' }}>Open the office</a> to create an account.
          </p>
        </form>
      </div>
    )
  }

  // ── connected: spawn-agents form + editable roster ──
  return (
    <div style={{ display: 'flex', justifyContent: 'center', height: '100%', overflow: 'auto' }}>
      <div style={{ width: 620, maxWidth: '100%', padding: 24 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>🐣 Spawn agents</h2>
        <p style={{ margin: '0 0 18px', fontSize: 12, color: 'var(--muted)' }}>
          Describe your idea, generate a team, tweak each agent's name and model, then spawn them locally or open the office.
        </p>

        <label className="fld">What do you want to build?</label>
        <textarea className="fld-input" value={desc} onChange={(e) => setDesc(e.target.value)}
          placeholder="e.g. A recipe app that suggests meals from ingredients I have at home"
          rows={4} style={{ ...inp, resize: 'vertical', minHeight: 90 }} disabled={creating} />

        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <div>
            <label className="fld">Team size</label>
            <input className="fld-input" type="number" min={1} max={12} value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(12, parseInt(e.target.value) || 1)))}
              style={{ ...inp, width: 90, marginBottom: 0 }} disabled={creating} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="fld">Default provider (editable per agent)</label>
            <select className="fld-input" value={defaultProvider} onChange={(e) => setDefaultProvider(e.target.value)} style={{ ...inp, marginBottom: 0 }} disabled={creating}>
              {PROVIDER_GROUPS.map((g) => <optgroup key={g.vendor} label={g.vendor}>{g.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</optgroup>)}
            </select>
          </div>
        </div>

        {err && <div role="alert" style={{ color: 'var(--red)', fontSize: 12, margin: '10px 0 0' }}>{err}</div>}

        {!edits && (
          <button className="primary" style={{ width: '100%', marginTop: 12 }} disabled={creating || !desc.trim()} onClick={make}>
            {creating ? (office ? 'Assembling team…' : 'Creating office…') : '🐣 Generate team'}
          </button>
        )}

        {edits && office && (
          <div style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <strong style={{ fontSize: 14 }}>{office.name}</strong>
              <span className="badge">{edits.length} agents</span>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>— edit names &amp; models below</span>
            </div>
            {edits.length === 0 && <div className="empty" style={{ fontSize: 12, padding: 12 }}>No team was generated — you can still set it up in the browser.</div>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {edits.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                  <span title={a.role} style={{ width: 30, height: 30, flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, fontSize: 16, background: (a.color || '#2a3350') + '22', border: `1px solid ${a.color || '#2a3350'}` }}>{a.emoji || '🧑'}</span>
                  <input className="fld-input" value={a.name} onChange={(e) => patchEdit(i, { name: e.target.value })} aria-label={`Agent ${i + 1} name`}
                    style={{ ...inp, margin: 0, flex: '1 1 140px', minWidth: 100 }} disabled={spawning} />
                  <select className="fld-input" value={a.provider} onChange={(e) => patchEdit(i, { provider: e.target.value })} aria-label={`Agent ${i + 1} provider`}
                    style={{ ...inp, margin: 0, flex: '0 0 150px' }} disabled={spawning}>
                    {PROVIDER_GROUPS.map((g) => <optgroup key={g.vendor} label={g.vendor}>{g.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</optgroup>)}
                  </select>
                  <input className="fld-input" value={a.model} onChange={(e) => patchEdit(i, { model: e.target.value })} placeholder="default model" aria-label={`Agent ${i + 1} model`}
                    style={{ ...inp, margin: 0, flex: '0 0 130px' }} disabled={spawning} />
                </div>
              ))}
            </div>

            {edits.length > 0 && (
              <div style={{ marginTop: 16, padding: 14, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                <label className="fld">Spawn locally — folder (one workspace per agent is created here)</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="fld-input" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/path/to/folder" style={{ ...inp, margin: 0, flex: 1 }} disabled={spawning} />
                  <button onClick={pickFolder} disabled={spawning}>Browse</button>
                </div>
                <button className="primary" style={{ width: '100%', marginTop: 10 }} disabled={spawning || !folder} onClick={spawnLocal}>
                  {spawning ? 'Spawning…' : `🐣 Spawn ${edits.length} agent${edits.length === 1 ? '' : 's'} into folder`}
                </button>
                {spawnMsg && <div role="status" style={{ color: 'var(--green)', fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>{spawnMsg}</div>}
              </div>
            )}

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

// Match the app-wide input styling (styles.css `input,select,textarea`) so these
// inline-styled fields read as the same control set as the rest of the app.
const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', marginBottom: 8, padding: '8px 10px',
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--fg)', fontSize: 13
}
