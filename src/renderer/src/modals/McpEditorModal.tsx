import React from 'react'
import { Modal, Button, Icon, InfoTip, ContextMenu, SegmentedTabs, type ContextMenuEntry } from '@renderer/ui'
import { ServerRow } from '../components/mcp/ServerRow'
import { JsonCodeBlock } from '../components/mcp/JsonCodeBlock'
import { McpCatalogList } from '../components/mcp/McpCatalogList'
import { McpCatalogPicker } from '../components/mcp/McpCatalogPicker'
import { summarize, metaFor, type McpServerStatus } from '../components/mcp/mcpStatus'
import { CreativeAppsSection } from '../components/mcp/CreativeAppsSection'
import { SyntheticMemSection } from '../components/mcp/SyntheticMemSection'
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
 * The body is split across three TABS (SegmentedTabs) so each section fits inside
 * the modal's own scroll instead of stacking into one over-tall column:
 *   - Servers      — the add/toggle surface (catalog picker + list + creative apps
 *                    + SyntheticMem).
 *   - Connectivity — the live ServerRow status list + the per-server `⋯` menu
 *                    (enable/disable/remove/recheck/list-tools) and its inline
 *                    advertised-tools panel.
 *   - Raw JSON     — the read-only .mcp.json view (JsonCodeBlock) with the
 *                    failing-server cross-highlight.
 * The header (Recheck) and footer (notice + Restart + Done) stay OUTSIDE the tabs
 * since they apply to all. All tab panels stay mounted (hidden via `display`) so
 * switching tabs never loses state (detect results, open tool panels, scroll).
 */

const sectionLabel: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-section)',
  fontWeight: 700,
  letterSpacing: '.11em',
  textTransform: 'uppercase',
  color: 'var(--tx-4)'
}

type TabId = 'servers' | 'connectivity' | 'raw'

/** locate a server's line in the raw JSON for the failing cross-highlight. */
function findServerLine(json: string, name?: string): number | undefined {
  if (!name) return undefined
  const lines = json.split('\n')
  const needle = `"${name}"`
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) return i + 1
  return undefined
}

type ToolInfo = { name: string; description?: string }

/** Inline advertised-tools panel shown under a server row in the Connectivity
 *  tab — loading spinner, a clear error, or the tool count + each tool's name
 *  (mono) and truncated description (muted). */
