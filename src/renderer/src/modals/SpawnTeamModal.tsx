import React, { useCallback, useEffect, useState } from 'react'
import { Modal, Button, Icon } from '@renderer/ui'

/**
 * SCREEN 2e — Spawn a team.
 *
 * Describe the work → AutoDev proposes roles → tweak each row's name/provider →
 * spawn the team as local `autodev` workspaces (optionally bound to a pixel
 * office). Wired to the REAL office spawn surface from CURRENT-APP.md:
 *   officeOffices / officeAutoConnect  — resolve the office picker
 *   officeCreateOffice                 — mint a fresh office from the prompt
 *   officeGenerateTeam                 — the AI role blueprint
 *   runCli(['init',…]) + config set    — create each per-agent workspace
 *   addAgent / officeBindWorkspace     — register + bind to the office character
 *   startAgent                         — Spawn & run kicks off each loop
 *
 * Self-contained: all layout uses the design tokens in ui/theme.css.
 */

// ── provider vocabulary (mirrors PROVIDER_GROUPS in App.tsx) ──
const PROVIDER_GROUPS: Array<{ vendor: string; options: Array<{ id: string; label: string }> }> = [
  { vendor: 'Claude', options: [{ id: 'claude-tui', label: 'Claude — interactive' }, { id: 'claude-cli', label: 'Claude — headless CLI' }] },
  { vendor: 'GitHub Copilot', options: [{ id: 'copilot-cli', label: 'Copilot — CLI' }, { id: 'copilot-sdk', label: 'Copilot — SDK' }] },
  { vendor: 'OpenCode', options: [{ id: 'opencode-cli', label: 'OpenCode — CLI' }, { id: 'opencode-sdk', label: 'OpenCode — SDK' }] },
  { vendor: 'Grok', options: [{ id: 'grok-cli', label: 'Grok — CLI' }, { id: 'grok-tui', label: 'Grok — interactive' }] }
]
const MODEL_KEY: Record<string, string> = { claude: 'claudeModel', opencode: 'opencodeModel', copilot: 'copilotModel', grok: 'grokModel' }
const modelKeyFor = (p: string): string => MODEL_KEY[p.split('-')[0]] ?? 'claudeModel'
const slugify = (s: string, i: number): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `agent-${i + 1}`

interface RosterAgent { id?: string; slug?: string; name: string; role?: string; emoji?: string; color?: string }
interface TeamMember extends RosterAgent { provider: string; model: string }

const DEFAULT_ROLES: Array<{ role: string; emoji: string }> = [
  { role: 'Product Lead', emoji: '🧭' }, { role: 'Frontend Engineer', emoji: '🎨' },
  { role: 'Backend Engineer', emoji: '⚙️' }, { role: 'QA Engineer', emoji: '🧪' },
  { role: 'DevOps Engineer', emoji: '🚀' }, { role: 'Designer', emoji: '✏️' },
  { role: 'Docs Writer', emoji: '📝' }, { role: 'Data Engineer', emoji: '🗄️' }
]
function defaultRoster(count: number, provider: string): TeamMember[] {
  return Array.from({ length: Math.max(1, count) }, (_, i) => {
    const r = DEFAULT_ROLES[i % DEFAULT_ROLES.length]
    const rev = Math.floor(i / DEFAULT_ROLES.length)
    return { name: rev === 0 ? r.role : `${r.role} ${rev + 1}`, role: r.role, emoji: r.emoji, provider, model: '' }
  })
}
function deriveName(desc: string): string {
  const words = desc.replace(/[\r\n]+/g, ' ').trim().split(/\s+/).slice(0, 4).join(' ')
  return words.replace(/[^\w .-]+/g, '').slice(0, 40).trim() || 'New team'
}

const NEW_OFFICE = '__new__'

// ── token-styled atoms ──
const label: React.CSSProperties = {
  display: 'block', fontSize: 'var(--fs-section)', fontWeight: 600, letterSpacing: 'var(--ls-section)',
  textTransform: 'uppercase', color: 'var(--tx-dim)', marginBottom: 6
}
const inputStyle: React.CSSProperties = {
  width: '100%', background: 'var(--bg-input)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)',
  color: 'var(--tx-1)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)', padding: '7px 9px', outline: 'none'
}
const selectStyle: React.CSSProperties = { ...inputStyle, appearance: 'none', cursor: 'pointer' }

