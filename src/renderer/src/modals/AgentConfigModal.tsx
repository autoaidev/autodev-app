import React, { useCallback, useEffect, useState } from 'react'
import { Modal, Button, SegmentedTabs } from '@renderer/ui'
import { McpEditorModal } from './McpEditorModal'
import { ModelSelect } from '@renderer/components/ModelSelect'
import { NativeSelect } from '@renderer/components/NativeSelect'
import { actions } from '@renderer/services/agentStore'

/**
 * SCREEN 2e — Agent Setup, demoted from a whole tab to a modal.
 *
 * The thesis: config is edited rarely, so it lives behind a modal, not a tab.
 * Wired to the REAL settings surface from CURRENT-APP.md:
 *   agentState(path)                    — seed name / provider / sessionName
 *   runCli(['config','get'|'set',…])    — session name, provider, model, file-browser
 *   agentMcpStatus(path)                — the "N configured · X missing" MCP summary
 *   McpEditorModal (2g)                 — "Edit .mcp.json" opens the status-first editor
 *
 * Provider is split the way the mockup does: a PROVIDER segmented control
 * (Interactive | Headless CLI | SDK·API = the run *variant*) × an ENGINE
 * dropdown (Claude/Copilot/OpenCode/Grok = the *vendor*), recombined into the
 * real provider id (e.g. grok + interactive → `grok-tui`). Only valid
 * vendor×variant combos are offered.
 */

interface AgentState { path: string; name: string; provider?: string; sessionName?: string; running?: boolean }
interface McpStat { name: string; status: string }

type Variant = 'interactive' | 'headless' | 'sdk'

// The real provider ids, tagged with vendor + variant so the two controls can
// recombine into a valid id (and disable combos that don't exist).
const PROVIDERS: Array<{ id: string; vendor: string; variant: Variant }> = [
  { id: 'claude-tui', vendor: 'claude', variant: 'interactive' },
  { id: 'claude-cli', vendor: 'claude', variant: 'headless' },
  { id: 'copilot-cli', vendor: 'copilot', variant: 'headless' },
  { id: 'copilot-sdk', vendor: 'copilot', variant: 'sdk' },
  { id: 'opencode-cli', vendor: 'opencode', variant: 'headless' },
  { id: 'opencode-sdk', vendor: 'opencode', variant: 'sdk' },
  { id: 'grok-cli', vendor: 'grok', variant: 'headless' },
  { id: 'grok-tui', vendor: 'grok', variant: 'interactive' }
]
const VENDORS: Array<{ id: string; label: string }> = [
  { id: 'claude', label: 'Claude' }, { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'opencode', label: 'OpenCode' }, { id: 'grok', label: 'Grok' }
]
const VARIANTS: Array<{ id: Variant; label: string }> = [
  { id: 'interactive', label: 'Interactive' }, { id: 'headless', label: 'Headless CLI' }, { id: 'sdk', label: 'SDK · API' }
]
const VARIANT_HINT: Record<Variant, string> = {
  interactive: 'Interactive gives a terminal you can watch and log into.',
  headless: 'Headless CLI runs the loop with no attached terminal.',
  sdk: 'SDK · API drives the model directly — needs an API key.'
}
const MODEL_KEY: Record<string, string> = { claude: 'claudeModel', opencode: 'opencodeModel', copilot: 'copilotModel', grok: 'grokModel', dummy: 'dummyModel' }
const modelKeyFor = (p: string): string => MODEL_KEY[p.split('-')[0]] ?? 'claudeModel'

const parse = (id?: string): { vendor: string; variant: Variant } => {
  const p = PROVIDERS.find((x) => x.id === id)
  return p ? { vendor: p.vendor, variant: p.variant } : { vendor: 'claude', variant: 'interactive' }
}
// Recombine vendor + wanted variant into the nearest valid provider id.
const resolveProvider = (vendor: string, variant: Variant): string => {
  const exact = PROVIDERS.find((p) => p.vendor === vendor && p.variant === variant)
  if (exact) return exact.id
  return PROVIDERS.find((p) => p.vendor === vendor)?.id ?? 'claude-tui'
}
const variantsFor = (vendor: string): Set<Variant> => new Set(PROVIDERS.filter((p) => p.vendor === vendor).map((p) => p.variant))

const label: React.CSSProperties = {
  display: 'block', fontSize: 'var(--fs-section)', fontWeight: 600, letterSpacing: 'var(--ls-section)',
  textTransform: 'uppercase', color: 'var(--tx-dim)', marginBottom: 6
}
const inputStyle: React.CSSProperties = {
  width: '100%', background: 'var(--bg-input)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)',
  color: 'var(--tx-1)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)', padding: '7px 9px', outline: 'none'
}

