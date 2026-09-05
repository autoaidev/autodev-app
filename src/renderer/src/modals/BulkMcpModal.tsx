import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button } from '@renderer/ui'
import { NativeSelect } from '@renderer/components/NativeSelect'
import { McpCatalogPicker, type McpPick } from '@renderer/components/mcp/McpCatalogPicker'
import { AgentState } from '@renderer/services/model'
import { actions } from '@renderer/services/agentStore'
import { useAppActions } from '@renderer/services/appActions'
import { useMcpCatalog, fetchDefaultMcp, applyDefaultToPath, type DefaultMcpEntry } from '@renderer/lib/mcp'

/**
 * BulkMcpModal (#MCP-3) — apply ONE MCP operation across a multi-agent selection
 * in a single pass. The twin of BulkModelModal, for the "folder / multi-select"
 * layer of MCP management: a folder here is simply the checked agent PATHS in a
 * group (there is no per-folder config file — every agent owns its own .mcp.json),
 * so this fans an operation out over those paths.
 *
 * Operations: add a server (catalog or custom), remove a named server, enable or
 * disable a named server across all, or apply the Settings default-MCP servers to
 * all. Every write goes through the CLI seam (window.api.mcpApply → `autodev mcp
 * <op>`) — never a raw .mcp.json write — so each change propagates to every
 * provider. After a successful apply we offer to restart the still-running agents
 * (a change only takes hold on the agent's next loop).
 */

type Op = 'add' | 'remove' | 'enable' | 'disable' | 'defaults'

const OP_LABEL: Record<Op, string> = {
  add: 'Add a server',
  remove: 'Remove a server',
  enable: 'Enable a server',
  disable: 'Disable a server',
  defaults: 'Apply default MCP servers'
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--fs-section)',
  fontWeight: 600,
  letterSpacing: 'var(--ls-section)',
  textTransform: 'uppercase',
  color: 'var(--tx-dim)',
  marginBottom: 6
}
const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--bg-input)',
  border: '1px solid var(--bd-1)',
  borderRadius: 'var(--r-input)',
  color: 'var(--tx-1)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  padding: '7px 9px',
  outline: 'none'
}

const CUSTOM = '__custom__'

