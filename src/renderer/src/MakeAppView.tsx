import { Fragment, useEffect, useState, useCallback } from 'react'
import OfficeSelector from './OfficeSelector'
import FileBrowserCheckbox from './FileBrowserCheckbox'
import { SignInForm } from './components/office/SignInForm'
import { useOfficeSelection, useLocalOffices, NEW_OFFICE } from './composables/useOfficeSelection'
import { InfoTip, Button, Pill, Icon } from '@renderer/ui'
import { useAppActions } from '@renderer/services/appActions'
import { useCliStatus } from '@renderer/services/cliStatus'
import { useAgents } from '@renderer/services/agentStore'
import { PROVIDER_GROUPS, modelKeyFor, useModelCatalog, modelsForFamily, slugify, providerAuthFor, fetchDefaultModels, defaultModelFor } from '@renderer/lib/providers'

interface RosterAgent { id?: string; slug?: string; name: string; role?: string; emoji: string; color: string }
/** Per-agent editable fields the user can tweak before spawning. `id`/`slug` are
 *  the office character identity (present on the office-backed path) — needed to
 *  fetch each agent's MCP credentials for the single-shared-folder spawn. */
interface AgentEdit { id?: string; slug?: string; name: string; role?: string; emoji: string; color: string; provider: string; model: string }

/** Tone of the spawn result line — an honest signal, not always success-green. */
type SpawnTone = 'ok' | 'partial' | 'error'

/**
 * Generic team blueprint used when the user opts OUT of a pixel office. Team
 * generation is an office-backed AI call, so with no office we build a local
 * default roster instead (documented behavior — see the checkbox comment below).
 */
