import React from 'react'
import { Button, Icon, InfoTip, Pill } from '@renderer/ui'

/**
 * "Detected creative apps → enable MCP" — the app surface for wiring Blender /
 * GIMP into an agent's MCP servers. Everything here is driven by the bundled
 * CLI (`autodev mcp detect`): detection, the server config, prerequisites and
 * post-setup steps all come from the CLI, and ENABLING routes through the CLI
 * too (window.api.mcpEnableApp → `autodev mcp detect --enable <app>`), which
 * propagates the server to every provider. This component never hand-writes
 * .mcp.json (that's what writeMcp in the raw editor does, and it SKIPS provider
 * propagation — the wrong path for this flow).
 *
 * The CLI owns this shape (mirrors main/agentManager.ts McpDetectApp):
 */
export interface DetectedApp {
  id: string
  name: string
  installed: boolean
  path: string | null
  source: string | null
  experimental: boolean
  server: Record<string, unknown>
  serverName: string
  prerequisites: Array<{ id: string; installed: boolean; installHint: string }>
  postSetup: string[]
  notes: string[]
  alreadyEnabled: boolean
}

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
  gap: 5,
  marginLeft: 'auto'
}

/** A numbered, readable rendering of the CLI's post-setup / guidance steps. */
function StepList({ steps, tone }: { steps: string[]; tone: 'info' | 'success' }): React.JSX.Element {
  return (
    <ol
      style={{
        margin: '8px 0 0',
        padding: '10px 12px 10px 28px',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        listStyle: 'decimal',
        background: tone === 'success' ? 'var(--st-running-soft)' : 'var(--bg-chip-idle)',
        border: `1px solid ${tone === 'success' ? 'var(--st-running-bd)' : 'var(--bd-1)'}`,
        borderRadius: 'var(--r-card)',
        fontSize: 'var(--fs-desc)',
        color: 'var(--tx-2)',
        lineHeight: 1.5
      }}
    >
      {steps.map((s, i) => (
        <li key={i}>
          <StepText text={s} />
        </li>
      ))}
    </ol>
  )
}

