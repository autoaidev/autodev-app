import { useEffect, useState, useCallback } from 'react'
import OfficeSelector from './OfficeSelector'
import FileBrowserCheckbox from './FileBrowserCheckbox'
import { useOfficeSelection, NEW_OFFICE } from './composables/useOfficeSelection'

interface RosterAgent { id?: string; slug?: string; name: string; role?: string; emoji: string; color: string }
/** Per-agent editable fields the user can tweak before spawning. `id`/`slug` are
 *  the office character identity (present on the office-backed path) — needed to
 *  fetch each agent's MCP credentials for the single-shared-folder spawn. */
interface AgentEdit { id?: string; slug?: string; name: string; role?: string; emoji: string; color: string; provider: string; model: string }

const PROVIDER_GROUPS: Array<{ vendor: string; options: Array<{ id: string; label: string }> }> = [
  { vendor: 'Claude', options: [{ id: 'claude-tui', label: 'Claude — interactive' }, { id: 'claude-cli', label: 'Claude — CLI' }] },
  { vendor: 'GitHub Copilot', options: [{ id: 'copilot-cli', label: 'Copilot — CLI' }, { id: 'copilot-sdk', label: 'Copilot — SDK' }] },
  { vendor: 'OpenCode', options: [{ id: 'opencode-cli', label: 'OpenCode — CLI' }, { id: 'opencode-sdk', label: 'OpenCode — SDK' }] },
  { vendor: 'Grok', options: [{ id: 'grok-cli', label: 'Grok — CLI' }, { id: 'grok-tui', label: 'Grok — interactive' }] }
]
const MODEL_KEY: Record<string, string> = { claude: 'claudeModel', opencode: 'opencodeModel', copilot: 'copilotModel', grok: 'grokModel' }
const modelKeyFor = (p: string): string => MODEL_KEY[p.split('-')[0]] ?? 'claudeModel'
const slugify = (s: string, i: number): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `agent-${i + 1}`

/**
 * Generic team blueprint used when the user opts OUT of a pixel office. Team
 * generation is an office-backed AI call, so with no office we build a local
 * default roster instead (documented behavior — see the checkbox comment below).
 */