function SpawnTeamModal(props: { open: boolean; onClose: () => void }): JSX.Element {
  const { open, onClose } = props
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState(4)
  const [provider, setProvider] = useState('claude-tui')
  const [useOffice, setUseOffice] = useState(true)
  const [offices, setOffices] = useState<Array<{ slug: string; id: number; name: string }>>([])
  const [officeSel, setOfficeSel] = useState<string>(NEW_OFFICE)
  const [roster, setRoster] = useState<TeamMember[] | null>(null)
  // The office we generated INTO (needed to bind each workspace on spawn).
  const [office, setOffice] = useState<{ slug: string; id: number; name: string } | null>(null)
  const [folder, setFolder] = useState('')
  const [fileBrowser, setFileBrowser] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [spawning, setSpawning] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  // Load the office list (officeOffices THROWS on a dead session — try a silent
  // reconnect before giving up; a failure just means office mode is unavailable).
  const loadOffices = useCallback(async (): Promise<void> => {
    try {
      const list = (await window.api.officeOffices()) as Array<{ slug: string; id: number; name: string }>
      setOffices(list)
    } catch {
      try {
        if (await window.api.officeAutoConnect()) {
          const list = (await window.api.officeOffices()) as Array<{ slug: string; id: number; name: string }>
          setOffices(list)
        }
      } catch { /* not connected — office picker offers "new office" only */ }
    }
  }, [])
  useEffect(() => { if (open) void loadOffices() }, [open, loadOffices])

  const patch = (i: number, p: Partial<TeamMember>): void =>
    setRoster((prev) => (prev ? prev.map((m, k) => (k === i ? { ...m, ...p } : m)) : prev))

  const setCount = (n: number): void => {
    const c = Math.max(1, Math.min(12, n || 1))
    setSize(c)
    setRoster((prev) => {
      if (!prev || c === prev.length) return prev
      if (c < prev.length) return prev.slice(0, c)
      return [...prev, ...defaultRoster(c, provider).slice(prev.length)]
    })
  }

  // Propose / regenerate the roster from the prompt.
  const propose = useCallback(async (): Promise<void> => {
    if (!prompt.trim()) { setErr('Describe what you want to build first.'); return }
    setGenerating(true); setErr(''); setMsg('')
    try {
      if (!useOffice) { setOffice(null); setRoster(defaultRoster(size, provider)); return }
      // Resolve the target office (existing pick or a fresh one from the prompt).
      let target: { slug: string; id: number; name: string } | undefined
      if (officeSel === NEW_OFFICE) {
        const oc = (await window.api.officeCreateOffice(deriveName(prompt), prompt.trim())) as
          { ok?: boolean; office?: { slug: string; id: number; name: string }; error?: string }
        if (oc?.error || !oc?.office) { setErr(oc?.error || 'Could not create the office.'); return }
        target = oc.office
        setOffices((prev) => [...prev, target!]); setOfficeSel(String(target.id))
      } else {
        target = offices.find((o) => String(o.id) === officeSel)
        if (!target) { setErr('Pick an office to generate the team into.'); return }
      }
      setOffice(target)
      const gt = (await window.api.officeGenerateTeam(target.id, prompt.trim(), size)) as
        { ok?: boolean; agents?: RosterAgent[]; error?: string }
      if (gt?.error) { setErr(gt.error); return }
      setRoster((gt.agents ?? []).map((a) => ({ ...a, provider, model: '' })))
    } catch (e) {
      setErr((e as Error)?.message || 'Team generation failed.')
    } finally { setGenerating(false) }
  }, [prompt, useOffice, size, provider, officeSel, offices])

  const browse = useCallback(async (): Promise<void> => {
    const f = await window.api.pickFolder()
    if (f) setFolder(f)
  }, [])

  // Spawn each roster member as a real per-agent workspace, then start its loop.
  const spawnRun = useCallback(async (): Promise<void> => {
    if (!roster?.length) return
    if (!folder) { setErr('Pick a folder to spawn the team into first.'); return }
    setSpawning(true); setErr(''); setMsg('')
    const base = folder.replace(/\/+$/, '')
    let ok = 0, started = 0
    for (let i = 0; i < roster.length; i++) {
      const m = roster[i]
      const path = `${base}/${slugify(m.name, i)}`
      const args = ['init', path, '--provider', m.provider]
      if (m.name.trim()) args.push('--session-name', m.name.trim())
      const r = await window.api.runCli(args)
      if (r.code !== 0) continue
      if (m.model.trim()) await window.api.runCli(['config', 'set', modelKeyFor(m.provider), m.model.trim(), path])
      if (fileBrowser) await window.api.runCli(['config', 'set', 'enableFileBrowser', 'true', path])
      const added = (await window.api.addAgent(path)) as { error?: string }
      if (added?.error) continue
      ok++
      // init writes NO office binding — bind each fresh workspace to its character.
      if (office) await window.api.officeBindWorkspace(path, office.slug, { id: m.id, slug: m.slug, name: m.name }, fileBrowser)
      const sr = (await window.api.startAgent(path, m.provider)) as { error?: string } | undefined
      if (!sr?.error) started++
    }
    setSpawning(false)
    setMsg(`Spawned ${ok}/${roster.length}${office ? ` from “${office.name}”` : ''}, started ${started}. They're in your sidebar.`)
  }, [roster, folder, office, fileBrowser])

  const folderNote = folder
    ? `creates ${roster?.length ?? size} folder${(roster?.length ?? size) === 1 ? '' : 's'} under …/${folder.replace(/\/+$/, '').split('/').pop()}`
    : 'pick a folder to spawn into'

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={600}
      title="Spawn a team"
      subtitle="Describe the work — AutoDev proposes roles you can tweak before spawning."
      footer={
        <>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-meta)', color: 'var(--tx-dim)' }}>{folderNote}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={onClose} disabled={spawning}>Cancel</Button>
            <Button variant="primary" onClick={() => void spawnRun()} disabled={!roster?.length || !folder || spawning}>
              {spawning ? 'Spawning…' : 'Spawn & run'}
            </Button>
          </div>
        </>
      }
    >
      {/* WHAT ARE YOU BUILDING */}
      <div style={{ marginBottom: 14 }}>
        <span style={label}>What are you building?</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="A 2D fighting game with 8 heroes, CPS2 pixel art, live-ops events…"
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
        />
      </div>

      {/* TEAM SIZE + DEFAULT PROVIDER */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
        <div style={{ flex: '0 0 132px' }}>
          <span style={label}>Team size</span>
          <div style={{ display: 'flex', alignItems: 'stretch', background: 'var(--bg-input)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)', overflow: 'hidden' }}>
            <span style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-body)', color: 'var(--tx-1)' }}>{size}</span>
            <div style={{ display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--bd-1)' }}>
              <button type="button" aria-label="Increase" onClick={() => setCount(size + 1)} style={stepBtn}>▲</button>
              <button type="button" aria-label="Decrease" onClick={() => setCount(size - 1)} style={{ ...stepBtn, borderTop: '1px solid var(--bd-1)' }}>▼</button>
            </div>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <span style={label}>Default provider</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} style={selectStyle}>
            {PROVIDER_GROUPS.map((g) => (
              <optgroup key={g.vendor} label={g.vendor}>
                {g.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      {/* PUT THEM IN AN OFFICE */}
      <div style={{ background: useOffice ? 'var(--bg-accent-soft)' : 'var(--bg-input)', border: `1px solid ${useOffice ? 'var(--bd-accent)' : 'var(--bd-1)'}`, borderRadius: 'var(--r-card)', padding: '10px 12px', marginBottom: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}>
          <input type="checkbox" checked={useOffice} onChange={(e) => setUseOffice(e.target.checked)} />
          <span style={{ fontSize: 'var(--fs-body)', fontWeight: 600, color: 'var(--tx-1)' }}>Put them in an office</span>
        </label>
        {useOffice && (
          <div style={{ marginTop: 9 }}>
            <select value={officeSel} onChange={(e) => setOfficeSel(e.target.value)} style={selectStyle}>
              <option value={NEW_OFFICE}>New office — from the description above</option>
              {offices.map((o) => <option key={o.id} value={String(o.id)}>{o.name}</option>)}
            </select>
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--bd-card)', margin: '2px 0 14px' }} />

      {/* PROPOSED TEAM */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <span style={{ ...label, marginBottom: 0 }}>Proposed team</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-meta)', color: 'var(--tx-dim)' }}>edit any row</span>
        <button
          type="button"
          onClick={() => void propose()}
          disabled={generating}
          style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--accent)', fontSize: 'var(--fs-meta)', fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <Icon name="refresh" size={11} /> {generating ? 'Generating…' : roster ? 'Regenerate' : 'Propose team'}
        </button>
      </div>

      {!roster && (
        <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', padding: '4px 0 12px' }}>
          {generating ? 'Proposing roles…' : 'Describe the work and press Propose team.'}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {roster?.map((m, i) => <TeamRow key={i} m={m} onName={(v) => patch(i, { name: v })} onProvider={(v) => patch(i, { provider: v })} />)}
      </div>

      {/* SPAWN INTO FOLDER — needed for real per-agent workspace creation */}
      {roster && (
        <div style={{ marginTop: 14 }}>
          <span style={label}>Spawn into folder</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/path/to/parent-folder" style={{ ...inputStyle, flex: 1, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-meta)' }} />
            <Button variant="secondary" onClick={() => void browse()}><Icon name="folder" size={12} /> Browse</Button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, fontSize: 'var(--fs-meta)', color: 'var(--tx-4)', cursor: 'pointer' }}>
            <input type="checkbox" checked={fileBrowser} onChange={(e) => setFileBrowser(e.target.checked)} />
            Enable file browser for every spawned agent
          </label>
        </div>
      )}

      {(err || msg) && (
        <div style={{ marginTop: 12, fontSize: 'var(--fs-meta)', color: err ? 'var(--st-error)' : 'var(--st-running)' }}>{err || msg}</div>
      )}
    </Modal>
  )
}

const stepBtn: React.CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26,
  background: 'transparent', border: 'none', color: 'var(--tx-3)', fontSize: 8, cursor: 'pointer', lineHeight: 1
}

function TeamRow(props: { m: TeamMember; onName: (v: string) => void; onProvider: (v: string) => void }): JSX.Element {
  const { m, onName, onProvider } = props
  const isClaude = m.provider.startsWith('claude')
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-panel-alt)', border: '1px solid var(--bd-card)', borderRadius: 'var(--r-card)', padding: '7px 9px' }}>
      <span style={{ flex: '0 0 26px', height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-chip-idle)', border: '1px solid var(--bd-strong)', borderRadius: 'var(--r-tiny)', fontSize: 14 }}>
        {m.emoji || '🤖'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <input
          value={m.name}
          onChange={(e) => onName(e.target.value)}
          aria-label="Agent name"
          style={{ width: '100%', background: 'transparent', border: 'none', color: 'var(--tx-1)', fontSize: 'var(--fs-body)', fontWeight: 600, outline: 'none', padding: 0 }}
        />
        {m.role && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--tx-5)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.role}</div>}
      </div>
      <select
        value={m.provider}
        onChange={(e) => onProvider(e.target.value)}
        aria-label="Provider"
        style={{
          appearance: 'none', cursor: 'pointer', borderRadius: 'var(--r-chip)', padding: '3px 8px', fontSize: 'var(--fs-meta)', fontWeight: 600,
          background: isClaude ? 'var(--bg-accent-soft)' : 'var(--bg-input)',
          border: `1px solid ${isClaude ? 'var(--bd-accent)' : 'var(--bd-1)'}`,
          color: isClaude ? 'var(--accent-ink)' : 'var(--tx-3)'
        }}
      >
        {PROVIDER_GROUPS.flatMap((g) => g.options).map((o) => <option key={o.id} value={o.id}>{o.id.split('-')[0]}</option>)}
      </select>
    </div>
  )
}

export { SpawnTeamModal }
export default SpawnTeamModal