/** Render a step, tinting any `backtick` code spans monospace so commands stand out. */
function StepText({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(`[^`]+`)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('`') && p.endsWith('`') ? (
          <code
            key={i}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              background: 'var(--bg-elev)',
              border: '1px solid var(--bd-1)',
              borderRadius: 4,
              padding: '0 4px'
            }}
          >
            {p.slice(1, -1)}
          </code>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        )
      )}
    </>
  )
}

function AppCard({
  app,
  agentPath,
  onMcpChanged,
  onRefresh
}: {
  app: DetectedApp
  agentPath: string
  onMcpChanged: () => void
  onRefresh: () => void
}): React.JSX.Element {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // Post-setup steps to surface after a successful enable (from the CLI's own
  // structured postSetup for this app). Kept local so the box only appears once
  // the user acts, not permanently.
  const [showEnabledSteps, setShowEnabledSteps] = React.useState(false)
  // Optional advanced override: a custom gimp_mcp_client.py path. Hidden by
  // default — the enable checkbox installs the real client automatically, so
  // this is only for power users pointing at a hand-built client.
  const [gimpClient, setGimpClient] = React.useState('')
  const [showAdvanced, setShowAdvanced] = React.useState(false)

  const missingPrereqs = app.prerequisites.filter((p) => !p.installed)

  const enable = React.useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.mcpEnableApp({
        path: agentPath,
        app: app.id,
        gimpClient: app.id === 'gimp' && gimpClient.trim() ? gimpClient.trim() : undefined
      })
      if (!r.ok) {
        setError(r.error || `Failed to enable ${app.name}`)
        return
      }
      setShowEnabledSteps(true)
      onMcpChanged()
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to enable ${app.name}`)
    } finally {
      setBusy(false)
    }
  }, [agentPath, app.id, app.name, gimpClient, onMcpChanged, onRefresh])

  const remove = React.useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // Route removal through the CLI too, so every provider is kept in sync.
      const r = (await window.api.runCli(['mcp', 'remove', app.serverName, agentPath], agentPath)) as {
        code?: number
        stderr?: string
        stdout?: string
      }
      if (r?.code && r.code !== 0) {
        setError((r.stderr || r.stdout || `Failed to remove ${app.name}`).trim())
        return
      }
      setShowEnabledSteps(false)
      onMcpChanged()
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to remove ${app.name}`)
    } finally {
      setBusy(false)
    }
  }, [agentPath, app.serverName, app.name, onMcpChanged, onRefresh])

  return (
    <div
      style={{
        padding: '12px 14px',
        background: 'var(--bg-elev)',
        border: '1px solid var(--bd-1)',
        borderRadius: 'var(--r-card)',
        opacity: !app.installed && !app.experimental && !app.alreadyEnabled ? 0.72 : 1
      }}
    >
      {/* header: name · experimental · status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 'var(--fs-body)', fontWeight: 700, color: 'var(--tx-1)' }}>{app.name}</span>
        {app.experimental && (
          <Pill variant="amber" radius="chip" mono>
            EXPERIMENTAL
          </Pill>
        )}
        <div style={{ marginLeft: 'auto' }}>
          {app.alreadyEnabled ? (
            <Pill variant="green" selected>
              <Icon name="check" size={11} /> Enabled
            </Pill>
          ) : app.installed ? (
            <Pill variant="green">Detected</Pill>
          ) : (
            <Pill variant="neutral">Not installed</Pill>
          )}
        </div>
      </div>

      {/* detected-at path */}
      {app.installed && app.path && (
        <div
          style={{
            marginTop: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: '10.5px',
            color: 'var(--tx-dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {app.path}
          {app.source ? ` · ${app.source}` : ''}
        </div>
      )}

      {/* prerequisite warnings */}
      {missingPrereqs.map((p) => (
        <div
          key={p.id}
          style={{
            marginTop: 8,
            padding: '7px 10px',
            background: 'var(--st-needsyou-soft)',
            border: '1px solid var(--st-needsyou-bd)',
            borderRadius: 'var(--r-card)',
            fontSize: 'var(--fs-desc)',
            color: 'var(--st-needsyou)'
          }}
        >
          Requires <strong>{p.id}</strong> — <StepText text={p.installHint} />
        </div>
      ))}

      {/* experimental notes (GIMP) as caution */}
      {app.notes.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {app.notes.map((n, i) => (
            <div key={i} style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-4)', lineHeight: 1.5 }}>
              ⚠ {n}
            </div>
          ))}
        </div>
      )}

      {/* action row */}
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {!app.installed ? (
          <span style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-4)' }}>
            Install {app.name} to enable this
          </span>
        ) : app.experimental ? (
          // GIMP: one-click enable checkbox — parity with Blender's enable/remove.
          // CHECKED → mcpEnableApp('gimp') installs the plugin + client and writes
          // the MCP server (propagated to every provider). UNCHECKED → mcp remove,
          // which toggles off the MCP server but LEAVES the plugin files in place.
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              cursor: busy ? 'default' : 'pointer',
              fontSize: 'var(--fs-body)',
              fontWeight: 600,
              color: 'var(--tx-1)',
              opacity: busy ? 0.6 : 1
            }}
          >
            <input
              type="checkbox"
              checked={app.alreadyEnabled}
              disabled={busy}
              onChange={(e) => (e.target.checked ? void enable() : void remove())}
              style={{
                width: 16,
                height: 16,
                accentColor: 'var(--accent)',
                cursor: busy ? 'default' : 'pointer'
              }}
            />
            {busy ? (app.alreadyEnabled ? 'Disabling…' : 'Enabling…') : `Enable ${app.name} MCP`}
          </label>
        ) : app.alreadyEnabled ? (
          <Button variant="secondary" size="sm" onClick={() => void remove()} disabled={busy}>
            <Icon name="trash" size={12} />
            {busy ? 'Removing…' : 'Remove'}
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={() => void enable()} disabled={busy}>
            <Icon name="sparkle" size={12} />
            {busy ? 'Enabling…' : `Enable ${app.name} MCP`}
          </Button>
        )}
      </div>

      {/* Advanced (GIMP only): optional custom gimp_mcp_client.py override. Tucked
          away so the default interaction stays the simple enable checkbox above. */}
      {app.installed && app.experimental && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--tx-4)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-desc)',
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5
            }}
          >
            <Icon name={showAdvanced ? 'chevron' : 'caret'} size={11} />
            Advanced
          </button>
          {showAdvanced && (
            <input
              type="text"
              value={gimpClient}
              onChange={(e) => setGimpClient(e.target.value)}
              placeholder="custom path to gimp_mcp_client.py (optional)"
              spellCheck={false}
              style={{
                marginTop: 6,
                width: '100%',
                boxSizing: 'border-box',
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                color: 'var(--tx-1)',
                background: 'var(--bg-input)',
                border: '1px solid var(--bd-1)',
                borderRadius: 'var(--r-input)',
                padding: '5px 8px'
              }}
            />
          )}
        </div>
      )}

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

      {/* Post-setup guidance:
          - experimental (GIMP): always shown as manual guidance;
          - Blender: shown after a successful enable so the user knows the next
            (out-of-app) steps to actually reach the running server on :9876. */}
      {app.postSetup.length > 0 && (app.experimental || showEnabledSteps || app.alreadyEnabled) && (
        <StepList
          steps={app.postSetup}
          tone={showEnabledSteps && !app.experimental ? 'success' : 'info'}
        />
      )}
    </div>
  )
}

export function CreativeAppsSection({
  agentPath,
  open,
  onMcpChanged
}: {
  agentPath: string
  open: boolean
  onMcpChanged: () => void
}): React.JSX.Element | null {
  const [apps, setApps] = React.useState<DetectedApp[]>([])
  // Start in the "checking" state: this section ALWAYS re-detects on open, so we
  // must never flash a stale/empty "Not installed" before the first result lands.
  const [detecting, setDetecting] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const detect = React.useCallback(async (): Promise<void> => {
    if (!agentPath) return
    setDetecting(true)
    setError(null)
    try {
      const r = (await window.api.mcpDetect(agentPath)) as { apps?: DetectedApp[]; error?: string }
      if (r?.error) {
        setError(r.error)
        setApps([])
      } else {
        setApps(r?.apps ?? [])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'detection failed')
      setApps([])
    } finally {
      setDetecting(false)
    }
  }, [agentPath])

  // Re-detect FRESH every time the modal opens AND whenever the target agent's
  // workspace path changes (a reused modal switching agents). Keyed on `open` +
  // `agentPath` — not on the CLI result — so a Blender/GIMP installed since the
  // last open is picked up with no manual "Re-detect" click. On each (re)open we
  // drop any prior result and show "Checking…" until the fresh detection arrives,
  // so a stale "Not installed" can never linger between opens.
  React.useEffect(() => {
    if (!open) return
    setApps([])
    setError(null)
    setDetecting(true)
    void detect()
  }, [open, agentPath, detect])

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={sectionLabel}>Detected creative apps</span>
        <InfoTip label="Creative apps → MCP" width={300}>
          Wire a local creative app (Blender, GIMP) into this agent as an MCP tool. Detection and
          setup are driven by the AutoDev CLI, and enabling propagates the server to every provider —
          it is not a hand-edit of <code>.mcp.json</code>.
        </InfoTip>
        <button type="button" style={linkBtn} onClick={() => void detect()} disabled={detecting}>
          <Icon name="refresh" size={11} />
          {detecting ? 'Detecting…' : 'Re-detect'}
        </button>
      </div>

      {error ? (
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--st-error-wash, var(--st-error-soft))',
            border: '1px solid var(--st-error-bd)',
            borderRadius: 'var(--r-card)',
            fontSize: 'var(--fs-desc)',
            color: 'var(--st-error-bright, var(--st-error))'
          }}
        >
          {error}
        </div>
      ) : apps.length === 0 ? (
        <div style={{ padding: '12px', fontSize: 'var(--fs-desc)', color: 'var(--tx-4)', textAlign: 'center' }}>
          {detecting ? 'Scanning for creative apps…' : 'No creative apps detected.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              agentPath={agentPath}
              onMcpChanged={onMcpChanged}
              onRefresh={() => void detect()}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default CreativeAppsSection
