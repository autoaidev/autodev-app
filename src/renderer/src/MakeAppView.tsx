import { useEffect, useState, useCallback } from 'react'
import OfficeSelector from './OfficeSelector'
import FileBrowserCheckbox from './FileBrowserCheckbox'
import { SignInForm } from './components/office/SignInForm'
import { useOfficeSelection, NEW_OFFICE } from './composables/useOfficeSelection'
import { InfoTip } from '@renderer/ui'
import { useAppActions } from '@renderer/services/appActions'
import { PROVIDER_GROUPS, modelKeyFor, modelSuggestionsFor, slugify } from '@renderer/lib/providers'

interface RosterAgent { id?: string; slug?: string; name: string; role?: string; emoji: string; color: string }
/** Per-agent editable fields the user can tweak before spawning. `id`/`slug` are
 *  the office character identity (present on the office-backed path) — needed to
 *  fetch each agent's MCP credentials for the single-shared-folder spawn. */
interface AgentEdit { id?: string; slug?: string; name: string; role?: string; emoji: string; color: string; provider: string; model: string }

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
export default function MakeAppView({ initialFolder }: { initialFolder?: string } = {}): JSX.Element {
  // Shared pixel-office selection state (connection probe, office list, checkbox,
  // selected office) — same composable the Create dialog uses.
  const officeSel = useOfficeSelection({ defaultUseOffice: true, defaultSelection: NEW_OFFICE })
  const { connected, offices, loadOffices, useOffice, selectedOfficeId, setSelectedOfficeId } = officeSel
  // Seeded from officeStatus().base on mount (below), which resolves to the
  // user-configured Settings base when no session is live — so no hardcoded host.
  const [base, setBase] = useState('')
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
  const [folder, setFolder] = useState(initialFolder ?? '')
  const [sharedFolder, setSharedFolder] = useState(false) // Bug 2: one folder, all agents in a single .mcp.json
  const [fileBrowser, setFileBrowser] = useState(false)   // enable the office file-browser for EVERY spawned agent (both modes)
  const [spawning, setSpawning] = useState(false)
  const [spawnMsg, setSpawnMsg] = useState('')
  const [wired, setWired] = useState(false)          // shared-folder .mcp.json was written → offer "add to sidebar"
  const [addingSidebar, setAddingSidebar] = useState(false)
  const [spawnedOk, setSpawnedOk] = useState(false)  // a real spawn/add succeeded → offer a "Go to Agents" CTA

  // Typed app-actions bus — used only to navigate to the Agents tab from the
  // success CTA (no routing owned here).
  const app = useAppActions()

  // Remove the login DEAD-END: the funnel documents a local-only path, so let the
  // user proceed WITHOUT a Pixel Office. `localOnly` bypasses the sign-in gate and
  // forces the local roster path; office-backed generation still requires sign-in.
  const [localOnly, setLocalOnly] = useState(false)
  // Office generation only happens when actually connected AND opted-in; in
  // local-only mode this is false so `make` takes the local default-roster path.
  const officeMode = connected && useOffice

  // ── quick path: register an EXISTING folder as a single agent (no AI team, no
  //    office login) — the heavyweight describe→team funnel is overkill when you
  //    already have a repo. Mirrors window.api.addAgent, which supports exactly this. ──
  const [existingFolder, setExistingFolder] = useState('')
  const [existingProvider, setExistingProvider] = useState('claude-tui')
  const [addingExisting, setAddingExisting] = useState(false)
  const [existingMsg, setExistingMsg] = useState('')
  const [existingErr, setExistingErr] = useState('')
  const pickExisting = useCallback(async () => {
    const f = await window.api.pickFolder()
    if (f) { setExistingFolder(f); setExistingErr(''); setExistingMsg('') }
  }, [])
  const addExisting = useCallback(async () => {
    const path = existingFolder.trim().replace(/\/+$/, '')
    if (!path) { setExistingErr('Pick a folder that already contains your project.'); return }
    setAddingExisting(true); setExistingErr(''); setExistingMsg('')
    try {
      // init is idempotent (writes TODO.md + .autodev/settings.json + .gitignore; never
      // touches your source or .mcp.json), so it's safe to run on an existing repo and
      // gives the folder a provider before it's registered.
      const r = await window.api.runCli(['init', path, '--provider', existingProvider])
      if (r.code !== 0) { setExistingErr(`Could not initialize ${path}.${r.stderr ? ' ' + r.stderr.trim() : ''}`); return }
      const added = await window.api.addAgent(path) as { error?: string }
      if (added?.error) { setExistingErr(added.error); return }
      setSpawnedOk(true)
      setExistingMsg(`Added ${path} to your sidebar as one agent. Open the Agents tab to start it.`)
    } finally { setAddingExisting(false) }
  }, [existingFolder, existingProvider])

  // Apply a folder seed handed in after mount. This view is kept mounted (a
  // keep-alive layer), so the useState initializer above only runs once — when a
  // caller later routes here with a folder (Sessions' "Open as agent"), reflect it.
  useEffect(() => {
    if (initialFolder) {
      setFolder(initialFolder)
      setWired(false)
    }
  }, [initialFolder])

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
    setCreating(true); setErr(''); setOffice(null); setEdits(null); setSpawnMsg(''); setSpawnedOk(false)
    try {
      // Local-only path (checkbox unchecked OR not signed in): no office, no AI
      // call — build a generic default roster the user can rename/re-model, then
      // spawn purely local workspaces (no office character, no wsUrl).
      if (!officeMode) {
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
  }, [desc, count, defaultProvider, officeMode, selectedOfficeId, offices, loadOffices])

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
    let bound = 0
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
      // Office-backed spawn: `autodev init` writes NO office binding, so bind each
      // fresh workspace to its office character (presence + office-MCP) BEFORE we
      // start the loop, so it comes up already connected. Match by id/slug/name.
      if (office) {
        const b = await window.api.officeBindWorkspace(path, office.slug, { id: e.id, slug: e.slug, name: e.name }, fileBrowser) as { ok?: boolean; error?: string }
        if (b?.ok) bound++
      }
      // Spawn & Run: kick off each agent's loop right after it's registered (and
      // bound), so the user doesn't have to Start all of them one by one.
      if (run) {
        const sr = await window.api.startAgent(path, e.provider) as { error?: string } | undefined
        if (!sr?.error) started++
      }
    }
    setSpawning(false)
    setSpawnedOk(ok > 0)
    const where = office ? `Team from “${office.name}”.` : 'Local only — not attached to a pixel office.'
    const connected = office ? `, connected ${bound} to office` : ''
    setSpawnMsg(run
      ? `Spawned ${ok}/${edits.length}${connected}, started ${started} agent${started === 1 ? '' : 's'} into ${folder}. ${where} They're running in your sidebar.`
      : `Spawned ${ok}/${edits.length}${connected} agent${edits.length === 1 ? '' : 's'} into ${folder}. ${where} They're in your sidebar — Start them there.`)
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
      setSpawnedOk(true)
      setSpawnMsg(`Added “${office.name}” to your sidebar as one workspace at ${path}. Start it there — the single loop drives all ${edits!.length} agents via the shared .mcp.json.`)
    } finally { setAddingSidebar(false) }
  }, [folder, office, edits, defaultProvider, fileBrowser])

  const openSetup = useCallback(() => {
    if (!office) return
    window.api.openExternal(`${base.replace(/\/+$/, '')}/office/${office.slug}/setup`)
  }, [base, office])

  const reset = useCallback(() => { setOffice(null); setEdits(null); setDesc(''); setErr(''); setSpawnMsg(''); setFolder(''); setSharedFolder(false); setFileBrowser(false); setWired(false); setSpawnedOk(false) }, [])

  // ── not connected (and not local-only): login form with an escape hatch ──
  // R: removed the DEAD-END. Signing in unlocks AI team-generation + shared
  // offices, but a user who only wants LOCAL agents can proceed without it.
  if (!connected && !localOnly) {
    return (
      <SignInForm
        title="Make app"
        description="Sign in to generate an AI team and shared offices — or continue with local agents only."
        base={base}
        email={email}
        password={password}
        onBase={setBase}
        onEmail={setEmail}
        onPassword={setPassword}
        onSubmit={() => void connect()}
        loading={busy}
        error={err}
        width={340}
        footer={
          <button
            type="button"
            onClick={() => { setLocalOnly(true); officeSel.setUseOffice(false); setErr('') }}
            style={{ width: '100%', background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg)', padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
          >
            Continue without an office (local agents only) →
          </button>
        }
      />
    )
  }

  // Current wizard step for the progress indicator: 1 Describe → 2 Team → 3 Spawn.
  const step = edits ? (spawnedOk ? 3 : 2) : 1

  // ── connected: spawn-agents form + editable roster ──
  return (
    <div className="legacy-app" style={{ display: 'flex', justifyContent: 'center', height: '100%', overflow: 'auto' }}>
      <div style={{ width: 620, maxWidth: '100%', padding: 24 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>
          <span aria-hidden style={{ marginRight: 6 }}>🐣</span>Make app
        </h2>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--muted)' }}>
          Describe your app, generate a team, tweak each agent's name and model, then spawn them locally or open the office.
        </p>

        {/* Step indicator — this is a genuine 3-stage wizard; show where you are. */}
        <Steps current={step} />

        {/* Have an existing project? Skip the whole AI funnel and register it as one
            agent — no office login required (removes the "forced through AI team-gen"
            dead-end from the audit). */}
        <details style={{ margin: '0 0 16px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg2)' }}>
          <summary style={{ padding: '10px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--fg)' }}>
            Already have a project folder? Add it as one agent
          </summary>
          <div style={{ padding: '0 12px 12px' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="fld-input" value={existingFolder} onChange={(e) => { setExistingFolder(e.target.value); setExistingErr(''); setExistingMsg('') }}
                placeholder="/path/to/existing/project" style={{ ...inp, margin: 0, flex: 1 }} disabled={addingExisting} />
              <button onClick={pickExisting} disabled={addingExisting}>Browse</button>
            </div>
            <label className="fld" style={{ marginTop: 10 }}>Provider</label>
            <select className="fld-input" value={existingProvider} onChange={(e) => setExistingProvider(e.target.value)} style={{ ...inp, marginBottom: 0 }} disabled={addingExisting}>
              {PROVIDER_GROUPS.map((g) => <optgroup key={g.vendor} label={g.vendor}>{g.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</optgroup>)}
            </select>
            {existingErr && <div role="alert" style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{existingErr}</div>}
            <button className="primary" style={{ width: '100%', marginTop: 10 }} disabled={addingExisting || !existingFolder.trim()} onClick={addExisting}>
              {addingExisting ? 'Adding…' : '➕ Add folder as one agent'}
            </button>
            {existingMsg && (
              <div role="status" style={{ color: 'var(--green)', fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
                {existingMsg}
                <button className="primary" style={{ display: 'block', marginTop: 8 }} onClick={() => app.navigate('agents')}>Go to Agents →</button>
              </div>
            )}
          </div>
        </details>

        {/* Local-only banner — shown when a user chose to skip sign-in. Offers a way
            back into the office flow so the choice is never a trap. */}
        {!connected && (
          <div style={{ marginBottom: 16, padding: '10px 12px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--fg)' }}>Local agents only.</strong> Not connected to a Pixel Office — a generic default team is used (AI team-generation is office-backed).{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); setLocalOnly(false) }} style={{ color: 'var(--accent, #6ea8fe)' }}>Sign in to a Pixel Office</a> for an AI-generated team and shared offices.
          </div>
        )}

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
            <label className="fld" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Team size
              <InfoTip label="Team size" width={230}>
                How many agents to generate. Each becomes its own workspace (or office character) — more agents means more parallel work but more setup and cost. 1–12.
              </InfoTip>
            </label>
            <input className="fld-input" type="number" min={1} max={12} value={count}
              onChange={(e) => changeCount(parseInt(e.target.value) || 1)}
              style={{ ...inp, width: 90, marginBottom: 0 }} disabled={creating} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="fld" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Default provider (editable per agent)
              <InfoTip label="Provider" width={260}>
                Which engine each agent runs on — Claude, Copilot, OpenCode or Grok — and how: <strong>interactive</strong> (a live terminal), <strong>headless/CLI</strong> (a background loop), or <strong>SDK</strong>. You can change it per agent below.
              </InfoTip>
            </label>
            <select className="fld-input" value={defaultProvider} onChange={(e) => setDefaultProvider(e.target.value)} style={{ ...inp, marginBottom: 0 }} disabled={creating}>
              {PROVIDER_GROUPS.map((g) => <optgroup key={g.vendor} label={g.vendor}>{g.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</optgroup>)}
            </select>
          </div>
        </div>

        {err && <div role="alert" style={{ color: 'var(--red)', fontSize: 12, margin: '10px 0 0' }}>{err}</div>}

        {!edits && (
          <button className="primary" style={{ width: '100%', marginTop: 12 }} disabled={creating || !desc.trim()} onClick={make}>
            {creating ? (officeMode && selectedOfficeId === NEW_OFFICE ? 'Creating office…' : 'Assembling team…') : '🐣 Generate team'}
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
                {creating ? (officeMode && selectedOfficeId === NEW_OFFICE ? 'Creating office…' : 'Assembling team…') : '🔄 Regenerate'}
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
                    list={`models-${a.provider.split('-')[0]}`}
                    style={{ ...inp, margin: 0, flex: '0 0 130px' }} disabled={spawning} />
                  {modelSuggestionsFor(a.provider).length > 0 && (
                    <datalist id={`models-${a.provider.split('-')[0]}`}>
                      {modelSuggestionsFor(a.provider).map((m) => <option key={m} value={m} />)}
                    </datalist>
                  )}
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
                      <strong>Single shared folder</strong> (all agents in one <code>.mcp.json</code>){' '}
                      <InfoTip label="Single shared folder" width={280}>
                        Instead of one workspace per agent, this wires ONE folder to every office character via a single <code>.mcp.json</code>. A single Claude launched there can drive the whole team through those tool servers — no per-agent loops. Leave off to get a separate startable workspace per agent.
                      </InfoTip>
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
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Enable file browser for all agents
                    <InfoTip label="File browser" width={260}>
                      Gives every spawned agent the office Files tab, so you can browse and edit its workspace files from the office web app. Adds the mcp-operate file server to each agent.
                    </InfoTip>
                  </div>
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
                {spawnMsg && (
                  <div role="status" style={{ color: 'var(--green)', fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
                    {spawnMsg}
                    {spawnedOk && (
                      <button className="primary" style={{ display: 'block', marginTop: 8 }} onClick={() => app.navigate('agents')}>
                        Go to Agents →
                      </button>
                    )}
                  </div>
                )}
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

/** Lightweight 3-step progress indicator for the describe → team → spawn wizard. */
function Steps({ current }: { current: number }): JSX.Element {
  const labels = ['Describe', 'Team', 'Spawn']
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 16px' }}>
      {labels.map((label, i) => {
        const n = i + 1
        const done = current > n
        const active = current === n
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: i < labels.length - 1 ? 1 : '0 0 auto' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: active ? 'var(--fg)' : done ? 'var(--green)' : 'var(--muted)', fontWeight: active ? 700 : 500 }}>
              <span aria-hidden style={{
                width: 18, height: 18, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700,
                background: active ? 'var(--accent, #6ea8fe)' : done ? 'var(--green)' : 'var(--bg2)',
                color: active || done ? '#0b0e14' : 'var(--muted)',
                border: `1px solid ${active ? 'var(--accent, #6ea8fe)' : done ? 'var(--green)' : 'var(--border)'}`
              }}>{done ? '✓' : n}</span>
              {label}
            </span>
            {i < labels.length - 1 && <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />}
          </div>
        )
      })}
    </div>
  )
}
