import React from 'react'
import { Modal, Button, Icon, InfoTip, AdvancedSection } from '@renderer/ui'
import { ServerRow } from '../components/mcp/ServerRow'
import { JsonCodeBlock } from '../components/mcp/JsonCodeBlock'
import { McpCatalogList } from '../components/mcp/McpCatalogList'
import { McpCatalogPicker } from '../components/mcp/McpCatalogPicker'
import { summarize, metaFor, type McpServerStatus } from '../components/mcp/mcpStatus'
import { CreativeAppsSection } from '../components/mcp/CreativeAppsSection'
import { useMcpCatalog, type McpListEntry, type McpJsonEntry } from '@renderer/lib/mcp'

/**
 * SCREEN 2g — MCP editor, catalog-first.
 *
 * The primary interaction is a CATALOG PICKER: every known server (Built-in /
 * Common / Creative) is a one-click row showing its live present/enabled state,
 * with Add / Enable / Disable / Remove — all routed through the CLI seam
 * (window.api.mcpApply → `autodev mcp <op>`, which propagates to every provider
 * and tags `_meta`). It NEVER hand-writes .mcp.json — that is exactly what the old
 * preset/raw-save path did, and it skipped provider-sync. A "Custom…" entry in the
 * picker covers servers the catalog doesn't list.
 *
 * Below it: a live CONNECTIVITY check (ServerRow, from agentMcpStatus), the
 * detected CREATIVE APPS section (Blender/GIMP, CLI-driven auto-detect), and — as
 * an ADVANCED, collapsed, READ-ONLY view — the raw .mcp.json (JsonCodeBlock). All
 * edits happen through the picker; the raw view is reference only.
 */

const sectionLabel: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-section)',
  fontWeight: 700,
  letterSpacing: '.11em',
  textTransform: 'uppercase',
  color: 'var(--tx-4)'
}

/** locate a server's line in the raw JSON for the failing cross-highlight. */
function findServerLine(json: string, name?: string): number | undefined {
  if (!name) return undefined
  const lines = json.split('\n')
  const needle = `"${name}"`
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) return i + 1
  return undefined
}