export function BulkMcpModal({
  open,
  agents,
  paths,
  onClose,
  onApplied
}: {
  open: boolean
  onClose: () => void
  onApplied?: () => void
  agents?: AgentState[]
  paths?: string[]
}): React.JSX.Element {
  const appActions = useAppActions()
  const { catalog } = useMcpCatalog()

  const selected = useMemo(() => {
    const set = new Set(paths ?? [])
    return (agents ?? []).filter((a) => set.has(a.path))
  }, [agents, paths])
  const count = selected.length

  const [op, setOp] = useState<Op>('add')
  const [pending, setPending] = useState<McpPick | null>(null) // op === 'add'
  const [nameChoice, setNameChoice] = useState('') // op === remove/enable/disable
  const [customName, setCustomName] = useState('')
  const [defaults, setDefaults] = useState<DefaultMcpEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'pick' | 'applied'>('pick')
  const [activeAfter, setActiveAfter] = useState<AgentState[]>([])

  const seeded = useRef(false)
  useEffect(() => {
    if (!open) { seeded.current = false; return }
    if (seeded.current) return
    seeded.current = true
    setOp('add'); setPending(null); setNameChoice(''); setCustomName('')
    setBusy(false); setPhase('pick'); setActiveAfter([])
    void fetchDefaultMcp().then(setDefaults)
  }, [open])

  const nameForNamedOp = nameChoice === CUSTOM ? customName.trim() : nameChoice.trim()

  const canApply =
    count > 0 &&
    (op === 'add'
      ? !!pending
      : op === 'defaults'
        ? defaults.length > 0
        : nameForNamedOp !== '')

  const applyOnePath = async (path: string): Promise<boolean> => {
    try {
      if (op === 'add' && pending) {
        const r = await window.api.mcpApply({ path, op: 'add', name: pending.name, server: pending.server })
        return r.ok
      }
      if (op === 'defaults') {
        let ok = true
        for (const d of defaults) { if (!(await applyDefaultToPath(path, d))) ok = false }
        return ok
      }
      const r = await window.api.mcpApply({ path, op: op as 'remove' | 'enable' | 'disable', name: nameForNamedOp })
      return r.ok
    } catch {
      return false
    }
  }

  const apply = async (): Promise<void> => {
    if (!canApply) return
    setBusy(true)
    let n = 0
    for (const a of selected) if (await applyOnePath(a.path)) n++
    setBusy(false)
    const active = selected.filter((a) => a.running)
    const verb =
      op === 'add' ? 'Added server to' :
      op === 'remove' ? 'Removed server from' :
      op === 'enable' ? 'Enabled server on' :
      op === 'disable' ? 'Disabled server on' : 'Applied defaults to'
    appActions.toast(`${verb} ${n} agent${n === 1 ? '' : 's'}.`, n === 0)
    if (n > 0 && active.length > 0) { setActiveAfter(active); setPhase('applied') }
    else { onApplied?.(); onClose() }
  }

  const runRestart = async (): Promise<void> => {
    setBusy(true)
    for (const a of activeAfter) { try { await actions.restart(a.path) } catch { /* saved regardless */ } }
    setBusy(false)
    appActions.toast(`Restarting ${activeAfter.length} agent${activeAfter.length === 1 ? '' : 's'}…`)
    onApplied?.()
    onClose()
  }

  const targetSummary =
    op === 'add' && pending ? `“${pending.name}” → ${count} agent${count === 1 ? '' : 's'}`
    : op === 'defaults' ? `${defaults.length} default server${defaults.length === 1 ? '' : 's'} → ${count} agent${count === 1 ? '' : 's'}`
    : nameForNamedOp ? `“${nameForNamedOp}” across ${count} agent${count === 1 ? '' : 's'}`
    : `${count} selected agent${count === 1 ? '' : 's'}`

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set MCP"
      subtitle={phase === 'applied' ? `${activeAfter.length} running agent${activeAfter.length === 1 ? '' : 's'} · restart to apply now` : `${count} selected agent${count === 1 ? '' : 's'}`}
      subtitleMono
      width={480}
      footer={
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {phase === 'pick' ? (
            <>
              <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={() => void apply()} disabled={busy || !canApply}>
                {busy ? 'Applying…' : `Apply to ${count}`}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={() => { onApplied?.(); onClose() }} disabled={busy}>Not now</Button>
              <Button variant="primary" size="sm" onClick={() => void runRestart()} disabled={busy}>
                {busy ? 'Restarting…' : `Restart ${activeAfter.length} running`}
              </Button>
            </>
          )}
        </div>
      }
    >
      {phase === 'applied' ? (
        <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-2)', lineHeight: 1.55 }}>
          MCP changes saved. A running agent only picks up an MCP change on its next loop — restart
          the {activeAfter.length} running agent{activeAfter.length === 1 ? '' : 's'} to apply now, or
          leave them to apply on their next task.
        </div>
      ) : (
        <>
          <span style={labelStyle}>Operation</span>
          <NativeSelect
            value={op}
            onChange={(e) => { setOp(e.target.value as Op); setPending(null); setNameChoice(''); setCustomName('') }}
            aria-label="MCP operation"
          >
            {(Object.keys(OP_LABEL) as Op[]).map((o) => (
              <option key={o} value={o}>{OP_LABEL[o]}</option>
            ))}
          </NativeSelect>

          <div style={{ marginTop: 14 }}>
            {op === 'add' ? (
              <>
                <span style={labelStyle}>Server</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 'var(--fs-body)', color: pending ? 'var(--tx-1)' : 'var(--tx-5)', fontFamily: pending ? 'var(--font-mono)' : 'var(--font-sans)' }}>
                    {pending ? pending.name : 'No server chosen yet'}
                  </span>
                  <div style={{ marginLeft: 'auto' }}>
                    <McpCatalogPicker buttonLabel={pending ? 'Change…' : 'Choose server'} onPick={setPending} align="right" />
                  </div>
                </div>
              </>
            ) : op === 'defaults' ? (
              <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-4)', lineHeight: 1.5 }}>
                {defaults.length === 0
                  ? 'No default MCP servers are configured yet. Set them in Settings → MCP → Default MCP servers.'
                  : `Applies your ${defaults.length} Settings default${defaults.length === 1 ? '' : 's'} (${defaults.map((d) => d.name).join(', ')}) to every selected agent.`}
              </div>
            ) : (
              <>
                <span style={labelStyle}>Server name</span>
                <NativeSelect
                  value={nameChoice}
                  onChange={(e) => setNameChoice(e.target.value)}
                  aria-label="Server name"
                >
                  <option value="">Select a server…</option>
                  {catalog.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
                  ))}
                  <option value={CUSTOM}>Custom name…</option>
                </NativeSelect>
                {nameChoice === CUSTOM && (
                  <input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="exact server name in .mcp.json"
                    spellCheck={false}
                    style={{ ...inputStyle, marginTop: 8 }}
                  />
                )}
              </>
            )}
          </div>

          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginTop: 12, lineHeight: 1.45 }}>
            {targetSummary}. Every change is applied through the AutoDev CLI and propagates to each
            agent&rsquo;s providers.
          </div>
        </>
      )}
    </Modal>
  )
}

export default BulkMcpModal