// Role identity colors are DATA (a role's hue is the same in both themes) but are
// referenced as tokens (--role-1..8, defined in ui/theme.css) so no component
// carries a raw hex literal.
const DEFAULT_ROLES: Array<{ role: string; emoji: string; color: string }> = [
  { role: 'Product Lead', emoji: '🧭', color: 'var(--role-1)' },
  { role: 'Frontend Engineer', emoji: '🎨', color: 'var(--role-2)' },
  { role: 'Backend Engineer', emoji: '⚙️', color: 'var(--role-3)' },
  { role: 'QA Engineer', emoji: '🧪', color: 'var(--role-4)' },
  { role: 'DevOps Engineer', emoji: '🚀', color: 'var(--role-5)' },
  { role: 'Designer', emoji: '✏️', color: 'var(--role-6)' },
  { role: 'Docs Writer', emoji: '📝', color: 'var(--role-7)' },
  { role: 'Data Engineer', emoji: '🗄️', color: 'var(--role-8)' }
]
function defaultRoster(count: number, provider: string, defaults: Record<string, string> = {}): AgentEdit[] {
  return Array.from({ length: Math.max(1, count) }, (_, i) => {
    const r = DEFAULT_ROLES[i % DEFAULT_ROLES.length]
    const rev = Math.floor(i / DEFAULT_ROLES.length)
    const name = rev === 0 ? r.role : `${r.role} ${rev + 1}`
    // #8 — seed each row's model from the per-provider default (Settings); '' when
    // none configured (provider default). Still editable per row below.
    return { name, role: r.role, emoji: r.emoji, color: r.color, provider, model: defaultModelFor(defaults, provider) }
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
 *
 * Styling: 0.2.0 theme.css tokens + the shared <Button>/<Pill> primitives (same
 * system as Help/Settings/SignInForm) — no legacy palette, so the funnel matches
 * the rest of the app. Success/error feedback is tone-accurate (never green on a
 * total failure), and both Generate and Spawn are gated on the AutoDev CLI being
 * present so a novice is blocked BEFORE a silent no-op, not after.
 */
export default function MakeAppView({ initialFolder }: { initialFolder?: string } = {}): JSX.Element {
  // Shared pixel-office selection state (connection probe, office list, checkbox,
  // selected office) — same composable the Create dialog uses.
  const officeSel = useOfficeSelection({ defaultUseOffice: true, defaultSelection: NEW_OFFICE })
  const { connected, offices, loadOffices, useOffice, selectedOfficeId, setSelectedOfficeId } = officeSel
  // Local offices (folders already housing a team) + the raw fleet — both sourced
  // from the local agentStore, so they exist with or without a pixel-office session.
  const localOffices = useLocalOffices()
  const fleet = useAgents()
  const hasLocalAgents = fleet.length > 0
  // The whole spawn funnel needs the AutoDev runner; read the shared status so we
  // can block Generate/Spawn before they silently no-op instead of after.
  const cli = useCliStatus()
  const cliMissing = cli.missing
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
  // #8 — per-provider default-model preference (Settings), used to seed each
  // generated agent's model so a fresh team inherits the house model.
  const [defaults, setDefaults] = useState<Record<string, string>>({})
  useEffect(() => { void fetchDefaultModels().then(setDefaults) }, [])
  const [creating, setCreating] = useState(false)
  const [office, setOffice] = useState<{ slug: string; id: number; name: string } | null>(null)
  const [edits, setEdits] = useState<AgentEdit[] | null>(null)
  const [folder, setFolder] = useState(initialFolder ?? '')
  const [sharedFolder, setSharedFolder] = useState(false) // Bug 2: one folder, all agents in a single .mcp.json
  const [fileBrowser, setFileBrowser] = useState(false)   // enable the office file-browser for EVERY spawned agent (both modes)
  const [spawning, setSpawning] = useState(false)
  const [spawnMsg, setSpawnMsg] = useState('')
  const [spawnTone, setSpawnTone] = useState<SpawnTone>('ok') // colour the result line by outcome
  const [wired, setWired] = useState(false)          // shared-folder .mcp.json was written → offer "add to sidebar"
  const [addingSidebar, setAddingSidebar] = useState(false)
  const [spawnedOk, setSpawnedOk] = useState(false)  // a real spawn/add succeeded → offer a "Go to Agents" CTA

  // Typed app-actions bus — used only to navigate to the Agents tab from the
  // success CTA (no routing owned here).
  const app = useAppActions()

  // Real per-vendor model ids (from the bundled CLI's catalog) that back the
  // model-field <datalist> hints below — the single source, never a hardcoded list.
  const { catalog: modelCatalog } = useModelCatalog()

  // Remove the login DEAD-END: the funnel documents a local-only path, so let the
  // user proceed WITHOUT a Pixel Office. `localOnly` bypasses the sign-in gate and
  // forces the local roster path; office-backed generation still requires sign-in.
  const [localOnly, setLocalOnly] = useState(false)
  // A3: once, when local agents already exist and we're not connected, default to
  // the local path instead of forcing the full-screen sign-in. `autoLocaled` gates
  // it to a single flip so the "Sign in to a Pixel Office" link (which sets
  // localOnly=false) still reopens the sign-in form.
  const [autoLocaled, setAutoLocaled] = useState(false)
  useEffect(() => {
    if (!autoLocaled && !connected && hasLocalAgents) {
      setLocalOnly(true)
      officeSel.setUseOffice(false)
      setAutoLocaled(true)
    }
  }, [autoLocaled, connected, hasLocalAgents, officeSel])
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
      // #8 — seed the per-provider default model (Settings) onto the new workspace.
      const dm = defaultModelFor(defaults, existingProvider)
      if (dm) await window.api.runCli(['config', 'set', modelKeyFor(existingProvider), dm, path])
      const added = await window.api.addAgent(path) as { error?: string }
      if (added?.error) { setExistingErr(added.error); return }
      setSpawnedOk(true)
      setExistingMsg(`Added ${path} to your sidebar as one agent. Open the Agents tab to start it.`)
    } finally { setAddingExisting(false) }
  }, [existingFolder, existingProvider, defaults])

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
        setEdits(defaultRoster(count, defaultProvider, defaults))
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
      setEdits((gt.agents ?? []).map((a) => ({ id: a.id, slug: a.slug, name: a.name, role: a.role, emoji: a.emoji, color: a.color, provider: defaultProvider, model: defaultModelFor(defaults, defaultProvider) })))
    } catch (e: any) {
      setErr(e?.message || 'Something went wrong.')
    }
    setCreating(false)
  }, [desc, count, defaultProvider, defaults, officeMode, selectedOfficeId, offices, loadOffices])

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
      const filled = defaultRoster(n, defaultProvider, defaults) // canonical rows for every index
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
    if (cliMissing) { setErr('The AutoDev CLI isn’t installed — install it (see the banner at the top), then spawn.'); return }
    setSpawning(true); setErr(''); setSpawnMsg(''); setSpawnTone('ok')

    // ── Single shared folder: merge one MCP server per character into folder/.mcp.json. ──
    if (shareMode && office) {
      const res = (await window.api.officeWriteSharedMcp(
        folder,
        office.slug,
        edits.map((e) => ({ id: e.id, slug: e.slug, name: e.name })),
        fileBrowser
      )) as { ok?: boolean; wired?: number; missing?: string[]; error?: string }
      setSpawning(false)
      if (res?.error) { setSpawnTone('error'); setSpawnMsg(res.error); setWired(false); return }
      const wiredN = res?.wired ?? 0
      const missN = res?.missing?.length ?? 0
      const cleanFolder = folder.replace(/\/+$/, '')
      // Nothing wired is a FAILURE, not a green "done" — say so plainly.
      if (wiredN === 0) {
        setWired(false)
        setSpawnTone('error')
        setSpawnMsg(`Couldn’t wire any of the ${edits.length} agent${edits.length === 1 ? '' : 's'} into ${cleanFolder}/.mcp.json${missN ? ` — ${missN} could not be matched to an office character` : ''}. Nothing was written.`)
        return
      }
      setWired(true)
      const partial = wiredN < edits.length
      setSpawnTone(partial ? 'partial' : 'ok')
      const miss = missN ? ` (${missN} could not be matched)` : ''
      setSpawnMsg(`Wired ${wiredN}/${edits.length} agent${edits.length === 1 ? '' : 's'} from “${office.name}” into ${cleanFolder}/.mcp.json${miss}. Add it to the sidebar below to run one loop that drives them all, or open the folder in claude yourself.`)
      return
    }

    // ── Default: one autodev workspace per agent. ──
    let ok = 0
    let started = 0
    let bound = 0
    const fails: string[] = [] // capture the first stderr/error per failed agent (no silent `continue`)
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]
      const path = `${folder.replace(/\/+$/, '')}/${slugify(e.name, i)}`
      const args = ['init', path, '--provider', e.provider]
      if (e.name.trim()) args.push('--session-name', e.name.trim())
      const r = await window.api.runCli(args)
      if (r.code !== 0) { fails.push(`${e.name}: ${r.stderr?.trim() || `init failed (exit ${r.code})`}`); continue }
      if (e.model.trim()) await window.api.runCli(['config', 'set', modelKeyFor(e.provider), e.model.trim(), path])
      // Enable the file browser per-workspace via the settings key (the init-flow
      // way the Create dialog uses) so each spawned agent gets the Files tab.
      if (fileBrowser) await window.api.runCli(['config', 'set', 'enableFileBrowser', 'true', path])
      const added = await window.api.addAgent(path)
      const addErr = (added as { error?: string })?.error
      if (addErr) { fails.push(`${e.name}: ${addErr}`); continue }
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
    const connectedNote = office ? `, connected ${bound} to office` : ''
    const cleanFolder = folder.replace(/\/+$/, '')

    // Total failure: NOT green, and don't claim agents are in the sidebar.
    if (ok === 0) {
      setSpawnTone('error')
      setSpawnMsg(`Couldn’t spawn any of the ${edits.length} agent${edits.length === 1 ? '' : 's'} into ${cleanFolder}. ${fails[0] ? `First error — ${fails[0]}.` : ''} Nothing was added to your sidebar.`.trim())
      return
    }
    // Partial failure: amber, name the count + first reason.
    if (ok < edits.length) {
      const failedN = edits.length - ok
      setSpawnTone('partial')
      setSpawnMsg(`Spawned ${ok}/${edits.length}${connectedNote}${run ? `, started ${started}` : ''} into ${cleanFolder}. ${failedN} failed${fails[0] ? ` — e.g. ${fails[0]}` : ''}. The rest are in your sidebar${run ? ' and running' : ' — Start them there'}.`)
      return
    }
    // Full success.
    setSpawnTone('ok')
    setSpawnMsg(run
      ? `Spawned ${ok}/${edits.length}${connectedNote}, started ${started} agent${started === 1 ? '' : 's'} into ${cleanFolder}. ${where} They’re running in your sidebar.`
      : `Spawned ${ok}/${edits.length}${connectedNote} agent${edits.length === 1 ? '' : 's'} into ${cleanFolder}. ${where} They’re in your sidebar — Start them there.`)
  }, [edits, folder, office, shareMode, fileBrowser, cliMissing])

  // After a shared-folder wire, register that ONE folder as a single startable
  // workspace in the left sidebar. `autodev init` only writes TODO.md +
  // .autodev/settings.json + .gitignore — it never touches .mcp.json — so the
  // already-wired shared .mcp.json (the 6 pixel-office-<slug> servers) is
  // preserved, and the one loop started here gets all of them as tools to drive
  // the team. Provider = the top-level Default provider (the operator's model).
  const addSharedAsAgent = useCallback(async () => {
    if (!folder || !office) return
    setAddingSidebar(true); setErr(''); setSpawnMsg(''); setSpawnTone('ok')
    try {
      const path = folder.replace(/\/+$/, '')
      const r = await window.api.runCli(['init', path, '--provider', defaultProvider, '--session-name', office.name])
      if (r.code !== 0) { setSpawnTone('error'); setSpawnMsg(`Could not init the workspace at ${path}.${r.stderr ? ' ' + r.stderr.trim() : ''}`); return }
      // Re-wire (idempotent merge) so the shared .mcp.json is guaranteed intact
      // even if init wrote a .gitignore or the folder shifted underneath us.
      await window.api.officeWriteSharedMcp(path, office.slug, edits!.map((e) => ({ id: e.id, slug: e.slug, name: e.name })), fileBrowser)
      if (fileBrowser) await window.api.runCli(['config', 'set', 'enableFileBrowser', 'true', path])
      const added = await window.api.addAgent(path)
      if ((added as { error?: string })?.error) { setSpawnTone('error'); setSpawnMsg((added as { error: string }).error); return }
      setSpawnedOk(true)
      setSpawnTone('ok')
      setSpawnMsg(`Added “${office.name}” to your sidebar as one workspace at ${path}. Start it there — the single loop drives all ${edits!.length} agents via the shared .mcp.json.`)
    } finally { setAddingSidebar(false) }
  }, [folder, office, edits, defaultProvider, fileBrowser])

  const openSetup = useCallback(() => {
    if (!office) return
    window.api.openExternal(`${base.replace(/\/+$/, '')}/office/${office.slug}/setup`)
  }, [base, office])

  const reset = useCallback(() => { setOffice(null); setEdits(null); setDesc(''); setErr(''); setSpawnMsg(''); setSpawnTone('ok'); setFolder(''); setSharedFolder(false); setFileBrowser(false); setWired(false); setSpawnedOk(false) }, [])

  // A2: step-2 → step-1 without wiping the form. Unlike reset() this KEEPS the
  // description, team size, selected office and chosen folder, so a "← Back" only
  // discards the generated roster + spawn result, not everything the user typed.
  const back = useCallback(() => { setEdits(null); setOffice(null); setErr(''); setSpawnMsg(''); setSpawnTone('ok'); setWired(false); setSpawnedOk(false) }, [])

  // A1: choosing an existing local office targets its folder as the spawn root.
  const pickLocalOffice = useCallback((path: string) => { setFolder(path); setWired(false) }, [])

  // ── not connected (and not local-only): login form with an escape hatch ──
  // R: removed the DEAD-END. Signing in unlocks AI team-generation + shared
  // offices, but a user who only wants LOCAL agents can proceed without it.
  // A3: never force this full-screen gate when local agents already exist — those
  // users land straight on the local path (the office step becomes optional-inline
  // via the banner + OfficeSelector below). The `autoLocaled` effect flips
  // `localOnly` for that case, and the sign-in link can still reopen this form.
  if (!connected && !localOnly && !hasLocalAgents) {
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
          <Button
            variant="secondary"
            block
            onClick={() => { setLocalOnly(true); officeSel.setUseOffice(false); setErr('') }}
          >
            Continue without an office (local agents only) →
          </Button>
        }
      />
    )
  }

  // Current wizard step for the progress indicator: 1 Describe → 2 Team → 3 Spawn.
  const step = edits ? (spawnedOk ? 3 : 2) : 1

  // The distinct providers in the current roster — surfaced in the pre-flight
  // auth advisory so the user knows exactly which CLIs to log in before spawning.
  const rosterProviders = edits ? Array.from(new Set(edits.map((e) => e.provider))) : []

  // ── connected: spawn-agents form + editable roster ──
  return (
    <div style={{ display: 'flex', justifyContent: 'center', height: '100%', overflow: 'auto', background: 'var(--bg-0)', fontFamily: 'var(--font-sans)' }}>
      <style>{`.makeapp-input:focus{border-color:var(--accent)!important;box-shadow:0 0 0 3px var(--accent-tint)}`}</style>
      {/* Wide, balanced shell: a single ~1040px column no longer floats in huge empty
          margins on a maximized window. Below the header + stepper the body splits into
          the primary funnel (left, takes the slack) and a persistent context rail
          (right: office target · existing-project shortcut) that stacks under the funnel
          on a narrow window (flex-wrap) — R2b. */}
      <div style={{ width: '100%', maxWidth: 1040, padding: '28px 32px' }}>
        <h2 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-page-title)', fontWeight: 700, color: 'var(--tx-hi)' }}>
          <Icon name="sparkle" size={17} color="var(--accent)" />Make app
        </h2>
        <p style={{ margin: '0 0 14px', fontSize: 'var(--fs-desc)', color: 'var(--tx-dim)' }}>
          Describe your app, generate a team, tweak each agent&rsquo;s name and model, then spawn them locally or open the office.
        </p>

        {/* Step indicator — this is a genuine 3-stage wizard; show where you are. */}
        <Steps current={step} />

        {/* CLI-missing gate: the whole spawn funnel needs the AutoDev runner, so warn
            up-front (and disable the spawn actions below) instead of letting a spawn
            no-op silently. */}
        {cliMissing && (
          <div role="alert" style={warnBox}>
            <Icon name="external" size={12} />
            <span>
              The AutoDev CLI isn&rsquo;t installed on this machine, so spawning agents won&rsquo;t work yet.
              Install it (see the banner at the top of the window), then Recheck — you can still
              generate and edit a team in the meantime.
            </span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* PRIMARY FUNNEL — describe → team → spawn (takes the slack). */}
          <div style={{ flex: '1 1 520px', minWidth: 0 }}>
        <label style={labelStyle}>What do you want to build?</label>
        <textarea className="makeapp-input" value={desc} onChange={(e) => setDesc(e.target.value)}
          placeholder="e.g. A recipe app that suggests meals from ingredients I have at home"
          rows={4} style={{ ...inp, resize: 'vertical', minHeight: 90 }} disabled={creating} />

        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <div>
            <label style={{ ...labelStyle, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Team size
              <InfoTip label="Team size" width={230} side="left">
                How many agents to generate. Each becomes its own workspace (or office character) — more agents means more parallel work but more setup and cost. 1–12.
              </InfoTip>
            </label>
            <input className="makeapp-input" type="number" min={1} max={12} value={count}
              onChange={(e) => changeCount(parseInt(e.target.value) || 1)}
              style={{ ...inp, width: 90, marginBottom: 0 }} disabled={creating} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ ...labelStyle, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Default provider (editable per agent)
              <InfoTip label="Provider" width={260} side="left">
                Which engine each agent runs on — Claude, Copilot, OpenCode or Grok — and how: <strong>interactive</strong> (a live terminal), <strong>headless/CLI</strong> (a background loop), or <strong>SDK</strong>. You can change it per agent below.
              </InfoTip>
            </label>
            <select className="makeapp-input" value={defaultProvider} onChange={(e) => setDefaultProvider(e.target.value)} style={{ ...inp, marginBottom: 0 }} disabled={creating}>
              {PROVIDER_GROUPS.map((g) => <optgroup key={g.vendor} label={g.vendor}>{g.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</optgroup>)}
            </select>
          </div>
        </div>

        {err && <div role="alert" style={{ color: 'var(--st-error-bright)', fontSize: 'var(--fs-desc)', margin: '10px 0 0' }}>{err}</div>}

        {!edits && (
          <Button variant="primary" block style={{ marginTop: 12 }} disabled={creating || !desc.trim()} onClick={make}>
            {creating ? (officeMode && selectedOfficeId === NEW_OFFICE ? 'Creating office…' : 'Assembling team…') : <><Icon name="sparkle" size={12} /> Generate team</>}
          </Button>
        )}

        {edits && (
          <div style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              {/* A2: back to step 1 WITHOUT wiping the form (keeps description, team
                  size, selected office & folder — unlike ＋ New / reset()). */}
              <Button variant="ghost" size="sm" onClick={back} disabled={creating || spawning}
                title="Back to describe — keeps your description, team size & office">← Back</Button>
              <strong style={{ fontSize: 'var(--fs-panel-title)', color: 'var(--tx-hi)' }}>{office ? office.name : 'Local workspaces'}</strong>
              <Pill variant="neutral">{edits.length} agents</Pill>
              <span style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-dim)' }}>— edit names &amp; models below</span>
              {/* Persistent regenerate: re-runs `make` (same description + team size +
                  selected office) and REPLACES the roster with a fresh AI team. Kept
                  next to the badge so it's reachable after the first generation, when
                  the big "🐣 Generate team" primary is no longer rendered. */}
              <Button variant="secondary" size="sm" style={{ marginLeft: 'auto', flex: '0 0 auto' }} disabled={creating || !desc.trim()} onClick={make}
                title="Generate a fresh team from the current description, team size & office">
                {creating ? (officeMode && selectedOfficeId === NEW_OFFICE ? 'Creating office…' : 'Assembling team…') : <><Icon name="refresh" size={12} /> Regenerate</>}
              </Button>
            </div>
            {edits.length === 0 && <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-dim)', padding: 12, background: 'var(--bg-panel)', border: '1px solid var(--bd-card)', borderRadius: 'var(--r-card)' }}>{office ? 'No team was generated — you can still set it up in the browser.' : 'No team was generated.'}</div>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {edits.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg-panel)', border: '1px solid var(--bd-card)', borderRadius: 'var(--r-card)' }}>
                  <span title={a.role} style={{ width: 30, height: 30, flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, fontSize: 16, background: `color-mix(in srgb, ${a.color || 'var(--swatch-fallback)'} 13%, transparent)`, border: `1px solid ${a.color || 'var(--swatch-fallback)'}` }}>{a.emoji || '🧑'}</span>
                  <input className="makeapp-input" value={a.name} onChange={(e) => patchEdit(i, { name: e.target.value })} aria-label={`Agent ${i + 1} name`}
                    style={{ ...inp, margin: 0, flex: '1 1 140px', minWidth: 100 }} disabled={spawning} />
                  <select className="makeapp-input" value={a.provider}
                    onChange={(e) => { const p = e.target.value; patchEdit(i, a.model.trim() ? { provider: p } : { provider: p, model: defaultModelFor(defaults, p) }) }}
                    aria-label={`Agent ${i + 1} provider`}
                    style={{ ...inp, margin: 0, flex: '0 0 150px' }} disabled={spawning}>
                    {PROVIDER_GROUPS.map((g) => <optgroup key={g.vendor} label={g.vendor}>{g.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</optgroup>)}
                  </select>
                  <input className="makeapp-input" value={a.model} onChange={(e) => patchEdit(i, { model: e.target.value })} placeholder="default model" aria-label={`Agent ${i + 1} model`}
                    list={`models-${a.provider.split('-')[0]}`}
                    style={{ ...inp, margin: 0, flex: '0 0 130px' }} disabled={spawning} />
                  {modelsForFamily(modelCatalog, a.provider).length > 0 && (
                    <datalist id={`models-${a.provider.split('-')[0]}`}>
                      {modelsForFamily(modelCatalog, a.provider).map((m) => <option key={m.id} value={m.id} />)}
                    </datalist>
                  )}
                </div>
              ))}
            </div>

            {edits.length > 0 && (
              <div style={{ marginTop: 16, padding: 14, background: 'var(--bg-panel)', border: '1px solid var(--bd-card)', borderRadius: 'var(--r-card)' }}>
                {/* Pre-flight provider auth: the app can't verify provider logins, so
                    tell the user exactly which CLIs must be signed in on this machine
                    before spawning — otherwise a headless loop fails at runtime with a
                    needs-auth error the novice never sees explained. */}
                <ProviderAuthNote providers={rosterProviders} />

                <label style={labelStyle}>
                  {shareMode
                    ? 'Spawn locally — folder (all agents share ONE .mcp.json here)'
                    : 'Spawn locally — folder (one workspace per agent is created here)'}
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="makeapp-input" value={folder} onChange={(e) => { setFolder(e.target.value); setWired(false) }} placeholder="/path/to/folder" style={{ ...inp, margin: 0, flex: 1 }} disabled={spawning} />
                  <Button variant="secondary" onClick={pickFolder} disabled={spawning}>Browse</Button>
                </div>
                {/* A1: quick-pick a folder that already houses a team (local office),
                    so you can spawn the new agents right alongside an existing one
                    without retyping the path. Sourced from the fleet (agentStore). */}
                {localOffices.length > 0 && (
                  <select
                    className="makeapp-input"
                    aria-label="Spawn into an existing local office folder"
                    value={localOffices.some((o) => o.path === folder) ? folder : ''}
                    onChange={(e) => { if (e.target.value) pickLocalOffice(e.target.value) }}
                    style={{ ...inp, marginTop: 8, marginBottom: 0 }}
                    disabled={spawning}
                  >
                    <option value="">Or pick an existing local office…</option>
                    {localOffices.map((o) => (
                      <option key={o.path} value={o.path}>{o.label} — {o.count} agent{o.count === 1 ? '' : 's'}</option>
                    ))}
                  </select>
                )}
                {/* Bug 2: single-shared-folder mode. Only meaningful when the roster
                    agents are office characters — otherwise there's no office key to
                    wire, so hide it (and fall back to the per-agent path). */}
                {canShareFolder && (
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, fontSize: 'var(--fs-desc)', color: 'var(--tx-2)', cursor: spawning ? 'default' : 'pointer' }}>
                    <input type="checkbox" checked={sharedFolder} onChange={(e) => { setSharedFolder(e.target.checked); setWired(false) }} disabled={spawning} style={{ marginTop: 2 }} />
                    <span>
                      <strong>Single shared folder</strong> (all agents in one <code>.mcp.json</code>){' '}
                      <InfoTip label="Single shared folder" width={280} side="left">
                        Instead of one workspace per agent, this wires ONE folder to every office character via a single <code>.mcp.json</code>. A single Claude launched there can drive the whole team through those tool servers — no per-agent loops. Leave off to get a separate startable workspace per agent.
                      </InfoTip>
                      <span style={{ display: 'block', color: 'var(--tx-dim)', marginTop: 2 }}>
                        Wires this one folder to every office character via a single <code>.mcp.json</code> — no per-agent workspaces or loops.
                      </span>
                    </span>
                  </label>
                )}
                {/* File browser applies to EVERY spawned agent — per-agent mode sets
                    enableFileBrowser on each workspace; single-folder mode passes
                    --file-browser to each pixel-office-<agent> mcp-operate entry. */}
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 'var(--fs-desc)', fontWeight: 600, color: 'var(--tx-2)', marginBottom: 2, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Enable file browser for all agents
                    <InfoTip label="File browser" width={260} side="left">
                      Gives every spawned agent the office Files tab, so you can browse and edit its workspace files from the office web app. Adds the mcp-operate file server to each agent.
                    </InfoTip>
                  </div>
                  <FileBrowserCheckbox checked={fileBrowser} onChange={setFileBrowser} disabled={spawning} id="makeapp-file-browser" />
                </div>
                {/* Default (non-run) spawn is the secondary action; Spawn & Run is the
                    emphasised primary. Both are gated on the CLI being present. */}
                <Button variant={shareMode ? 'primary' : 'secondary'} block style={{ marginTop: 10 }} disabled={spawning || !folder || cliMissing} onClick={() => spawnLocal(false)}>
                  {spawning
                    ? (shareMode ? 'Wiring…' : 'Spawning…')
                    : shareMode
                      ? <><Icon name="terminal" size={12} /> Wire {edits.length} agent{edits.length === 1 ? '' : 's'} into shared .mcp.json</>
                      : <><Icon name="sparkle" size={12} /> Spawn {edits.length} agent{edits.length === 1 ? '' : 's'} into folder</>}
                </Button>
                {/* Per-agent mode only: spawn AND start every loop in one click so
                    the user doesn't have to Start each agent in the sidebar. Shared
                    mode has no per-agent loops, so it's not offered there. */}
                {!shareMode && (
                  <Button variant="primary" block style={{ marginTop: 8 }}
                    disabled={spawning || !folder || cliMissing} onClick={() => spawnLocal(true)}
                    title="Spawn each workspace and immediately start its loop">
                    <Icon name="play" size={11} /> {spawning ? 'Spawning & starting…' : `Spawn & Run ${edits.length} agent${edits.length === 1 ? '' : 's'}`}
                  </Button>
                )}
                {/* After a shared wire: register the folder as ONE sidebar workspace
                    (single loop, driving all agents via the shared .mcp.json). */}
                {shareMode && wired && (
                  <Button variant="primary" block style={{ marginTop: 8 }} disabled={addingSidebar || cliMissing} onClick={addSharedAsAgent}
                    title="Init this folder as one workspace and add it to the agents sidebar so you can Start a single loop that drives the whole team">
                    {addingSidebar ? 'Adding…' : <><Icon name="plus" size={12} /> Add to sidebar as one agent (drives all {edits.length})</>}
                  </Button>
                )}
                {spawnMsg && (
                  <div
                    role={spawnTone === 'error' ? 'alert' : 'status'}
                    style={{
                      color: spawnTone === 'error' ? 'var(--st-error-bright)' : spawnTone === 'partial' ? 'var(--st-needsyou)' : 'var(--st-running)',
                      fontSize: 'var(--fs-desc)',
                      marginTop: 8,
                      lineHeight: 1.5
                    }}
                  >
                    {spawnMsg}
                    {spawnedOk && (
                      <Button variant="primary" size="sm" style={{ display: 'flex', marginTop: 8 }} onClick={() => app.navigate('agents')}>
                        Go to Agents →
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              {office && <Button variant="secondary" style={{ flex: 1 }} onClick={openSetup}><Icon name="external" size={12} /> Open in browser</Button>}
              <Button variant="ghost" style={{ flex: office ? '0 0 auto' : 1 }} onClick={reset} title="Start another"><Icon name="plus" size={12} /> New</Button>
            </div>
          </div>
        )}
          </div>
          {/* CONTEXT RAIL — office target + the existing-project shortcut. Sits beside the
              funnel on a wide window (uses the width) and wraps below it when narrow. */}
          <aside style={{ flex: '1 1 300px', minWidth: 260, display: 'flex', flexDirection: 'column', gap: 14 }}>
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
              localOffices={localOffices}
              selectedLocalOffice={folder}
              onSelectLocalOffice={pickLocalOffice}
            />

            {/* Local-only banner — shown when a user chose to skip sign-in. Offers a way
                back into the office flow so the choice is never a trap. */}
            {!connected && (
              <div style={{ padding: '10px 12px', background: 'var(--bg-panel)', border: '1px solid var(--bd-card)', borderRadius: 'var(--r-card)', fontSize: 'var(--fs-desc)', color: 'var(--tx-dim)', lineHeight: 1.5 }}>
                <strong style={{ color: 'var(--tx-2)' }}>Local agents only.</strong> Not connected to a Pixel Office — a generic default team is used (AI team-generation is office-backed).{' '}
                <a href="#" onClick={(e) => { e.preventDefault(); setLocalOnly(false) }} style={{ color: 'var(--accent)' }}>Sign in to a Pixel Office</a> for an AI-generated team and shared offices.
              </div>
            )}

            {/* Have an existing project? Skip the whole AI funnel and register it as one
                agent — no office login required (removes the "forced through AI team-gen"
                dead-end from the audit). */}
            <details style={{ border: '1px solid var(--bd-card)', borderRadius: 'var(--r-card)', background: 'var(--bg-panel)' }}>
              <summary style={{ padding: '10px 12px', cursor: 'pointer', fontSize: 'var(--fs-meta)', color: 'var(--tx-2)' }}>
                Already have a project folder? Add it as one agent
              </summary>
              <div style={{ padding: '0 12px 12px' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="makeapp-input" value={existingFolder} onChange={(e) => { setExistingFolder(e.target.value); setExistingErr(''); setExistingMsg('') }}
                    placeholder="/path/to/existing/project" style={{ ...inp, margin: 0, flex: 1 }} disabled={addingExisting} />
                  <Button variant="secondary" onClick={pickExisting} disabled={addingExisting}>Browse</Button>
                </div>
                <label style={{ ...labelStyle, marginTop: 10 }}>Provider</label>
                <select className="makeapp-input" value={existingProvider} onChange={(e) => setExistingProvider(e.target.value)} style={{ ...inp, marginBottom: 0 }} disabled={addingExisting}>
                  {PROVIDER_GROUPS.map((g) => <optgroup key={g.vendor} label={g.vendor}>{g.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</optgroup>)}
                </select>
                {existingErr && <div role="alert" style={{ color: 'var(--st-error-bright)', fontSize: 'var(--fs-desc)', marginTop: 8 }}>{existingErr}</div>}
                <Button variant="primary" block style={{ marginTop: 10 }} disabled={addingExisting || !existingFolder.trim() || cliMissing} onClick={addExisting}>
                  {addingExisting ? 'Adding…' : <><Icon name="plus" size={12} /> Add folder as one agent</>}
                </Button>
                {existingMsg && (
                  <div role="status" style={{ color: 'var(--st-running)', fontSize: 'var(--fs-desc)', marginTop: 8, lineHeight: 1.5 }}>
                    {existingMsg}
                    <Button variant="primary" size="sm" style={{ display: 'flex', marginTop: 8 }} onClick={() => app.navigate('agents')}>Go to Agents →</Button>
                  </div>
                )}
              </div>
            </details>
          </aside>
        </div>
      </div>
    </div>
  )
}

/* ── shared inline styles (theme.css tokens only) ─────────────────────────── */

// Input styling matching the 0.2.0 field controls (SignInForm/Settings). The
// `.makeapp-input` class adds the focus ring via the scoped <style> above.
const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', marginBottom: 8, padding: '8px 10px',
  background: 'var(--bg-input)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)',
  color: 'var(--tx-1)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)', outline: 'none'
}
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'var(--fs-desc)', fontWeight: 600, color: 'var(--tx-2)', margin: '0 0 6px'
}
const warnBox: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 16, padding: '10px 12px',
  background: 'var(--st-error-soft)', border: '1px solid var(--st-error-bd)', borderRadius: 'var(--r-card)',
  fontSize: 'var(--fs-desc)', color: 'var(--st-error-bright)', lineHeight: 1.5
}

/**
 * ProviderAuthNote — the pre-flight authentication advisory. The app has no IPC to
 * probe whether a provider CLI is signed in, so instead of a false "signed in ✓" we
 * state honestly that the user must log each provider in on this machine, and give
 * the exact command per distinct provider in the roster (copyable). Non-blocking.
 */
function ProviderAuthNote({ providers }: { providers: string[] }): JSX.Element | null {
  const [copied, setCopied] = useState<string | null>(null)
  if (!providers.length) return null
  const auths = Array.from(new Map(providers.map((p) => [providerAuthFor(p).cmd, providerAuthFor(p)])).values())
  const copy = (cmd: string): void => {
    void navigator.clipboard?.writeText(cmd).then(
      () => { setCopied(cmd); window.setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1500) },
      () => {}
    )
  }
  return (
    <div style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--st-needsyou-wash)', border: '1px solid var(--st-needsyou-bd)', borderRadius: 'var(--r-card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-desc)', fontWeight: 600, color: 'var(--tx-2)', marginBottom: 4 }}>
        <Icon name="terminal" size={12} /> Before you spawn: sign in to each provider on this machine
      </div>
      <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-dim)', lineHeight: 1.5, marginBottom: 8 }}>
        The app can&rsquo;t verify provider logins. If a provider isn&rsquo;t signed in, its agent&rsquo;s loop fails
        with a needs-auth error. Run each command once in a terminal and follow its login:
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {auths.map((a) => (
          <button
            key={a.cmd}
            type="button"
            onClick={() => copy(a.cmd)}
            title={`Copy: ${a.cmd}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px',
              background: 'var(--bg-input)', border: '1px solid var(--bd-field)', borderRadius: 'var(--r-chip)',
              cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-mono-code)', color: 'var(--tx-2)'
            }}
          >
            <span style={{ color: 'var(--tx-dim)' }}>{a.label}:</span> {a.cmd}
            <Icon name={copied === a.cmd ? 'check' : 'copy'} size={11} color="var(--tx-dim)" />
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Steps — a real connected 3-stage stepper for the describe → team → spawn wizard.
 * Each stage is a numbered node (28px) with a label + sub-hint; the connector
 * between nodes fills accent→green once its segment is complete, the current node
 * carries an accent ring glow, and done nodes show a ✓. Full-width so it uses the
 * pane instead of reading as a thin text row (R2b).
 */
const STEP_META = [
  { label: 'Describe', hint: 'what to build' },
  { label: 'Team', hint: 'edit & tweak' },
  { label: 'Spawn', hint: 'run locally' }
]
const NODE = 28
function Steps({ current }: { current: number }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', margin: '6px 0 24px' }}>
      {STEP_META.map((s, i) => {
        const n = i + 1
        const done = current > n
        const active = current === n
        const nodeBg = active ? 'var(--accent)' : done ? 'var(--st-running)' : 'var(--bg-chip-idle)'
        const nodeBd = active ? 'var(--accent)' : done ? 'var(--st-running)' : 'var(--bd-field)'
        return (
          <Fragment key={s.label}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, flex: '0 0 auto', width: 92, textAlign: 'center' }}>
              <span
                aria-hidden
                style={{
                  width: NODE,
                  height: NODE,
                  borderRadius: 999,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 'var(--fs-meta)',
                  fontWeight: 700,
                  fontFeatureSettings: 'var(--fvn-tabular)',
                  background: nodeBg,
                  color: active || done ? 'var(--tx-onaccent)' : 'var(--tx-dim)',
                  border: `1px solid ${nodeBd}`,
                  boxShadow: active ? '0 0 0 4px var(--accent-tint)' : 'none',
                  transition: 'background .15s ease, box-shadow .15s ease'
                }}
              >
                {done ? <Icon name="check" size={13} strokeWidth={2} /> : n}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontSize: 'var(--fs-desc)', fontWeight: active ? 700 : 600, color: active ? 'var(--tx-hi)' : done ? 'var(--st-running)' : 'var(--tx-dim)' }}>
                  {s.label}
                </span>
                <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--tx-faint)' }}>{s.hint}</span>
              </span>
            </div>
            {i < STEP_META.length - 1 && (
              <span
                aria-hidden
                style={{
                  flex: 1,
                  height: 2,
                  marginTop: NODE / 2 - 1,
                  borderRadius: 'var(--r-bar)',
                  minWidth: 24,
                  background: current > n ? 'var(--st-running)' : 'var(--bd-card)',
                  transition: 'background .15s ease'
                }}
              />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
