import React from 'react'
import { Icon, Pill } from '@renderer/ui'
import {
  useMcpCatalog,
  groupCatalog,
  catalogServerSpec,
  transportBadge,
  type McpCatalogServer,
  type McpJsonEntry
} from '@renderer/lib/mcp'

/**
 * McpCatalogPicker — the shared "Add server" affordance for the layered MCP
 * manager. A single button opens a menu sourced from the CLI catalog
 * (window.api.mcpCatalog(), via useMcpCatalog), grouped Built-in / Common /
 * Creative apps with an EXPERIMENTAL badge, plus a "Custom…" form (stdio
 * command/args/env OR a remote url). Choosing a server calls `onPick` with a
 * ready-to-apply `{ name, server, kind }`; the caller decides what to do with it
 * (push into the Settings defaults, or fan out `mcpApply` over a selection).
 *
 * It is presentation-only — it never touches .mcp.json itself. Reused by
 * SettingsView2 (Default MCP servers) and BulkMcpModal (per-folder add).
 */

export interface McpPick {
  name: string
  server: McpJsonEntry
  kind: 'builtin' | 'common' | 'creative' | 'remote' | 'custom'
  id?: string
  /** Friendly catalog name for DISPLAY (identity stays `name`/`id`). */
  label?: string
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
const fieldInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  color: 'var(--tx-1)',
  background: 'var(--bg-input)',
  border: '1px solid var(--bd-1)',
  borderRadius: 'var(--r-input)',
  padding: '5px 8px',
  outline: 'none'
}
const miniLabel: React.CSSProperties = {
  display: 'block',
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--tx-4)',
  margin: '8px 0 3px'
}