const DEFAULT_ROLES: Array<{ role: string; emoji: string; color: string }> = [
  { role: 'Product Lead', emoji: '🧭', color: '#6366f1' },
  { role: 'Frontend Engineer', emoji: '🎨', color: '#0ea5e9' },
  { role: 'Backend Engineer', emoji: '⚙️', color: '#22c55e' },
  { role: 'QA Engineer', emoji: '🧪', color: '#f59e0b' },
  { role: 'DevOps Engineer', emoji: '🚀', color: '#ef4444' },
  { role: 'Designer', emoji: '✏️', color: '#ec4899' },
  { role: 'Docs Writer', emoji: '📝', color: '#14b8a6' },
  { role: 'Data Engineer', emoji: '🗄️', color: '#8b5cf6' }
]
function defaultRoster(count: number, provider: string): AgentEdit[] {
  return Array.from({ length: Math.max(1, count) }, (_, i) => {
    const r = DEFAULT_ROLES[i % DEFAULT_ROLES.length]
    const rev = Math.floor(i / DEFAULT_ROLES.length)
    const name = rev === 0 ? r.role : `${r.role} ${rev + 1}`
    return { name, role: r.role, emoji: r.emoji, color: r.color, provider, model: '' }
  })
}

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
  // Shared pixel-office selection state (connection probe, office list, checkbox,
  // selected office) — same composable the Create dialog uses.
  const officeSel = useOfficeSelection({ defaultUseOffice: true, defaultSelection: NEW_OFFICE })
  const { connected, offices, loadOffices, useOffice, selectedOfficeId, setSelectedOfficeId } = officeSel
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
  const [sharedFolder, setSharedFolder] = useState(false) // Bug 2: one folder, all agents in a single .mcp.json
  const [fileBrowser, setFileBrowser] = useState(false)   // enable the office file-browser for EVERY spawned agent (both modes)
  const [spawning, setSpawning] = useState(false)
  const [spawnMsg, setSpawnMsg] = useState('')
  const [wired, setWired] = useState(false)          // shared-folder .mcp.json was written → offer "add to sidebar"
  const [addingSidebar, setAddingSidebar] = useState(false)

  // Seed the login form's base/email from the shared office session (the
  // composable owns `connected`; this only fills in display defaults).
  useEffect(() => {
    (async () => {
      const st = (await window.api.officeStatus()) as { base?: string; email?: string }
      if (st.base) setBase(st.base)
      if (st.email) setEmail(st.email)
    })()
  }, [])

  const connect = useCallback(async () => {
    setBusy(true); setErr('')
    const r = (await window.api.officeLogin(base, email, password)) as { ok?: boolean; error?: string }
    setBusy(false)
    if (r?.error) { setErr(r.error); return }
    setPassword(''); officeSel.setConnected(true)
    const st = (await window.api.officeStatus()) as { base: string }
    if (st.base) setBase(st.base)
  }, [base, email, password, officeSel])

  const make = useCallback(async () => {
    if (!desc.trim()) { setErr('Describe what you want to build first.'); return }
    setCreating(true); setErr(''); setOffice(null); setEdits(null); setSpawnMsg('')
    try {
      // Local-only path (checkbox unchecked): no office, no AI call — build a
      // generic default roster the user can rename/re-model, then spawn purely
      // local workspaces (no office character, no wsUrl).
      if (!useOffice) {
        setOffice(null)
        setEdits(defaultRoster(count, defaultProvider))
        setCreating(false)
        return
      }

      // Office-backed path: resolve the TARGET office (existing pick, or a fresh
      // one created from the description) and generate the team INTO it.
      let target: { slug: string; id: number; name: string } | undefined
      if (selectedOfficeId === NEW_OFFICE) {
        const name = deriveName(desc)
        const oc = (await window.api.officeCreateOffice(name, desc.trim())) as
          { ok?: boolean; office?: { slug: string; id: number; name: string }; error?: string }
        if (oc?.error || !oc?.office) { setErr(oc?.error || 'Could not create the office.'); setCreating(false); return }
        target = oc.office
        void loadOffices()               // refresh the list so the new office appears…
        setSelectedOfficeId(String(target.id)) // …and select it for follow-up runs
      } else {
        target = offices.find((o) => String(o.id) === selectedOfficeId)
        if (!target) { setErr('Pick an office to generate the team into.'); setCreating(false); return }
      }
      setOffice(target)
      const gt = (await window.api.officeGenerateTeam(target.id, desc.trim(), count)) as
        { ok?: boolean; agents?: RosterAgent[]; error?: string }
      if (gt?.error) { setErr(gt.error); setEdits([]); setCreating(false); return }
      // Seed each agent's editable name + model, defaulting the provider. Keep the
      // office character id/slug so single-shared-folder mode can wire each one.
      setEdits((gt.agents ?? []).map((a) => ({ id: a.id, slug: a.slug, name: a.name, role: a.role, emoji: a.emoji, color: a.color, provider: defaultProvider, model: '' })))
    } catch (e: any) {
      setErr(e?.message || 'Something went wrong.')
    }
    setCreating(false)
  }, [desc, count, defaultProvider, useOffice, selectedOfficeId, offices, loadOffices])

  const patchEdit = (i: number, p: Partial<AgentEdit>): void =>
    setEdits((prev) => prev ? prev.map((e, k) => (k === i ? { ...e, ...p } : e)) : prev)

  // Bug 1: keep the per-agent boxes in sync with the team-size input AFTER a roster
  // already exists. Growing APPENDS fresh default rows (same naming/emoji/color/
  // provider convention defaultRoster uses for those indices); shrinking TRIMS from
  // the end — either way every already-edited row is preserved. Generating still
  // (re)creates the roster from scratch. Min 1, max 12 (matches the input bounds).
  const changeCount = (raw: number): void => {
    const n = Math.max(1, Math.min(12, raw || 1))
    setCount(n)
    setEdits((prev) => {
      if (!prev || n === prev.length) return prev
      if (n < prev.length) return prev.slice(0, n) // trim from the end, keep edits
      const filled = defaultRoster(n, defaultProvider) // canonical rows for every index
      return [...prev, ...filled.slice(prev.length)]   // append only the NEW indices
    })
  }

  const pickFolder = useCallback(async () => {
    const f = await window.api.pickFolder()
    if (f) { setFolder(f); setWired(false) }
  }, [])

  // The single-shared-folder toggle only makes sense when the roster agents are
  // office characters (they carry the id/slug + MCP key we wire into .mcp.json).
  const canShareFolder = !!office
  const shareMode = sharedFolder && canShareFolder

  // Spawn the edited roster into the chosen folder. Two modes:
  //  • default (per-agent): one autodev workspace per agent at folder/<slug(name)>.
  //  • single shared folder: NO per-agent workspaces — instead wire the ONE folder
  //    to every office character via a single folder/.mcp.json (one
  //    `pixel-office-<slug>` server each), so a claude launched there drives them all.
  const spawnLocal = useCallback(async (run = false) => {
    if (!edits?.length) return
    if (!folder) { setErr('Pick a folder to spawn the agents into first.'); return }
    setSpawning(true); setErr(''); setSpawnMsg('')

    // ── Single shared folder: merge one MCP server per character into folder/.mcp.json. ──
    if (shareMode && office) {
      const res = (await window.api.officeWriteSharedMcp(
        folder,
        office.slug,
        edits.map((e) => ({ id: e.id, slug: e.slug, name: e.name })),
        fileBrowser
      )) as { ok?: boolean; wired?: number; missing?: string[]; error?: string }
      setSpawning(false)
      if (res?.error) { setErr(res.error); return }
      const miss = res?.missing?.length ? ` (${res.missing.length} could not be matched)` : ''
      setWired(true)
      setSpawnMsg(`Wired ${res?.wired ?? 0}/${edits.length} agent${edits.length === 1 ? '' : 's'} from “${office.name}” into ${folder.replace(/\/+$/, '')}/.mcp.json${miss}. Add it to the sidebar below to run one loop that drives them all, or open the folder in claude yourself.`)
      return
    }

    // ── Default: one autodev workspace per agent. ──
    let ok = 0
    let started = 0
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]
      const path = `${folder.replace(/\/+$/, '')}/${slugify(e.name, i)}`
      const args = ['init', path, '--provider', e.provider]
      if (e.name.trim()) args.push('--session-name', e.name.trim())
      const r = await window.api.runCli(args)
      if (r.code !== 0) continue
      if (e.model.trim()) await window.api.runCli(['config', 'set', modelKeyFor(e.provider), e.model.trim(), path])
      // Enable the file browser per-workspace via the settings key (the init-flow
      // way the Create dialog uses) so each spawned agent gets the Files tab.
      if (fileBrowser) await window.api.runCli(['config', 'set', 'enableFileBrowser', 'true', path])
      const added = await window.api.addAgent(path)
      if ((added as { error?: string })?.error) continue
      ok++
      // Spawn & Run: kick off each agent's loop right after it's registered, so
      // the user doesn't have to Start all of them one by one in the sidebar.
      if (run) {
        const sr = await window.api.startAgent(path, e.provider) as { error?: string } | undefined
        if (!sr?.error) started++
      }
    }
    setSpawning(false)
    const where = office ? `Team from “${office.name}”.` : 'Local only — not attached to a pixel office.'
    setSpawnMsg(run
      ? `Spawned ${ok}/${edits.length} and started ${started} agent${started === 1 ? '' : 's'} into ${folder}. ${where} They're running in your sidebar.`
      : `Spawned ${ok}/${edits.length} agent${edits.length === 1 ? '' : 's'} into ${folder}. ${where} They're in your sidebar — Start them there.`)
  }, [edits, folder, office, shareMode, fileBrowser])

  // After a shared-folder wire, register that ONE folder as a single startable
  // workspace in the left sidebar. `autodev init` only writes TODO.md +
  // .autodev/settings.json + .gitignore — it never touches .mcp.json — so the
  // already-wired shared .mcp.json (the 6 pixel-office-<slug> servers) is
  // preserved, and the one loop started here gets all of them as tools to drive
  // the team. Provider = the top-level Default provider (the operator's model).
  const addSharedAsAgent = useCallback(async () => {
    if (!folder || !office) return
    setAddingSidebar(true); setErr(''); setSpawnMsg('')
    try {
      const path = folder.replace(/\/+$/, '')
      const r = await window.api.runCli(['init', path, '--provider', defaultProvider, '--session-name', office.name])
      if (r.code !== 0) { setErr(`Could not init the workspace at ${path}.${r.stderr ? ' ' + r.stderr.trim() : ''}`); return }
      // Re-wire (idempotent merge) so the shared .mcp.json is guaranteed intact
      // even if init wrote a .gitignore or the folder shifted underneath us.
      await window.api.officeWriteSharedMcp(path, office.slug, edits!.map((e) => ({ id: e.id, slug: e.slug, name: e.name })), fileBrowser)
      if (fileBrowser) await window.api.runCli(['config', 'set', 'enableFileBrowser', 'true', path])
      const added = await window.api.addAgent(path)
      if ((added as { error?: string })?.error) { setErr((added as { error: string }).error); return }
      setSpawnMsg(`Added “${office.name}” to your sidebar as one workspace at ${path}. Start it there — the single loop drives all ${edits!.length} agents via the shared .mcp.json.`)
    } finally { setAddingSidebar(false) }
  }, [folder, office, edits, defaultProvider, fileBrowser])

  const openSetup = useCallback(() => {
    if (!office) return
    window.api.openExternal(`${base.replace(/\/+$/, '')}/office/${office.slug}/setup`)
  }, [base, office])

  const reset = useCallback(() => { setOffice(null); setEdits(null); setDesc(''); setErr(''); setSpawnMsg(''); setFolder(''); setSharedFolder(false); setFileBrowser(false); setWired(false) }, [])

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

        {/* Office targeting — only meaningful (and only shown) while connected. Checked:
            generate/attach to a pixel office. Unchecked: local workspaces only. */}
        <OfficeSelector
          connected={connected}
          useOffice={useOffice}
          onToggle={officeSel.setUseOffice}
          offices={offices}
          selectedOfficeId={selectedOfficeId}
          onSelect={setSelectedOfficeId}
          disabled={creating}
          allowNewOffice
          newOfficeLabel="＋ New office (from description)"
          idPrefix="makeapp"
          uncheckedNote="Agents will be created as local workspaces only — not attached to any pixel office. A generic default team is used since AI team-generation is office-backed."
        />

        <label className="fld">What do you want to build?</label>
        <textarea className="fld-input" value={desc} onChange={(e) => setDesc(e.target.value)}
          placeholder="e.g. A recipe app that suggests meals from ingredients I have at home"
          rows={4} style={{ ...inp, resize: 'vertical', minHeight: 90 }} disabled={creating} />

        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <div>
            <label className="fld">Team size</label>
            <input className="fld-input" type="number" min={1} max={12} value={count}
              onChange={(e) => changeCount(parseInt(e.target.value) || 1)}
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
            {creating ? (useOffice && selectedOfficeId === NEW_OFFICE ? 'Creating office…' : 'Assembling team…') : '🐣 Generate team'}
          </button>
        )}

        {edits && (
          <div style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <strong style={{ fontSize: 14 }}>{office ? office.name : 'Local workspaces'}</strong>
              <span className="badge">{edits.length} agents</span>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>— edit names &amp; models below</span>
              {/* Persistent regenerate: re-runs `make` (same description + team size +
                  selected office) and REPLACES the roster with a fresh AI team. Kept
                  next to the badge so it's reachable after the first generation, when
                  the big "🐣 Generate team" primary is no longer rendered. */}
              <button style={{ marginLeft: 'auto', flex: '0 0 auto' }} disabled={creating || !desc.trim()} onClick={make}
                title="Generate a fresh team from the current description, team size & office">
                {creating ? (useOffice && selectedOfficeId === NEW_OFFICE ? 'Creating office…' : 'Assembling team…') : '🔄 Regenerate'}
              </button>
            </div>
            {edits.length === 0 && <div className="empty" style={{ fontSize: 12, padding: 12 }}>{office ? 'No team was generated — you can still set it up in the browser.' : 'No team was generated.'}</div>}

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
                <label className="fld">
                  {shareMode
                    ? 'Spawn locally — folder (all agents share ONE .mcp.json here)'
                    : 'Spawn locally — folder (one workspace per agent is created here)'}
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="fld-input" value={folder} onChange={(e) => { setFolder(e.target.value); setWired(false) }} placeholder="/path/to/folder" style={{ ...inp, margin: 0, flex: 1 }} disabled={spawning} />
                  <button onClick={pickFolder} disabled={spawning}>Browse</button>
                </div>
                {/* Bug 2: single-shared-folder mode. Only meaningful when the roster
                    agents are office characters — otherwise there's no office key to
                    wire, so hide it (and fall back to the per-agent path). */}
                {canShareFolder && (
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, fontSize: 12, cursor: spawning ? 'default' : 'pointer' }}>
                    <input type="checkbox" checked={sharedFolder} onChange={(e) => { setSharedFolder(e.target.checked); setWired(false) }} disabled={spawning} style={{ marginTop: 2 }} />
                    <span>
                      <strong>Single shared folder</strong> (all agents in one <code>.mcp.json</code>)
                      <span style={{ display: 'block', color: 'var(--muted)', marginTop: 2 }}>
                        Wires this one folder to every office character via a single <code>.mcp.json</code> — no per-agent workspaces or loops.
                      </span>
                    </span>
                  </label>
                )}
                {/* File browser applies to EVERY spawned agent — per-agent mode sets
                    enableFileBrowser on each workspace; single-folder mode passes
                    --file-browser to each pixel-office-<agent> mcp-operate entry. */}
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>Enable file browser for all agents</div>
                  <FileBrowserCheckbox checked={fileBrowser} onChange={setFileBrowser} disabled={spawning} id="makeapp-file-browser" />
                </div>
                <button className="primary" style={{ width: '100%', marginTop: 10 }} disabled={spawning || !folder} onClick={() => spawnLocal(false)}>
                  {spawning
                    ? (shareMode ? 'Wiring…' : 'Spawning…')
                    : shareMode
                      ? `🔌 Wire ${edits.length} agent${edits.length === 1 ? '' : 's'} into shared .mcp.json`
                      : `🐣 Spawn ${edits.length} agent${edits.length === 1 ? '' : 's'} into folder`}
                </button>
                {/* Per-agent mode only: spawn AND start every loop in one click so
                    the user doesn't have to Start each agent in the sidebar. Shared
                    mode has no per-agent loops, so it's not offered there. */}
                {!shareMode && (
                  <button className="primary" style={{ width: '100%', marginTop: 8, background: 'var(--green)', borderColor: 'var(--green)' }}
                    disabled={spawning || !folder} onClick={() => spawnLocal(true)}
                    title="Spawn each workspace and immediately start its loop">
                    {spawning ? 'Spawning & starting…' : `🚀 Spawn & Run ${edits.length} agent${edits.length === 1 ? '' : 's'}`}
                  </button>
                )}
                {/* After a shared wire: register the folder as ONE sidebar workspace
                    (single loop, driving all agents via the shared .mcp.json). */}
                {shareMode && wired && (
                  <button className="primary" style={{ width: '100%', marginTop: 8 }} disabled={addingSidebar} onClick={addSharedAsAgent}
                    title="Init this folder as one workspace and add it to the agents sidebar so you can Start a single loop that drives the whole team">
                    {addingSidebar ? 'Adding…' : `➕ Add to sidebar as one agent (drives all ${edits.length})`}
                  </button>
                )}
                {spawnMsg && <div role="status" style={{ color: 'var(--green)', fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>{spawnMsg}</div>}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              {office && <button className="primary" style={{ flex: 1 }} onClick={openSetup}>↗ Open in browser</button>}
              <button style={{ flex: office ? '0 0 auto' : 1 }} onClick={reset} title="Start another">＋ New</button>
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
