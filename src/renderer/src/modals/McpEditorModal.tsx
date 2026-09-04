import React from 'react'
import { Modal, Button, Icon, InfoTip } from '@renderer/ui'
import { ServerRow } from '../components/mcp/ServerRow'
import { JsonCodeBlock } from '../components/mcp/JsonCodeBlock'
import { summarize, metaFor, type McpServerStatus } from '../components/mcp/mcpStatus'
import { CreativeAppsSection } from '../components/mcp/CreativeAppsSection'

/**
 * Starter templates for the most common MCP servers, so "Add server" inserts a
 * runnable entry instead of a blank {command:'',args:[]} the user has to know how
 * to fill. `baseName` is deduped against existing keys; `config` is the value
 * written under mcpServers. Pixel-office is normally SYNCED from the office (its
 * URL + agent key), so its template carries placeholders + a caution — editing a
 * synced entry can be overwritten on the next sync.
 */
const MCP_PRESETS: { key: string; label: string; baseName: string; hint: string; config: Record<string, unknown> }[] = [
  {
    key: 'memory',
    label: 'Memory',
    baseName: 'memory',
    hint: 'Persistent knowledge-graph memory across sessions.',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }
  },
  {
    key: 'filesystem',
    label: 'Filesystem',
    baseName: 'filesystem',
    hint: 'Read/write files under the workspace root.',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }
  },
  {
    key: 'pixel-office',
    label: 'Pixel Office',
    baseName: 'pixel-office',
    hint: 'Office A2A / operate bridge — usually synced from the office; only hand-wire if you know the URL + agent key.',
    config: { type: 'http', url: 'https://your-office.example.com/api/office-mcp', headers: { Authorization: 'Bearer agt_REPLACE_ME' } }
  },
  {
    key: 'blank',
    label: 'Blank server',
    baseName: 'new-server',
    hint: 'An empty stub to fill in yourself.',
    config: { command: '', args: [] }
  }
]

/**
 * SCREEN 2g — MCP editor · status first, JSON second.
 *
 * Two stacked sections inside a single 700-wide <Modal>:
 *   1. CONNECTIVITY — a live list of every MCP server (ServerRow) probed via
 *      `window.api.agentMcpStatus(path)`. Ready/failing/disabled state, transport
 *      badge, and an inline actionable fix for a failing runner. You rarely need
 *      to go below this.
 *   2. RAW .MCP.JSON — the line-numbered, syntax-tinted file (JsonCodeBlock),
 *      read via `readAgentMcp` and written via `writeAgentMcp`, for advanced
 *      edits. The block cross-highlights the line of the failing server.
 *
 * Real API wiring (CURRENT-APP.md §1b):
 *   agentMcpStatus(path) → { servers: McpServerStatus[] }   (Recheck)
 *   readAgentMcp(path)   → { content }                       (load JSON)
 *   writeAgentMcp(path, content) → { ok } | { error }        (Save; validates JSON)
 *   stopAgent + startAgent                                    (changes apply on next task;
 *                                                              restart a running agent)
 */

const sectionLabel: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-section)',
  fontWeight: 700,
  letterSpacing: '.11em',
  textTransform: 'uppercase',
  color: 'var(--tx-4)'
}
const linkBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--accent)',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-desc)',
  fontWeight: 600,
  cursor: 'pointer',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5
}

/** validate + locate the failing server's line in the JSON for cross-highlight. */
function findServerLine(json: string, name?: string): number | undefined {
  if (!name) return undefined
  const lines = json.split('\n')
  // the object key line: `"name": {`
  const needle = `"${name}"`
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1
  }
  return undefined
}

function validateJson(text: string): { valid: boolean; message?: string } {
  try {
    JSON.parse(text)
    return { valid: true }
  } catch (e) {
    return { valid: false, message: e instanceof Error ? e.message : 'invalid JSON' }
  }
}