/**
 * `mode`:
 *   'edit' (default) — edit an existing agent's config at `agentPath`.
 *   'new'            — CREATE one local agent: pick a folder, choose provider /
 *                      model, then `init` + register it. No agent exists yet, so
 *                      the running-only "Save & restart", the MCP summary and the
 *                      UI-only timeout controls are hidden. `onCreated(path)` fires
 *                      with the new workspace path so the caller can select it.
 */
function AgentConfigModal(props: {
  agentPath: string
  open: boolean
  onClose: () => void
  mode?: 'edit' | 'new'
  onCreated?: (path: string) => void
  /** 'new' mode only — pre-fill the Folder field so the created agent lands in a
   *  specific place (e.g. "Spawn new agent" from a folder group header). */
  initialFolder?: string
}): JSX.Element {
  const { agentPath, open, onClose, mode = 'edit', onCreated, initialFolder } = props
  const isNew = mode === 'new'
  const [name, setName] = useState('')
  const [running, setRunning] = useState(false)
  const [sessionName, setSessionName] = useState('')
  const [vendor, setVendor] = useState('claude')
  const [variant, setVariant] = useState<Variant>('interactive')
  const [model, setModel] = useState('')
  const [fileBrowser, setFileBrowser] = useState(false)
  // 'new' mode only — the folder the single agent is created in (picked/typed).
  const [folder, setFolder] = useState('')
  // TODO(redesign): CURRENT-APP.md exposes no config key for task timeout /
  // retry-on-timeout — these are UI-only until a settings key exists.
  const [timeout, setTimeoutMin] = useState(30)
  const [retry, setRetry] = useState(true)
  const [mcp, setMcp] = useState<{ configured: number; missing: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [showMcp, setShowMcp] = useState(false)

  const provider = resolveProvider(vendor, variant)

  // Seed from the live agent state + persisted config on open. In 'new' mode there
  // is no agent yet, so reset to a clean single-agent form instead of reading state.
  useEffect(() => {
    if (!open) return
    setStatus('')
    if (isNew) {
      setName(''); setRunning(false); setSessionName('')
      setVendor('claude'); setVariant('interactive')
      // Pre-scope to the caller's folder ("Spawn new agent" from a group header)
      // when provided, else a clean empty field.
      setModel(''); setFileBrowser(false); setFolder(initialFolder ?? '')
      return
    }
    void (async () => {
      const a = (await window.api.agentState(agentPath)) as AgentState
      setName(a?.name || agentPath.split('/').pop() || '')
      setRunning(!!a?.running)
      setSessionName(a?.sessionName ?? '')
      const pr = parse(a?.provider)
      setVendor(pr.vendor); setVariant(pr.variant)
    })()
    void window.api.runCli(['config', 'get', 'enableFileBrowser', agentPath])
      .then((r) => setFileBrowser((r.stdout || '').trim() === 'true'))
  }, [open, agentPath, isNew, initialFolder])

  // Load the current model whenever the resolved provider (hence model key) changes.
  // 'new' mode keeps `model` as local UI state (nothing persisted to read yet).
  useEffect(() => {
    if (!open || isNew) return
    void window.api.runCli(['config', 'get', modelKeyFor(provider), agentPath])
      .then((r) => setModel((r.stdout || '').trim()))
  }, [open, agentPath, provider, isNew])

  // Live MCP summary — count configured servers + which are unreachable/missing.
  useEffect(() => {
    if (!open || isNew) return
    void (async () => {
      const r = (await window.api.agentMcpStatus(agentPath)) as { servers?: McpStat[]; error?: string }
      const servers = r?.servers ?? []
      const missing = servers.filter((s) => s.status === 'missing' || s.status === 'unreachable').map((s) => s.name)
      setMcp({ configured: servers.length, missing })
    })()
  }, [open, agentPath, showMcp, isNew])

  const changeVendor = (v: string): void => {
    setVendor(v)
    // Keep the current variant if the new vendor supports it, else snap to a valid one.
    if (!variantsFor(v).has(variant)) setVariant([...variantsFor(v)][0])
  }

  // Persist all fields; returns true on success. Shared by Save and Save & restart.
  const persist = useCallback(async (): Promise<boolean> => {
    const writes: Array<[string, string]> = [['provider', provider], [modelKeyFor(provider), model], ['enableFileBrowser', fileBrowser ? 'true' : 'false']]
    if (sessionName !== '') writes.push(['sessionName', sessionName])
    for (const [k, v] of writes) {
      const r = await window.api.runCli(['config', 'set', k, v, agentPath])
      if (r.code !== 0) { setStatus(r.stderr || `Save failed writing "${k}"`); return false }
    }
    return true
  }, [provider, model, fileBrowser, sessionName, agentPath])

  const save = useCallback(async (): Promise<void> => {
    setBusy(true); setStatus('')
    const ok = await persist()
    setBusy(false)
    if (ok) setStatus(running ? 'Saved — restart the agent to apply on the next task.' : 'Saved.')
  }, [persist, running])

  // Save & restart — persist, then bounce the running loop so the new model/provider
  // takes effect NOW instead of leaving the user to remember (model applies on restart).
  // Delegates to the canonical store restart (stop → gap → start), NOT a raw
  // stopAgent+startAgent: stop() is async (SIGINT, child leaves _procs on exit), so an
  // immediate start() sees the still-live child and no-ops as `alreadyRunning`, never
  // actually restarting. actions.restart inserts the settle gap and reloads the fleet.
  // start() with no `-p` re-reads the provider we just wrote, so the new config applies.
  const saveAndRestart = useCallback(async (): Promise<void> => {
    setBusy(true); setStatus('')
    const ok = await persist()
    if (!ok) { setBusy(false); return }
    try {
      await actions.restart(agentPath)
      setStatus('Saved — restarting to apply the new model.')
    } catch (e) {
      setStatus(`Saved, but restart failed: ${(e as Error)?.message ?? 'unknown error'}`)
    }
    setBusy(false)
  }, [persist, agentPath])

  // Pick the folder the new single agent lives in ('new' mode only).
  const pickFolder = useCallback(async (): Promise<void> => {
    const f = await window.api.pickFolder()
    if (f) { setFolder(f); setStatus('') }
  }, [])

  // Create ONE local agent in the chosen folder ('new' mode): idempotent `init`
  // (writes TODO.md + .autodev/settings.json + .gitignore — never touches your
  // source or .mcp.json), persist the model / file-browser, then register it in the
  // sidebar. `run` also starts its loop. Mirrors the CLI path MakeAppView uses.
  const create = useCallback(async (run = false): Promise<void> => {
    const path = folder.trim().replace(/\/+$/, '')
    if (!path) { setStatus('Pick a folder for the new agent first.'); return }
    setBusy(true); setStatus('')
    const initArgs = ['init', path, '--provider', provider]
    if (sessionName.trim()) initArgs.push('--session-name', sessionName.trim())
    const r = await window.api.runCli(initArgs)
    if (r.code !== 0) { setStatus(r.stderr?.trim() || `Couldn't initialize ${path}.`); setBusy(false); return }
    if (model.trim()) await window.api.runCli(['config', 'set', modelKeyFor(provider), model.trim(), path])
    if (fileBrowser) await window.api.runCli(['config', 'set', 'enableFileBrowser', 'true', path])
    const added = (await window.api.addAgent(path)) as { error?: string }
    if (added?.error) { setStatus(added.error); setBusy(false); return }
    if (run) { try { await window.api.startAgent(path, provider) } catch { /* surfaced on the next fleet reload */ } }
    setBusy(false)
    onCreated?.(path)
    onClose()
  }, [folder, provider, sessionName, model, fileBrowser, onCreated, onClose])

  const availableVariants = variantsFor(vendor)
  const agentName = sessionName || name

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        width={492}
        title={isNew
          ? <>New agent <span style={{ color: 'var(--tx-5)', fontWeight: 400 }}>· one local agent</span></>
          : <>{agentName} <span style={{ color: 'var(--tx-5)', fontWeight: 400 }}>· setup</span></>}
        subtitle={isNew ? 'creates a single agent in a folder you pick' : 'changes apply to the next task'}
        subtitleMono
        footer={
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {status && <span style={{ fontSize: 'var(--fs-meta)', color: status.startsWith('Saved') && !/fail|couldn|pick/i.test(status) ? 'var(--st-running)' : 'var(--st-error)' }}>{status}</span>}
            <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            {isNew ? (
              <>
                <Button variant="secondary" onClick={() => void create(true)} disabled={busy || !folder.trim()}>{busy ? '…' : 'Create & start'}</Button>
                <Button variant="primary" onClick={() => void create(false)} disabled={busy || !folder.trim()}>{busy ? 'Creating…' : 'Create agent'}</Button>
              </>
            ) : (
              <>
                {running && <Button variant="secondary" onClick={() => void saveAndRestart()} disabled={busy}>{busy ? '…' : 'Save & restart'}</Button>}
                <Button variant="primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
              </>
            )}
          </div>
        }
      >
        {/* FOLDER (new mode only) — where the single agent's workspace is created. */}
        {isNew && (
          <div style={{ marginBottom: 14 }}>
            <span style={label}>Folder</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={folder}
                onChange={(e) => { setFolder(e.target.value); setStatus('') }}
                placeholder="/path/to/agent/folder"
                style={{ ...inputStyle, flex: 1 }}
              />
              <Button variant="secondary" onClick={() => void pickFolder()} disabled={busy}>Browse</Button>
            </div>
            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginTop: 5 }}>
              A new AutoDev workspace is initialized here (TODO.md + .autodev). Existing files are left untouched.
            </div>
          </div>
        )}

        {/* SESSION DISPLAY NAME */}
        <div style={{ marginBottom: 14 }}>
          <span style={label}>Session display name</span>
          <input value={sessionName} onChange={(e) => setSessionName(e.target.value)} placeholder={name || '(folder name)'} style={inputStyle} />
        </div>

        {/* PROVIDER (run variant) */}
        <div style={{ marginBottom: 6 }}>
          <span style={label}>Provider</span>
          <SegmentedTabs
            variant="segmented"
            value={variant}
            onChange={(v) => { if (availableVariants.has(v as Variant)) setVariant(v as Variant) }}
            tabs={VARIANTS.map((v) => ({ id: v.id, label: availableVariants.has(v.id) ? v.label : <span style={{ opacity: 0.4 }}>{v.label}</span> }))}
          />
        </div>
        <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginBottom: 14 }}>{VARIANT_HINT[variant]}</div>

        {/* ENGINE + MODEL */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <span style={label}>Engine</span>
            <NativeSelect value={vendor} onChange={(e) => changeVendor(e.target.value)}>
              {VENDORS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </NativeSelect>
          </div>
          <div style={{ flex: 1 }}>
            <span style={label}>Model</span>
            <ModelSelect vendor={vendor} value={model} onChange={setModel} />
            {/* Mirror the inline row's "saves on select": in the modal, model (like
                every field) is batched behind the explicit Save/Create button. */}
            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginTop: 5 }}>
              {isNew ? 'Applies when you Create' : 'Applies when you Save'}
            </div>
          </div>
        </div>

        {/* TASK TIMEOUT (UI-only — see TODO above). Hidden in 'new' mode: it doesn't
            persist anywhere yet, so it would be a dead control on a create form. */}
        {!isNew && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={label}>Task timeout</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-meta)', color: 'var(--tx-3)' }}>{timeout} min</span>
            </div>
            <input type="range" min={5} max={90} step={5} value={timeout} onChange={(e) => setTimeoutMin(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--accent)' }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 'var(--fs-meta)', color: 'var(--tx-4)', cursor: 'pointer' }}>
              <input type="checkbox" checked={retry} onChange={(e) => setRetry(e.target.checked)} />
              Retry once on timeout, then ask me
            </label>
          </div>
        )}

        {/* ENABLE FILE BROWSER */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginBottom: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={fileBrowser} onChange={(e) => setFileBrowser(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            <span style={{ fontSize: 'var(--fs-body)', color: 'var(--tx-1)' }}>Enable file browser</span>
            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)' }}>lets the office browse &amp; edit this agent's files</div>
          </span>
        </label>

        {/* MCP SERVERS row → opens the 2g editor. Hidden in 'new' mode: the
            workspace doesn't exist until Create, so there's nothing to summarize or
            edit yet — MCP is configured from the agent's Setup after it's created. */}
        {!isNew && (
          <>
            <div style={{ borderTop: '1px solid var(--bd-card)', margin: '2px 0 14px' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <span style={{ ...label, marginBottom: 3 }}>MCP servers</span>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-meta)', color: 'var(--tx-dim)' }}>
                  {mcp == null
                    ? 'checking…'
                    : <>{mcp.configured} configured{mcp.missing.length > 0 && <span style={{ color: 'var(--st-error)' }}> · {mcp.missing.join(', ')} {mcp.missing.length === 1 ? 'missing' : 'unreachable'}</span>}</>}
                </div>
              </div>
              <Button variant="secondary" style={{ marginLeft: 'auto' }} onClick={() => setShowMcp(true)}>Edit .mcp.json</Button>
            </div>
          </>
        )}
      </Modal>

      <McpEditorModal agentPath={agentPath} open={showMcp} onClose={() => setShowMcp(false)} />
    </>
  )
}

export { AgentConfigModal }
export default AgentConfigModal
