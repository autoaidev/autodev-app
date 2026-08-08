import React, { useCallback, useEffect, useState } from 'react'
import { Modal, Button, SegmentedTabs } from '@renderer/ui'
import { McpEditorModal } from './McpEditorModal'

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
const MODEL_KEY: Record<string, string> = { claude: 'claudeModel', opencode: 'opencodeModel', copilot: 'copilotModel', grok: 'grokModel' }
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
const selectStyle: React.CSSProperties = { ...inputStyle, appearance: 'none', cursor: 'pointer' }

function AgentConfigModal(props: { agentPath: string; open: boolean; onClose: () => void }): JSX.Element {
  const { agentPath, open, onClose } = props
  const [name, setName] = useState('')
  const [running, setRunning] = useState(false)
  const [sessionName, setSessionName] = useState('')
  const [vendor, setVendor] = useState('claude')
  const [variant, setVariant] = useState<Variant>('interactive')
  const [model, setModel] = useState('')
  const [fileBrowser, setFileBrowser] = useState(false)
  // TODO(redesign): CURRENT-APP.md exposes no config key for task timeout /
  // retry-on-timeout — these are UI-only until a settings key exists.
  const [timeout, setTimeoutMin] = useState(30)
  const [retry, setRetry] = useState(true)
  const [mcp, setMcp] = useState<{ configured: number; missing: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [showMcp, setShowMcp] = useState(false)

  const provider = resolveProvider(vendor, variant)

  // Seed from the live agent state + persisted config on open.
  useEffect(() => {
    if (!open) return
    setStatus('')
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
  }, [open, agentPath])

  // Load the current model whenever the resolved provider (hence model key) changes.
  useEffect(() => {
    if (!open) return
    void window.api.runCli(['config', 'get', modelKeyFor(provider), agentPath])
      .then((r) => setModel((r.stdout || '').trim()))
  }, [open, agentPath, provider])

  // Live MCP summary — count configured servers + which are unreachable/missing.
  useEffect(() => {
    if (!open) return
    void (async () => {
      const r = (await window.api.agentMcpStatus(agentPath)) as { servers?: McpStat[]; error?: string }
      const servers = r?.servers ?? []
      const missing = servers.filter((s) => s.status === 'missing' || s.status === 'unreachable').map((s) => s.name)
      setMcp({ configured: servers.length, missing })
    })()
  }, [open, agentPath, showMcp])

  const changeVendor = (v: string): void => {
    setVendor(v)
    // Keep the current variant if the new vendor supports it, else snap to a valid one.
    if (!variantsFor(v).has(variant)) setVariant([...variantsFor(v)][0])
  }

  const save = useCallback(async (): Promise<void> => {
    setBusy(true); setStatus('')
    const writes: Array<[string, string]> = [['provider', provider], [modelKeyFor(provider), model], ['enableFileBrowser', fileBrowser ? 'true' : 'false']]
    if (sessionName !== '') writes.push(['sessionName', sessionName])
    for (const [k, v] of writes) {
      const r = await window.api.runCli(['config', 'set', k, v, agentPath])
      if (r.code !== 0) { setBusy(false); setStatus(r.stderr || `Save failed writing "${k}"`); return }
    }
    setBusy(false)
    setStatus(running ? 'Saved — restart the agent to apply on the next task.' : 'Saved.')
  }, [provider, model, fileBrowser, sessionName, agentPath, running])

  const availableVariants = variantsFor(vendor)
  const agentName = sessionName || name

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        width={492}
        title={<>{agentName} <span style={{ color: 'var(--tx-5)', fontWeight: 400 }}>· setup</span></>}
        subtitle="changes apply to the next task"
        subtitleMono
        footer={
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {status && <span style={{ fontSize: 'var(--fs-meta)', color: status.startsWith('Saved') ? 'var(--st-running)' : 'var(--st-error)' }}>{status}</span>}
            <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        }
      >
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
            <select value={vendor} onChange={(e) => changeVendor(e.target.value)} style={selectStyle}>
              {VENDORS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <span style={label}>Model ({modelKeyFor(provider)})</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="(provider default)" style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-meta)' }} />
          </div>
        </div>

        {/* TASK TIMEOUT (UI-only — see TODO above) */}
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

        {/* ENABLE FILE BROWSER */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginBottom: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={fileBrowser} onChange={(e) => setFileBrowser(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            <span style={{ fontSize: 'var(--fs-body)', color: 'var(--tx-1)' }}>Enable file browser</span>
            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)' }}>lets the office browse &amp; edit this agent's files</div>
          </span>
        </label>

        <div style={{ borderTop: '1px solid var(--bd-card)', margin: '2px 0 14px' }} />

        {/* MCP SERVERS row → opens the 2g editor */}
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
      </Modal>

      <McpEditorModal agentPath={agentPath} open={showMcp} onClose={() => setShowMcp(false)} />
    </>
  )
}

export { AgentConfigModal }
export default AgentConfigModal
