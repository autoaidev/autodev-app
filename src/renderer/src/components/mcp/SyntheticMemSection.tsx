import React from 'react'
import { Button, Icon, InfoTip, Pill } from '@renderer/ui'
import type { McpCatalogServer, McpListEntry } from '@renderer/lib/mcp'

/**
 * SyntheticMemSection — the app surface for the OPTIONAL SyntheticMem remote MCP
 * server (permanent, provenance-aware agent memory). Mirrors CreativeAppsSection:
 * everything routes through the bundled CLI (the single source of truth). The
 * server URL + auth metadata come from the CLI catalog entry (window.api.mcpCatalog,
 * kind:'remote'); enabling writes the remote server via window.api.mcpApply (→
 * `autodev mcp add syntheticmem --url … --header=…`, propagated to every provider),
 * and the free 24h demo key is fetched via the CLI (`autodev mcp demo-key --json`).
 * This component never hand-writes .mcp.json and never embeds the server URL.
 */

const SYNTHETICMEM_ID = 'syntheticmem'

const sectionLabel: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-section)',
  fontWeight: 700,
  letterSpacing: '.11em',
  textTransform: 'uppercase',
  color: 'var(--tx-4)'
}
const fieldInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  color: 'var(--tx-1)',
  background: 'var(--bg-input)',
  border: '1px solid var(--bd-1)',
  borderRadius: 'var(--r-input)',
  padding: '6px 8px',
  outline: 'none'
}

export function SyntheticMemSection({
  agentPath,
  catalog,
  current,
  onMcpChanged
}: {
  agentPath: string
  catalog: McpCatalogServer[]
  current: McpListEntry[]
  onMcpChanged: () => void
}): React.JSX.Element | null {
  const entry = React.useMemo(() => catalog.find((s) => s.id === SYNTHETICMEM_ID && s.kind === 'remote'), [catalog])
  const existing = React.useMemo(() => current.find((e) => e.name === SYNTHETICMEM_ID), [current])
  const enabled = !!existing && existing.enabled !== false

  const [key, setKey] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [demoBusy, setDemoBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  // On an older CLI (no remote catalog entry) hide the section entirely.
  if (!entry) return null

  const auth = entry.auth
  const url = typeof entry.server.url === 'string' ? entry.server.url : ''
  const header = auth?.header || 'Authorization'
  const registerUrl = auth?.registerUrl || 'https://syntheticmem.com/app'

  const enable = async (useKey: string, fromDemo = false): Promise<void> => {
    const k = useKey.trim()
    if (!k) {
      setError('Paste an agt_ key, or get a free 24h demo key.')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const server = { type: 'http' as const, url, headers: { [header]: `Bearer ${k}` } }
      const r = await window.api.mcpApply({ path: agentPath, op: 'add', name: SYNTHETICMEM_ID, server })
      if (!r.ok) {
        setError(r.error || 'Failed to enable SyntheticMem')
        return
      }
      setNotice(
        fromDemo
          ? 'Enabled with a free demo key (expires in ~24h). Register to keep memories permanently.'
          : 'SyntheticMem enabled — synced to every provider.'
      )
      onMcpChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to enable SyntheticMem')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await window.api.mcpApply({ path: agentPath, op: 'remove', name: SYNTHETICMEM_ID })
      if (!r.ok) {
        setError(r.error || 'Failed to remove SyntheticMem')
        return
      }
      setKey('')
      setNotice('SyntheticMem removed.')
      onMcpChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove SyntheticMem')
    } finally {
      setBusy(false)
    }
  }

  // Free 24h demo key — fetched through the CLI (single source of truth for the
  // endpoint). Fills the field AND enables in one click.
  const getDemoKey = async (): Promise<void> => {
    setDemoBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = (await window.api.runCli(['mcp', 'demo-key', '--json'], agentPath)) as {
        stdout?: string
        stderr?: string
        code?: number
      }
      let parsed: { key?: string; ttl_hours?: number; error?: string } = {}
      try { parsed = JSON.parse((r?.stdout || '').trim()) } catch { /* fall through */ }
      if (parsed.error || !parsed.key) {
        setError(parsed.error || (r?.stderr || 'Could not fetch a demo key').trim())
        return
      }
      setKey(parsed.key)
      await enable(parsed.key, true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not fetch a demo key')
    } finally {
      setDemoBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={sectionLabel}>Hosted memory</span>
        <InfoTip label="Permanent agent memory" width={300}>
          Optional. SyntheticMem gives this agent permanent, provenance-aware memory + semantic
          recall over a remote MCP server. Paste a key or grab a free 24h demo key — enabling
          propagates the server to every provider through the AutoDev CLI, not a hand-edit of{' '}
          <code>.mcp.json</code>.
        </InfoTip>
      </div>

      <div
        style={{
          padding: '12px 14px',
          background: 'var(--bg-elev)',
          border: '1px solid var(--bd-1)',
          borderRadius: 'var(--r-card)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 'var(--fs-body)', fontWeight: 700, color: 'var(--tx-1)' }}>{entry.name}</span>
          <div style={{ marginLeft: 'auto' }}>
            {enabled ? (
              <Pill variant="green" selected>
                <Icon name="check" size={11} /> Enabled
              </Pill>
            ) : (
              <Pill variant="neutral">Optional</Pill>
            )}
          </div>
        </div>

        <div style={{ marginTop: 4, fontSize: 'var(--fs-desc)', color: 'var(--tx-4)', lineHeight: 1.5 }}>
          {entry.description || 'Permanent, provenance-aware memory + semantic recall (remote MCP).'}{' '}
          <a href={registerUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 600 }}>
            Register for a permanent key →
          </a>
        </div>

        {!enabled && (
          <div style={{ marginTop: 10 }}>
            <label
              style={{
                display: 'block',
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: '.08em',
                textTransform: 'uppercase',
                color: 'var(--tx-4)',
                marginBottom: 3
              }}
            >
              Agent key (agt_…)
            </label>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="agt_…"
              spellCheck={false}
              autoComplete="off"
              style={fieldInput}
            />
          </div>
        )}

        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {enabled ? (
            <Button variant="secondary" size="sm" onClick={() => void remove()} disabled={busy}>
              <Icon name="trash" size={12} />
              {busy ? 'Removing…' : 'Remove'}
            </Button>
          ) : (
            <>
              <Button variant="primary" size="sm" onClick={() => void enable(key)} disabled={busy || demoBusy}>
                <Icon name="sparkle" size={12} />
                {busy ? 'Enabling…' : 'Enable with my key'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void getDemoKey()} disabled={busy || demoBusy}>
                {demoBusy ? 'Fetching…' : 'Get a free 24h demo key'}
              </Button>
            </>
          )}
        </div>

        {error && (
          <div
            style={{
              marginTop: 8,
              padding: '7px 10px',
              background: 'var(--st-error-soft)',
              border: '1px solid var(--st-error-bd)',
              borderRadius: 'var(--r-card)',
              fontSize: 'var(--fs-desc)',
              color: 'var(--st-error-bright, var(--st-error))'
            }}
          >
            {error}
          </div>
        )}
        {notice && !error && (
          <div style={{ marginTop: 8, fontSize: 'var(--fs-desc)', color: 'var(--tx-3)', lineHeight: 1.5 }}>{notice}</div>
        )}
      </div>
    </div>
  )
}

export default SyntheticMemSection