export function McpEditorModal(props: {
  agentPath: string
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const { agentPath, open, onClose } = props

  const [servers, setServers] = React.useState<McpServerStatus[]>([])
  const [statusError, setStatusError] = React.useState<string | null>(null)
  const [json, setJson] = React.useState('')
  const [savedJson, setSavedJson] = React.useState('')
  const [checking, setChecking] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [presetOpen, setPresetOpen] = React.useState(false)

  const fileName = React.useMemo(() => {
    const base = agentPath.split('/').filter(Boolean).pop() || agentPath
    return `${base}/.mcp.json`
  }, [agentPath])

  const recheck = React.useCallback(async (): Promise<void> => {
    setChecking(true)
    setStatusError(null)
    try {
      const r = (await window.api.agentMcpStatus(agentPath)) as {
        servers?: McpServerStatus[]
        error?: string
      }
      if (r?.error) {
        setStatusError(r.error)
        setServers([])
      } else {
        setServers(r?.servers ?? [])
      }
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : 'connectivity check failed')
    } finally {
      setChecking(false)
    }
  }, [agentPath])

  const loadJson = React.useCallback(async (): Promise<void> => {
    try {
      const r = (await window.api.readAgentMcp(agentPath)) as { content?: string; error?: string }
      const content = r?.error ? '' : r?.content ?? ''
      setJson(content)
      setSavedJson(content)
    } catch {
      setJson('')
      setSavedJson('')
    }
  }, [agentPath])

  React.useEffect(() => {
    if (!open) return
    setNotice(null)
    void recheck()
    void loadJson()
  }, [open, recheck, loadJson])

  const validation = React.useMemo(() => validateJson(json), [json])
  const dirty = json !== savedJson

  const counts = summarize(servers)
  // first failing server drives the JSON cross-highlight + footer message.
  const firstFailing = servers.find((s) => metaFor(s).failing)
  const highlightLine = findServerLine(json, firstFailing?.name)
  const problem = firstFailing
    ? `line ${highlightLine ?? '?'} · ${firstFailing.name} not resolvable on this machine`
    : !validation.valid
      ? validation.message
      : undefined

  const save = React.useCallback(async (): Promise<void> => {
    if (!validation.valid) {
      setNotice('Fix the JSON syntax before saving.')
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      const r = (await window.api.writeAgentMcp(agentPath, json)) as { ok?: boolean; error?: string }
      if (r?.error) {
        setNotice(r.error)
        return
      }
      setSavedJson(json)
      // changes apply on the agent's NEXT task; if it's running, restart to apply.
      let restarted = false
      try {
        const st = (await window.api.agentState(agentPath)) as { running?: boolean } | undefined
        if (st?.running) {
          await window.api.stopAgent(agentPath)
          await window.api.startAgent(agentPath)
          restarted = true
        }
      } catch {
        /* restart best-effort; the save already landed */
      }
      await recheck()
      setNotice(restarted ? 'Saved · agent restarted to apply.' : 'Saved · applies on next task.')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'save failed')
    } finally {
      setSaving(false)
    }
  }, [agentPath, json, validation.valid, recheck])

  const formatJson = React.useCallback((): void => {
    if (!validation.valid) return
    try {
      setJson(JSON.stringify(JSON.parse(json), null, 2))
    } catch {
      /* guarded by validation.valid */
    }
  }, [json, validation.valid])

  const addServer = React.useCallback((preset: (typeof MCP_PRESETS)[number]): void => {
    setPresetOpen(false)
    // Insert a VALID entry (a runnable preset, or a blank stub) under mcpServers so
    // the button does what its label says, then focus+select the new key so the user
    // can fill it in. We only rewrite the JSON when it parses; an invalid buffer is
    // left untouched (the user must fix syntax first) so we never clobber their edits.
    let obj: Record<string, unknown>
    try {
      const parsed = json.trim() ? JSON.parse(json) : {}
      obj =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {}
    } catch {
      setNotice('Fix the JSON syntax before adding a server.')
      return
    }
    const cur = obj.mcpServers
    const servers: Record<string, unknown> =
      cur && typeof cur === 'object' && !Array.isArray(cur)
        ? (cur as Record<string, unknown>)
        : {}
    // pick a name that doesn't collide with an existing server
    let name = preset.baseName
    for (let n = 2; name in servers; n++) name = `${preset.baseName}-${n}`
    servers[name] = JSON.parse(JSON.stringify(preset.config))
    obj.mcpServers = servers
    const next = JSON.stringify(obj, null, 2)
    setJson(next)
    setNotice(
      preset.key === 'blank'
        ? `Added "${name}" — set its command, then Save & recheck.`
        : `Added "${name}" (${preset.label}) — review its values, then Save & recheck.`
    )
    // best-effort: focus the editor and reveal/select the new key.
    requestAnimationFrame(() => {
      const ta = document.querySelector('textarea[data-json-editor]') as HTMLTextAreaElement | null
      if (!ta) return
      const needle = `"${name}"`
      const at = next.indexOf(needle)
      ta.focus()
      if (at >= 0) ta.setSelectionRange(at, at + needle.length)
    })
  }, [json])

  const openInEditor = React.useCallback((): void => {
    // TODO(redesign): no "reveal .mcp.json in $EDITOR" api exists; open the
    // workspace folder so the user can reach the file in their own editor.
    void window.api.openPath?.(agentPath)
  }, [agentPath])

  const installCli = React.useCallback((): void => {
    // TODO(redesign): no installer api; point the user at the CLI install docs.
    void window.api.openExternal?.('https://autoaidev.com/download')
  }, [])

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
            {/* TODO(redesign): office-agent count for "shared with: N agents" is not
                exposed to this modal; show the applicability note instead of a fake N. */}
            {notice || 'edits to this file apply to this agent on its next task'}
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || !validation.valid || !dirty}>
            {saving ? 'Saving…' : 'Save & recheck'}
          </Button>
        </>
      }
    >
      {/* ── CONNECTIVITY (status first) ───────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={sectionLabel}>Connectivity</span>
        <InfoTip label="MCP servers" width={280}>
          Each server here is a tool your agent can call — a shared office, a memory store, the
          filesystem. They live in this agent’s <code>.mcp.json</code>. Use a preset to add one
          without knowing the exact command.
        </InfoTip>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10.5px',
            color: counts.failing ? 'var(--st-error)' : 'var(--tx-dim)'
          }}
        >
          {summaryText}
        </span>
        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <button
            type="button"
            style={linkBtn}
            onClick={() => setPresetOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={presetOpen}
          >
            <Icon name="plus" size={11} />
            Add server
          </button>
          {presetOpen && (
            <>
              {/* click-away backdrop */}
              <div
                onClick={() => setPresetOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 2100 }}
              />
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  right: 0,
                  zIndex: 2200,
                  minWidth: 240,
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--bd-strong)',
                  borderRadius: 'var(--r-card)',
                  boxShadow: 'var(--shadow-menu)',
                  padding: 5
                }}
              >
                {MCP_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    role="menuitem"
                    onClick={() => addServer(p)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      background: 'transparent',
                      border: 'none',
                      borderRadius: 'var(--r-input)',
                      padding: '7px 9px',
                      cursor: 'pointer',
                      color: 'var(--tx-1)'
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-selected)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div style={{ fontSize: 'var(--fs-body)', fontWeight: 600 }}>{p.label}</div>
                    <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-4)', marginTop: 2, lineHeight: 1.4 }}>
                      {p.hint}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {statusError ? (
        <div
          style={{
            padding: '10px 12px',
            marginBottom: 4,
            background: 'var(--st-error-wash)',
            border: '1px solid var(--st-error-bd)',
            borderRadius: 'var(--r-card)',
            fontSize: 'var(--fs-desc)',
            color: 'var(--st-error-bright)'
          }}
        >
          {statusError}
        </div>
      ) : servers.length === 0 ? (
        <div
          style={{
            padding: '14px 12px',
            fontSize: 'var(--fs-desc)',
            color: 'var(--tx-4)',
            textAlign: 'center'
          }}
        >
          {checking ? 'Probing servers…' : 'No MCP servers configured for this agent.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {servers.map((s) => (
            <ServerRow
              key={s.name}
              server={s}
              onInstallCli={installCli}
              onSetPath={openInEditor}
              onMenu={() => void recheck()}
            />
          ))}
        </div>
      )}

      {/* ── DETECTED CREATIVE APPS (Blender / GIMP → enable as MCP) ── */}
      <CreativeAppsSection
        agentPath={agentPath}
        open={open}
        onMcpChanged={() => {
          void recheck()
          void loadJson()
        }}
      />

      {/* ── RAW .MCP.JSON (JSON second) ───────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0 8px' }}>
        <span style={sectionLabel}>Raw .mcp.json</span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontFamily: 'var(--font-mono)',
            fontSize: '10.5px',
            color: validation.valid ? 'var(--st-running)' : 'var(--st-error)'
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: validation.valid ? 'var(--st-running)' : 'var(--st-error)'
            }}
          />
          {validation.valid ? 'valid' : 'invalid'}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 14 }}>
          <button type="button" style={linkBtn} onClick={formatJson} disabled={!validation.valid}>
            Format
          </button>
          <button type="button" style={linkBtn} onClick={openInEditor} title="Opens the agent’s workspace folder; the file is .mcp.json inside it">
            Reveal folder
          </button>
        </div>
      </div>

      <JsonCodeBlock value={json} onChange={setJson} highlightLine={highlightLine} problem={problem} />
    </Modal>
  )
}

export default McpEditorModal