export function McpEditorModal(props: {
  agentPath: string
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const { agentPath, open, onClose } = props
  const { catalog } = useMcpCatalog()

  const [current, setCurrent] = React.useState<McpListEntry[]>([])
  const [servers, setServers] = React.useState<McpServerStatus[]>([])
  const [statusError, setStatusError] = React.useState<string | null>(null)
  const [json, setJson] = React.useState('')
  const [checking, setChecking] = React.useState(false)
  const [busyName, setBusyName] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [running, setRunning] = React.useState(false)
  const [restarting, setRestarting] = React.useState(false)

  const fileName = React.useMemo(() => {
    const base = agentPath.split('/').filter(Boolean).pop() || agentPath
    return `${base}/.mcp.json`
  }, [agentPath])

  const loadList = React.useCallback(async (): Promise<void> => {
    try {
      const r = (await window.api.mcpList(agentPath)) as { servers?: McpListEntry[]; error?: string }
      setCurrent(Array.isArray(r?.servers) ? r.servers : [])
    } catch {
      setCurrent([])
    }
    try {
      const raw = (await window.api.readAgentMcp(agentPath)) as { content?: string; error?: string }
      setJson(raw?.error ? '' : raw?.content ?? '')
    } catch {
      setJson('')
    }
    try {
      const st = (await window.api.agentState(agentPath)) as { running?: boolean } | undefined
      setRunning(!!st?.running)
    } catch { /* best effort */ }
  }, [agentPath])

  const recheck = React.useCallback(async (): Promise<void> => {
    setChecking(true)
    setStatusError(null)
    try {
      const r = (await window.api.agentMcpStatus(agentPath)) as { servers?: McpServerStatus[]; error?: string }
      if (r?.error) { setStatusError(r.error); setServers([]) }
      else setServers(r?.servers ?? [])
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : 'connectivity check failed')
    } finally {
      setChecking(false)
    }
  }, [agentPath])

  React.useEffect(() => {
    if (!open) return
    setNotice(null)
    void loadList()
    void recheck()
  }, [open, loadList, recheck])

  // Every mutation goes through the CLI seam, then reloads the list + connectivity.
  const apply = React.useCallback(
    async (op: 'add' | 'enable' | 'disable' | 'remove', name: string, server?: McpJsonEntry): Promise<void> => {
      setBusyName(name)
      setNotice(null)
      try {
        const r = await window.api.mcpApply({ path: agentPath, op, name, server })
        if (!r.ok) { setNotice(r.error || `Failed to ${op} "${name}"`); return }
        await loadList()
        await recheck()
        const verb = op === 'add' ? 'Added' : op === 'remove' ? 'Removed' : op === 'enable' ? 'Enabled' : 'Disabled'
        setNotice(running ? `${verb} "${name}" · restart the agent to apply now.` : `${verb} "${name}" · applies on next task.`)
      } catch (e) {
        setNotice(e instanceof Error ? e.message : `Failed to ${op} "${name}"`)
      } finally {
        setBusyName(null)
      }
    },
    [agentPath, loadList, recheck, running]
  )

  const restart = React.useCallback(async (): Promise<void> => {
    setRestarting(true)
    try {
      await window.api.stopAgent(agentPath)
      await window.api.startAgent(agentPath)
      await recheck()
      setNotice('Agent restarted — MCP changes applied.')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'restart failed')
    } finally {
      setRestarting(false)
    }
  }, [agentPath, recheck])

  const counts = summarize(servers)
  const firstFailing = servers.find((s) => metaFor(s).failing)
  const highlightLine = findServerLine(json, firstFailing?.name)
  const summaryText = statusError
    ? 'connectivity unavailable'
    : `${counts.ready} ready · ${counts.failing} failing${counts.disabled ? ` · ${counts.disabled} disabled` : ''}`

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={700}
      title="MCP servers"
      subtitle={`${fileName} · applies on next task`}
      subtitleMono
      headerRight={
        <Button variant="secondary" size="sm" onClick={() => void recheck()} disabled={checking}>
          <Icon name="refresh" size={12} />
          {checking ? 'Rechecking…' : 'Recheck'}
        </Button>
      }
      footer={
        <>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: '10.5px',
              color: notice ? 'var(--tx-2)' : 'var(--tx-dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {notice || 'add / enable / disable / remove — every change is applied through the CLI'}
          </span>
          {running && (
            <Button variant="secondary" onClick={() => void restart()} disabled={restarting}>
              {restarting ? 'Restarting…' : 'Restart to apply'}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>Done</Button>
        </>
      }
    >
      {/* ── CATALOG PICKER (primary) ──────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <span style={sectionLabel}>Servers</span>
        <InfoTip label="MCP servers" width={290}>
          Each server is a tool your agent can call — a shared office, a memory store, the
          filesystem, a creative app. Add or toggle them below; every change is applied through the
          AutoDev CLI (which syncs it to every provider), not a hand-edit of <code>.mcp.json</code>.
        </InfoTip>
        <div style={{ marginLeft: 'auto' }}>
          <McpCatalogPicker
            buttonLabel="Add custom…"
            exclude={new Set(current.map((e) => e.name))}
            onPick={(p) => void apply('add', p.name, p.server)}
          />
        </div>
      </div>

      {catalog.length === 0 ? (
        <div style={{ padding: '14px 12px', fontSize: 'var(--fs-desc)', color: 'var(--tx-4)', textAlign: 'center' }}>
          Loading the MCP catalog…
        </div>
      ) : (
        <McpCatalogList catalog={catalog} current={current} busyName={busyName} onApply={apply} />
      )}

      {/* ── CONNECTIVITY (live status) ────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '18px 0 8px' }}>
        <span style={sectionLabel}>Connectivity</span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10.5px',
            color: counts.failing ? 'var(--st-error)' : 'var(--tx-dim)'
          }}
        >
          {summaryText}
        </span>
      </div>
      {statusError ? (
        <div style={{ padding: '10px 12px', background: 'var(--st-error-wash)', border: '1px solid var(--st-error-bd)', borderRadius: 'var(--r-card)', fontSize: 'var(--fs-desc)', color: 'var(--st-error-bright)' }}>
          {statusError}
        </div>
      ) : servers.length === 0 ? (
        <div style={{ padding: '12px', fontSize: 'var(--fs-desc)', color: 'var(--tx-4)', textAlign: 'center' }}>
          {checking ? 'Probing servers…' : 'No MCP servers configured for this agent.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {servers.map((s) => (
            <ServerRow key={s.name} server={s} onMenu={() => void recheck()} />
          ))}
        </div>
      )}

      {/* ── DETECTED CREATIVE APPS (Blender / GIMP → enable as MCP) ── */}
      <CreativeAppsSection
        agentPath={agentPath}
        open={open}
        onMcpChanged={() => {
          void loadList()
          void recheck()
        }}
      />

      {/* ── RAW .MCP.JSON — advanced, read-only reference ─────────── */}
      <AdvancedSection label="Raw .mcp.json" hint="Read-only view of the file the CLI maintains. Edits happen through the picker above.">
        <div style={{ marginTop: 8 }}>
          <JsonCodeBlock value={json} onChange={() => {}} readOnly highlightLine={highlightLine} />
        </div>
      </AdvancedSection>
    </Modal>
  )
}

export default McpEditorModal