function ToolsPanel({
  name,
  loading,
  error,
  tools
}: {
  name: string
  loading: boolean
  error?: string
  tools?: ToolInfo[]
}): React.JSX.Element {
  return (
    <div
      style={{
        margin: '-2px 10px 6px',
        background: 'var(--bg-panel-alt)',
        border: '1px solid var(--bd-card)',
        borderRadius: 'var(--r-input)',
        padding: '9px 11px'
      }}
    >
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--fs-desc)', color: 'var(--tx-4)' }}>
          <Icon name="refresh" size={11} />
          Probing “{name}” for tools…
        </div>
      ) : error ? (
        <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--st-error-bright)' }}>{error}</div>
      ) : !tools || tools.length === 0 ? (
        <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-4)' }}>This server advertises no tools.</div>
      ) : (
        <>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-micro)',
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: 'var(--tx-dim)',
              marginBottom: 7
            }}
          >
            {tools.length} tool{tools.length === 1 ? '' : 's'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {tools.map((t) => (
              <div key={t.name} style={{ display: 'flex', alignItems: 'baseline', gap: 9, minWidth: 0 }}>
                <span
                  style={{
                    flex: 'none',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '10.5px',
                    color: 'var(--tx-1)',
                    fontWeight: 600
                  }}
                >
                  {t.name}
                </span>
                {t.description && (
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 'var(--fs-desc)',
                      color: 'var(--tx-4)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                    title={t.description}
                  >
                    {t.description}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function McpEditorModal(props: {
  agentPath: string
  open: boolean
  onClose: () => void
  /** When this editor is scoped to an office CHARACTER, these enable the one-click
   *  PERMANENT SyntheticMem mint (the office mints against the character's api_key).
   *  Absent for a LOCAL agent — SyntheticMem then keeps its paste/demo-key flow. */
  officeSlug?: string
  agentId?: string
}): React.JSX.Element {
  const { agentPath, open, onClose, officeSlug, agentId } = props
  const { catalog } = useMcpCatalog()

  // Remote servers that require a bearer key (SyntheticMem) can't be one-click
  // "Add"ed without first collecting the key, so they get their own section below
  // and are dropped from the generic catalog list + "Add custom…" picker.
  const pickableCatalog = React.useMemo(() => catalog.filter((s) => !(s.kind === 'remote' && s.auth)), [catalog])

  const [current, setCurrent] = React.useState<McpListEntry[]>([])
  const [servers, setServers] = React.useState<McpServerStatus[]>([])
  const [statusError, setStatusError] = React.useState<string | null>(null)
  const [json, setJson] = React.useState('')
  const [checking, setChecking] = React.useState(false)
  const [busyName, setBusyName] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [running, setRunning] = React.useState(false)
  const [restarting, setRestarting] = React.useState(false)
  const [tab, setTab] = React.useState<TabId>('servers')

  // ── Per-server `⋯` menu (which server + its anchor element) ──────────────
  const [menu, setMenu] = React.useState<{ server: McpServerStatus; anchor: HTMLElement } | null>(null)

  // ── "List tools…" inline panels, keyed by server name ────────────────────
  const [toolsOpen, setToolsOpen] = React.useState<Record<string, boolean>>({})
  const [toolsByName, setToolsByName] = React.useState<Record<string, ToolInfo[]>>({})
  const [toolsLoading, setToolsLoading] = React.useState<Record<string, boolean>>({})
  const [toolsError, setToolsError] = React.useState<Record<string, string>>({})

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
    setMenu(null)
    setTab('servers')
    // A fresh open starts with no stale tool panels from a previous agent.
    setToolsOpen({})
    setToolsByName({})
    setToolsLoading({})
    setToolsError({})
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

  // "List tools…" — probe the server's advertised tools and show them inline.
  const listTools = React.useCallback(
    async (name: string): Promise<void> => {
      setTab('connectivity')
      setToolsOpen((o) => ({ ...o, [name]: true }))
      setToolsError((e) => { const n = { ...e }; delete n[name]; return n })
      setToolsLoading((l) => ({ ...l, [name]: true }))
      try {
        const r = await window.api.mcpTools(agentPath, name)
        if (r?.error) setToolsError((e) => ({ ...e, [name]: r.error! }))
        else setToolsByName((m) => ({ ...m, [name]: r.tools ?? [] }))
      } catch (e) {
        setToolsError((er) => ({ ...er, [name]: e instanceof Error ? e.message : 'Failed to list tools' }))
      } finally {
        setToolsLoading((l) => ({ ...l, [name]: false }))
      }
    },
    [agentPath]
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

  // Menu items for the active server. Enable/Disable toggles on `enabled`; Remove
  // is hidden for built-ins (the catalog manages those via enable/disable only).
  const menuItems = (srv: McpServerStatus): ContextMenuEntry[] => {
    const items: ContextMenuEntry[] = [
      srv.enabled
        ? { label: 'Disable', icon: 'stop', onClick: () => void apply('disable', srv.name) }
        : { label: 'Enable', icon: 'play', onClick: () => void apply('enable', srv.name) },
      { label: 'List tools…', icon: 'terminal', onClick: () => void listTools(srv.name) },
      { label: 'Recheck', icon: 'refresh', onClick: () => void recheck() }
    ]
    if (!srv.builtin) {
      items.push({ separator: true })
      items.push({ label: 'Remove', icon: 'trash', danger: true, onClick: () => void apply('remove', srv.name) })
    }
    return items
  }

  // Menu position derived from the `⋯` button's rect, clamped on-screen. Rendered
  // inside the overlay stacking context so ContextMenu (z 1500) paints above the
  // rows and is not clipped by the dialog's scroll.
  const menuPos = React.useMemo(() => {
    if (!menu) return null
    const r = menu.anchor.getBoundingClientRect()
    return {
      left: Math.max(8, Math.min(r.left, window.innerWidth - 248)),
      top: Math.min(r.bottom + 4, window.innerHeight - 220)
    }
  }, [menu])

  const tabStyle = (id: TabId): React.CSSProperties => ({ display: tab === id ? 'block' : 'none' })

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
      <SegmentedTabs
        variant="segmented"
        value={tab}
        onChange={(id) => setTab(id as TabId)}
        tabs={[
          { id: 'servers', label: 'Servers' },
          { id: 'connectivity', label: 'Connectivity' },
          { id: 'raw', label: 'Raw JSON' }
        ]}
        style={{ marginBottom: 16 }}
      />

      {/* ── SERVERS TAB — the add / toggle surface ─────────────────── */}
      <div style={tabStyle('servers')}>
        {/* DETECTED CREATIVE APPS (Blender / GIMP → enable as MCP) */}
        <CreativeAppsSection
          agentPath={agentPath}
          open={open}
          onMcpChanged={() => {
            void loadList()
            void recheck()
          }}
        />

        {/* CATALOG PICKER (primary) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 18, marginBottom: 10 }}>
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
          <McpCatalogList catalog={pickableCatalog} current={current} busyName={busyName} onApply={apply} />
        )}

        {/* HOSTED MEMORY (SyntheticMem remote MCP — optional, needs a key) */}
        <SyntheticMemSection
          agentPath={agentPath}
          catalog={catalog}
          current={current}
          officeSlug={officeSlug}
          agentId={agentId}
          onMcpChanged={() => {
            void loadList()
            void recheck()
          }}
        />
      </div>

      {/* ── CONNECTIVITY TAB — live status + per-server menu + tools ── */}
      <div style={tabStyle('connectivity')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0 8px' }}>
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
              <div key={s.name}>
                <ServerRow server={s} onMenu={(srv, anchor) => setMenu({ server: srv, anchor })} />
                {toolsOpen[s.name] && (
                  <ToolsPanel
                    name={s.name}
                    loading={!!toolsLoading[s.name]}
                    error={toolsError[s.name]}
                    tools={toolsByName[s.name]}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── RAW .MCP.JSON TAB — read-only reference ─────────────────── */}
      <div style={tabStyle('raw')}>
        <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-4)', lineHeight: 1.5, marginBottom: 8 }}>
          Read-only view of the file the CLI maintains. Edits happen through the Servers tab.
        </div>
        <JsonCodeBlock value={json} onChange={() => {}} readOnly highlightLine={highlightLine} />
      </div>

      {/* Per-server `⋯` menu — rendered last so it layers above the rows. */}
      {menu && menuPos && (
        <ContextMenu
          header={menu.server.name}
          items={menuItems(menu.server)}
          onClose={() => setMenu(null)}
          style={{ position: 'fixed', left: menuPos.left, top: menuPos.top }}
        />
      )}
    </Modal>
  )
}

export default McpEditorModal