export function McpCatalogPicker({
  onPick,
  exclude,
  buttonLabel = 'Add server',
  align = 'right',
  hideBuiltins = false
}: {
  onPick: (pick: McpPick) => void
  /** server ids/names already present — shown greyed with an "added" tag. */
  exclude?: Set<string>
  buttonLabel?: string
  align?: 'left' | 'right'
  /** Drop the whole Built-in group from the menu — used where the 4 core built-ins
   *  are already always-on (Settings → Default MCP servers) so offering them as
   *  "addable" would contradict that. Common/Creative/Custom stay pickable. */
  hideBuiltins?: boolean
}): React.JSX.Element {
  const { catalog } = useMcpCatalog()
  const [open, setOpen] = React.useState(false)
  const [mode, setMode] = React.useState<'menu' | 'custom'>('menu')

  // Custom form state
  const [cName, setCName] = React.useState('')
  const [cTransport, setCTransport] = React.useState<'stdio' | 'remote'>('stdio')
  const [cCommand, setCCommand] = React.useState('')
  const [cArgs, setCArgs] = React.useState('')
  const [cEnv, setCEnv] = React.useState('')
  const [cUrl, setCUrl] = React.useState('')
  const [cHeaders, setCHeaders] = React.useState('')
  const [cSse, setCSse] = React.useState(false)

  const groups = React.useMemo(
    () =>
      groupCatalog(
        // Remote servers that need a bearer key (SyntheticMem) can't be added from
        // this keyless picker — they have their own key-collecting section in the
        // MCP editor. Drop them here so no keyless/broken add is ever offered.
        catalog.filter((s) => !(s.kind === 'remote' && s.auth))
      ).filter((g) => !(hideBuiltins && g.kind === 'builtin')),
    [catalog, hideBuiltins]
  )

  const reset = (): void => {
    setMode('menu')
    setCName(''); setCTransport('stdio'); setCCommand(''); setCArgs(''); setCEnv('')
    setCUrl(''); setCHeaders(''); setCSse(false)
  }
  const close = (): void => { setOpen(false); reset() }

  const pickCatalog = (s: McpCatalogServer): void => {
    if (exclude?.has(s.id) || exclude?.has(s.name)) return
    onPick({ name: s.id, server: catalogServerSpec(s), kind: s.kind, id: s.id, label: s.name })
    close()
  }

  const parseKv = (raw: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of raw.split(/[\n,]+/)) {
      const t = line.trim()
      if (!t) continue
      const eq = t.indexOf('=')
      if (eq <= 0) continue
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
    }
    return out
  }

  const customValid =
    cName.trim() !== '' && (cTransport === 'stdio' ? cCommand.trim() !== '' : cUrl.trim() !== '')

  const submitCustom = (): void => {
    if (!customValid) return
    const server: McpJsonEntry =
      cTransport === 'stdio'
        ? {
            command: cCommand.trim(),
            ...(cArgs.trim() ? { args: cArgs.split(/\s+/).filter(Boolean) } : {}),
            ...(cEnv.trim() ? { env: parseKv(cEnv) } : {})
          }
        : {
            type: cSse ? 'sse' : 'http',
            url: cUrl.trim(),
            ...(cHeaders.trim() ? { headers: parseKv(cHeaders) } : {})
          }
    onPick({ name: cName.trim(), server, kind: 'custom' })
    close()
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" style={linkBtn} onClick={() => (open ? close() : setOpen(true))} aria-haspopup="menu" aria-expanded={open}>
        <Icon name="plus" size={11} />
        {buttonLabel}
      </button>
      {open && (
        <>
          <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 2100 }} />
          <div
            role="menu"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              [align]: 0,
              zIndex: 2200,
              width: 320,
              maxHeight: 420,
              overflow: 'auto',
              background: 'var(--bg-elev)',
              border: '1px solid var(--bd-strong)',
              borderRadius: 'var(--r-card)',
              boxShadow: 'var(--shadow-menu)',
              padding: 6
            }}
          >
            {mode === 'menu' ? (
              <>
                {groups.map((g) => (
                  <div key={g.kind} style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--tx-4)', padding: '6px 8px 3px' }}>
                      {g.label}
                    </div>
                    {g.servers.map((s) => {
                      const added = exclude?.has(s.id) || exclude?.has(s.name)
                      return (
                        <button
                          key={s.id}
                          type="button"
                          role="menuitem"
                          disabled={added}
                          onClick={() => pickCatalog(s)}
                          style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            background: 'transparent',
                            border: 'none',
                            borderRadius: 'var(--r-input)',
                            padding: '7px 9px',
                            cursor: added ? 'default' : 'pointer',
                            opacity: added ? 0.5 : 1,
                            color: 'var(--tx-1)'
                          }}
                          onMouseEnter={(e) => { if (!added) e.currentTarget.style.background = 'var(--bg-selected)' }}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 'var(--fs-body)', fontWeight: 600 }}>{s.name}</span>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--tx-4)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-chip)', padding: '0 4px' }}>
                              {transportBadge(s)}
                            </span>
                            {s.experimental && <Pill variant="amber" radius="chip" mono>EXPERIMENTAL</Pill>}
                            {added && <span style={{ marginLeft: 'auto', fontSize: 9.5, color: 'var(--st-running)' }}>added</span>}
                          </div>
                          {s.description && (
                            <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-4)', marginTop: 2, lineHeight: 1.4 }}>{s.description}</div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                ))}
                <div style={{ borderTop: '1px solid var(--bd-2)', margin: '4px 0' }} />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setMode('custom')}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderRadius: 'var(--r-input)', padding: '7px 9px', cursor: 'pointer', color: 'var(--tx-1)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-selected)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ fontSize: 'var(--fs-body)', fontWeight: 600 }}>Custom…</span>
                  <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-4)', marginTop: 2 }}>A server the catalog doesn't list (stdio command or a remote URL).</div>
                </button>
              </>
            ) : (
              <div style={{ padding: '4px 6px 8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <button type="button" onClick={() => setMode('menu')} style={{ ...linkBtn, color: 'var(--tx-3)' }}>
                    <Icon name="chevron" size={12} /> Back
                  </button>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tx-2)', marginLeft: 2 }}>Custom server</span>
                </div>
                <span style={miniLabel}>Name</span>
                <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="my-server" spellCheck={false} style={fieldInput} />
                <div style={{ display: 'inline-flex', marginTop: 8, borderRadius: 'var(--r-button)', border: '1px solid var(--bd-field)', overflow: 'hidden' }}>
                  {(['stdio', 'remote'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setCTransport(t)}
                      style={{ padding: '4px 12px', border: 'none', cursor: 'pointer', fontSize: 'var(--fs-desc)', fontWeight: cTransport === t ? 700 : 500, background: cTransport === t ? 'var(--accent)' : 'transparent', color: cTransport === t ? 'var(--tx-onaccent)' : 'var(--tx-3)' }}
                    >
                      {t === 'stdio' ? 'stdio' : 'remote'}
                    </button>
                  ))}
                </div>
                {cTransport === 'stdio' ? (
                  <>
                    <span style={miniLabel}>Command</span>
                    <input value={cCommand} onChange={(e) => setCCommand(e.target.value)} placeholder="npx" spellCheck={false} style={fieldInput} />
                    <span style={miniLabel}>Args (space-separated)</span>
                    <input value={cArgs} onChange={(e) => setCArgs(e.target.value)} placeholder="-y my-mcp-package" spellCheck={false} style={fieldInput} />
                    <span style={miniLabel}>Env (KEY=VALUE, one per line)</span>
                    <textarea value={cEnv} onChange={(e) => setCEnv(e.target.value)} placeholder="API_KEY=…" spellCheck={false} rows={2} style={{ ...fieldInput, resize: 'vertical' }} />
                  </>
                ) : (
                  <>
                    <span style={miniLabel}>URL</span>
                    <input value={cUrl} onChange={(e) => setCUrl(e.target.value)} placeholder="https://host/mcp" spellCheck={false} style={fieldInput} />
                    <span style={miniLabel}>Headers (KEY=VALUE, one per line)</span>
                    <textarea value={cHeaders} onChange={(e) => setCHeaders(e.target.value)} placeholder="Authorization=Bearer …" spellCheck={false} rows={2} style={{ ...fieldInput, resize: 'vertical' }} />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8, fontSize: 'var(--fs-desc)', color: 'var(--tx-3)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={cSse} onChange={(e) => setCSse(e.target.checked)} />
                      SSE transport (default is HTTP)
                    </label>
                  </>
                )}
                <button
                  type="button"
                  disabled={!customValid}
                  onClick={submitCustom}
                  style={{ marginTop: 12, width: '100%', padding: '7px 0', border: 'none', borderRadius: 'var(--r-button)', cursor: customValid ? 'pointer' : 'default', fontSize: 'var(--fs-body)', fontWeight: 600, background: customValid ? 'var(--accent)' : 'var(--bg-input)', color: customValid ? 'var(--tx-onaccent)' : 'var(--tx-4)' }}
                >
                  Add custom server
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default McpCatalogPicker
