import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button, Icon, Pill } from '@renderer/ui'
import { OfficeAgent } from '../components/office/officeTypes'
import { providerFamilyOf } from '@renderer/services/identity'
import { McpServerPickerModal, type McpPick } from '../components/mcp/McpCatalogPicker'
import { NativeSelect } from '@renderer/components/NativeSelect'
import { type DetectedApp } from '../components/mcp/CreativeAppsSection'

/**
 * BulkOfficeMcpModal — mass-apply ONE MCP-server change across a multi-character
 * selection in the Office view (the bulk "edit MCP servers" action).
 *
 * This is the OFFICE twin of the local BulkMcpModal (which fans an op over local
 * agent PATHS): office characters have no local path, so — exactly like the
 * single-character CharacterSettingsModal → McpEditorModal flow — it resolves
 * each selected character's OWN Operate/loop scratch workspace via
 * window.api.officeEnsureWorkspace({ cwd }) and routes the change through the
 * SAME CLI seam the single-character editor uses:
 *   • Add / Remove  → window.api.mcpApply({ op, name, server })
 *   • Creative app  → window.api.mcpDetect + window.api.mcpEnableApp
 *                     (enable) / window.api.mcpApply remove (disable)
 * so every write propagates to every provider and tags `_meta`, never a raw
 * .mcp.json edit.
 *
 * It does NOT merge/diff each character's config into one editor. The user picks
 * one operation and it is fanned out over the selection with per-character
 * progress + a pass/fail summary. A character whose workspace can't be prepared
 * locally is reported as failed and skipped — one failure never aborts the batch
 * (mirroring how this view treats a not-locally-operable character).
 */

type OpKind = 'add' | 'remove' | 'creative'

/** Per-character workspace resolution (a scratch dir prepared on demand). */
interface PrepState {
  path?: string
  error?: string
}

/** Per-character apply result, shown live as the batch runs. */
type RowResult = 'pending' | 'running' | 'ok' | { error: string }

const label: React.CSSProperties = {
  display: 'block', fontSize: 'var(--fs-section)', fontWeight: 600, letterSpacing: 'var(--ls-section)',
  textTransform: 'uppercase', color: 'var(--tx-dim)', marginBottom: 6
}
const hint: React.CSSProperties = {
  fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginTop: 6, lineHeight: 1.45
}
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--bg-input)', border: '1px solid var(--bd-1)',
  borderRadius: 'var(--r-input)', color: 'var(--tx-1)', fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-body)', padding: '7px 9px', outline: 'none'
}

const OPS: ReadonlyArray<{ id: OpKind; label: string }> = [
  { id: 'add', label: 'Add server' },
  { id: 'remove', label: 'Remove server' },
  { id: 'creative', label: 'Creative app' }
]

export interface BulkOfficeMcpModalProps {
  open: boolean
  /** The bulk-selected office characters (already scoped to the selected office). */
  agents: OfficeAgent[]
  onClose: () => void
  /** Fired after a batch runs (so the caller can refresh / keep the selection). */
  onApplied?: () => void
}

export function BulkOfficeMcpModal({ open, agents, onClose, onApplied }: BulkOfficeMcpModalProps): React.JSX.Element {
  const count = agents.length

  // The office list re-fetches on an 8s poll, so `agents` gets a fresh array (and
  // fresh element objects) identity every tick while the modal is open. Key the
  // one-time workspace resolution on the STABLE selection (the sorted id-join) and
  // read the live list from a ref, so a background poll can't re-run resolution and
  // wipe an in-progress choice (mirrors BulkModelModal's `seeded` guard). We then
  // operate on a snapshot captured at open (`workAgents`) so every downstream
  // memo/effect is poll-churn-proof too.
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const agentKey = useMemo(() => agents.map((a) => a.id).slice().sort().join('|'), [agents])
  const [workAgents, setWorkAgents] = useState<OfficeAgent[]>([])

  const [op, setOp] = useState<OpKind>('add')
  // Per-character workspace paths (resolved once on open, reused by every op).
  const [prep, setPrep] = useState<Map<string, PrepState>>(new Map())
  const [preparing, setPreparing] = useState(false)

  // ADD — a ready-to-apply catalog/custom pick from the shared picker. The
  // "choose a server" step opens that picker inside its OWN scrollable Modal
  // (McpServerPickerModal) rather than an inline dropdown: nested in this modal's
  // overflow:auto body an absolute dropdown gets clipped and its lower rows can't
  // be scrolled to, so the server list is reused as a bounded, scrollable modal.
  const [pick, setPick] = useState<McpPick | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  // REMOVE — the server name to remove + the union of names present across the
  // selection (quick-pick), lazily listed when the Remove tab is first shown.
  const [removeName, setRemoveName] = useState('')
  const [removeNames, setRemoveNames] = useState<string[]>([])
  const [removeLoaded, setRemoveLoaded] = useState(false)
  const [removeLoading, setRemoveLoading] = useState(false)

  // CREATIVE — detected apps (Blender / GIMP) + the chosen app/action.
  const [apps, setApps] = useState<DetectedApp[]>([])
  const [detecting, setDetecting] = useState(false)
  const [detectErr, setDetectErr] = useState('')
  const [appId, setAppId] = useState('')
  const [creativeAction, setCreativeAction] = useState<'enable' | 'disable'>('enable')

  // Batch lifecycle.
  const [phase, setPhase] = useState<'config' | 'running' | 'done'>('config')
  const [results, setResults] = useState<Map<string, RowResult>>(new Map())
  const [busy, setBusy] = useState(false)

  // ── Resolve every selected character's workspace once on open ──────────────
  // Same resolution the single-character editor uses (officeEnsureWorkspace →
  // { cwd }); a scratch workspace is created per character if it doesn't exist.
  useEffect(() => {
    if (!open) return
    let alive = true
    const snapshot = agentsRef.current.slice()
    setWorkAgents(snapshot)
    setOp('add'); setPick(null); setPickerOpen(false)
    setRemoveName(''); setRemoveNames([]); setRemoveLoaded(false)
    setApps([]); setAppId(''); setDetectErr(''); setCreativeAction('enable')
    setResults(new Map()); setPhase('config'); setBusy(false)
    setPreparing(true); setPrep(new Map())
    void (async () => {
      const entries = await Promise.all(
        snapshot.map(async (a): Promise<readonly [string, PrepState]> => {
          const fam = providerFamilyOf(a.provider)
          try {
            const r = await window.api.officeEnsureWorkspace(a.officeSlug, a.id, a.slug, fam === 'unknown' ? 'claude' : fam)
            if ('cwd' in r && r.cwd) return [a.id, { path: r.cwd }]
            return [a.id, { error: ('error' in r && r.error) || 'Could not prepare this character’s workspace.' }]
          } catch (e) {
            return [a.id, { error: e instanceof Error ? e.message : 'Could not prepare this character’s workspace.' }]
          }
        })
      )
      if (!alive) return
      setPrep(new Map(entries))
      setPreparing(false)
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentKey])

  // The characters we can actually operate on (workspace resolved locally).
  const readyAgents = useMemo(() => workAgents.filter((a) => prep.get(a.id)?.path), [workAgents, prep])
  const readyCount = readyAgents.length
  const unreadyCount = count - readyCount

  // ── REMOVE — lazily list the union of present server names ─────────────────
  useEffect(() => {
    if (!open || op !== 'remove' || preparing || removeLoaded) return
    let alive = true
    setRemoveLoading(true)
    void (async () => {
      const names = new Set<string>()
      for (const a of readyAgents) {
        const p = prep.get(a.id)?.path
        if (!p) continue
        try {
          const r = await window.api.mcpList(p)
          if ('servers' in r) for (const s of r.servers) names.add(s.name)
        } catch { /* a character we can't list just contributes no names */ }
      }
      if (!alive) return
      const sorted = [...names].sort((x, y) => x.localeCompare(y))
      setRemoveNames(sorted)
      setRemoveName((cur) => cur || sorted[0] || '')
      setRemoveLoaded(true)
      setRemoveLoading(false)
    })()
    return () => { alive = false }
  }, [open, op, preparing, removeLoaded, readyAgents, prep])

  // ── CREATIVE — detect apps once (detection is machine-global, so any one
  //    resolved workspace path is enough). ────────────────────────────────────
  useEffect(() => {
    if (!open || op !== 'creative' || preparing) return
    const firstPath = readyAgents.map((a) => prep.get(a.id)?.path).find(Boolean)
    if (!firstPath) { setApps([]); return }
    if (apps.length > 0 || detectErr) return
    let alive = true
    setDetecting(true); setDetectErr('')
    void (async () => {
      try {
        const r = (await window.api.mcpDetect(firstPath)) as { apps?: DetectedApp[]; error?: string }
        if (!alive) return
        if (r?.error) { setDetectErr(r.error); setApps([]) }
        else {
          const list = r?.apps ?? []
          setApps(list)
          setAppId((cur) => cur || list[0]?.id || '')
        }
      } catch (e) {
        if (alive) { setDetectErr(e instanceof Error ? e.message : 'Detection failed.'); setApps([]) }
      } finally {
        if (alive) setDetecting(false)
      }
    })()
    return () => { alive = false }
  }, [open, op, preparing, readyAgents, prep, apps.length, detectErr])

  const selectedApp = useMemo(() => apps.find((a) => a.id === appId) ?? null, [apps, appId])

  // Is the current op fully specified (so Apply is meaningful)?
  const canApply = useMemo(() => {
    if (readyCount === 0) return false
    if (op === 'add') return !!pick
    if (op === 'remove') return removeName.trim().length > 0
    if (op === 'creative') return !!selectedApp && (creativeAction === 'disable' || selectedApp.installed)
    return false
  }, [readyCount, op, pick, removeName, selectedApp, creativeAction])

  // Removing / disabling a load-bearing server across many characters is
  // destructive — gate it behind the app's NATIVE confirm (window.confirm is a
  // no-op in the sandboxed renderer), mirroring the local BulkMcpModal.
  const isDestructive = op === 'remove' || (op === 'creative' && creativeAction === 'disable')

  // A one-line description of the change for the summary header.
  const opSummary = useMemo(() => {
    if (op === 'add') return pick ? `Add “${pick.label ?? pick.name}”` : 'Add a server'
    if (op === 'remove') return removeName.trim() ? `Remove “${removeName.trim()}”` : 'Remove a server'
    if (op === 'creative' && selectedApp) return `${creativeAction === 'enable' ? 'Enable' : 'Disable'} ${selectedApp.name} MCP`
    return 'Creative app'
  }, [op, pick, removeName, selectedApp, creativeAction])

  // ── Apply the chosen op to every ready character, one at a time ────────────
  const apply = useCallback(async (): Promise<void> => {
    const targets = readyAgents
    if (targets.length === 0 || !canApply) return
    if (isDestructive) {
      const what = op === 'remove' ? `“${removeName.trim()}”` : `${selectedApp?.name ?? 'this app'}’s MCP server`
      const ok = await window.api.confirmDialog(
        `${op === 'remove' ? 'Remove' : 'Disable'} ${what} on ${targets.length} character${targets.length === 1 ? '' : 's'}?`,
        'This edits each character’s .mcp.json through the AutoDev CLI. Removing a load-bearing server (memory, the office server) can break a running agent on its next task.'
      )
      if (!ok) return
    }
    setPhase('running'); setBusy(true)
    const res = new Map<string, RowResult>()
    for (const a of targets) res.set(a.id, 'pending')
    setResults(new Map(res))
    for (const a of targets) {
      const path = prep.get(a.id)?.path
      if (!path) { res.set(a.id, { error: 'Workspace not available.' }); setResults(new Map(res)); continue }
      res.set(a.id, 'running'); setResults(new Map(res))
      try {
        let ok = false
        let err = 'Failed'
        if (op === 'add' && pick) {
          const r = await window.api.mcpApply({ path, op: 'add', name: pick.name, server: pick.server })
          ok = r.ok; if (!r.ok) err = r.error || `Could not add “${pick.name}”`
        } else if (op === 'remove' && removeName.trim()) {
          const r = await window.api.mcpApply({ path, op: 'remove', name: removeName.trim() })
          ok = r.ok; if (!r.ok) err = r.error || `Could not remove “${removeName.trim()}”`
        } else if (op === 'creative' && selectedApp) {
          if (creativeAction === 'enable') {
            const r = await window.api.mcpEnableApp({ path, app: selectedApp.id })
            ok = r.ok; if (!r.ok) err = r.error || `Could not enable ${selectedApp.name}`
          } else {
            // Disable mirrors CreativeAppsSection's remove — drop the MCP server
            // (the app's own files stay in place) via the same CLI seam.
            const r = await window.api.mcpApply({ path, op: 'remove', name: selectedApp.serverName })
            ok = r.ok; if (!r.ok) err = r.error || `Could not disable ${selectedApp.name}`
          }
        }
        res.set(a.id, ok ? 'ok' : { error: err })
      } catch (e) {
        res.set(a.id, { error: e instanceof Error ? e.message : 'Failed' })
      }
      setResults(new Map(res))
    }
    setBusy(false); setPhase('done')
    onApplied?.()
  }, [readyAgents, canApply, isDestructive, prep, op, pick, removeName, selectedApp, creativeAction, onApplied])

  const okCount = useMemo(() => [...results.values()].filter((r) => r === 'ok').length, [results])
  const failCount = useMemo(() => [...results.values()].filter((r) => r !== 'ok' && r !== 'pending' && r !== 'running').length, [results])

  const title = (
    <>Edit MCP servers <span style={{ color: 'var(--tx-5)', fontWeight: 400 }}>· {count} character{count === 1 ? '' : 's'}</span></>
  )

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={title}
      subtitle={
        phase === 'done'
          ? `${okCount} applied${failCount ? ` · ${failCount} failed` : ''}`
          : preparing
            ? 'Preparing workspaces…'
            : `${readyCount} of ${count} ready · change applies on each character’s next task`
      }
      subtitleMono={phase !== 'done'}
      footer={
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {phase === 'done' ? (
            <>
              <Button variant="secondary" onClick={() => { setPhase('config'); setResults(new Map()) }} disabled={busy}>
                Apply another
              </Button>
              <Button variant="primary" onClick={onClose}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant="primary" danger={isDestructive} onClick={() => void apply()} disabled={busy || preparing || !canApply}>
                {busy ? 'Applying…' : `Apply to ${readyCount}`}
              </Button>
            </>
          )}
        </div>
      }
    >
      {phase === 'config' && (
        <>
          {/* Operation switcher */}
          <div role="tablist" aria-label="MCP operation" style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
            {OPS.map((o) => {
              const on = op === o.id
              return (
                <button
                  key={o.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setOp(o.id)}
                  style={{
                    flex: 1, textAlign: 'center', padding: '7px 0', borderRadius: 'var(--r-button)',
                    background: on ? 'var(--bg-accent-soft)' : 'var(--bg-input)',
                    border: `1px solid ${on ? 'var(--bd-accent)' : 'var(--bd-1)'}`,
                    color: on ? 'var(--accent-ink)' : 'var(--tx-3)',
                    fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-meta)', fontWeight: on ? 600 : 400,
                    cursor: 'pointer'
                  }}
                >
                  {o.label}
                </button>
              )
            })}
          </div>

          {/* ── ADD ──────────────────────────────────────────────────────── */}
          {op === 'add' && (
            <div>
              <span style={label}>Server to add</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
                  <Icon name="plus" size={11} />
                  {pick ? 'Change server…' : 'Choose a server…'}
                </Button>
                {pick && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Pill variant="green" selected><Icon name="check" size={11} /> {pick.label ?? pick.name}</Pill>
                    <button
                      type="button"
                      onClick={() => setPick(null)}
                      aria-label="Clear selected server"
                      style={{ background: 'transparent', border: 'none', color: 'var(--tx-4)', cursor: 'pointer', display: 'inline-flex', padding: 2 }}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </span>
                )}
              </div>
              <div style={hint}>
                Adds this server (enabled) to all {readyCount} selected character{readyCount === 1 ? '' : 's'} via the AutoDev CLI, which syncs it to every provider. A character that already has it is left unchanged.
              </div>
            </div>
          )}

          {/* ── REMOVE ───────────────────────────────────────────────────── */}
          {op === 'remove' && (
            <div>
              <span style={label}>Server to remove</span>
              {removeLoading ? (
                <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-4)' }}>Reading servers across the selection…</div>
              ) : removeNames.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  {removeNames.map((n) => {
                    const on = removeName.trim() === n
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setRemoveName(n)}
                        style={{
                          padding: '4px 10px', borderRadius: 'var(--r-chip)', cursor: 'pointer',
                          background: on ? 'var(--bg-accent-soft)' : 'var(--bg-input)',
                          border: `1px solid ${on ? 'var(--bd-accent)' : 'var(--bd-1)'}`,
                          color: on ? 'var(--accent-ink)' : 'var(--tx-2)',
                          fontFamily: 'var(--font-mono)', fontSize: '11px'
                        }}
                      >
                        {n}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-4)', marginBottom: 10 }}>
                  No MCP servers found across the selected characters. You can still type a name below.
                </div>
              )}
              <input
                value={removeName}
                onChange={(e) => setRemoveName(e.target.value)}
                placeholder="server name (e.g. playwright)"
                aria-label="MCP server name to remove"
                list="bulk-office-mcp-remove-names"
                spellCheck={false}
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: '12px' }}
              />
              <datalist id="bulk-office-mcp-remove-names">
                {removeNames.map((n) => <option key={n} value={n} />)}
              </datalist>
              <div style={hint}>
                Removes this server from all {readyCount} selected character{readyCount === 1 ? '' : 's'} via the CLI. A character that doesn’t have it is reported as applied (nothing to remove).
              </div>
            </div>
          )}

          {/* ── CREATIVE APP ─────────────────────────────────────────────── */}
          {op === 'creative' && (
            <div>
              <span style={label}>Creative app</span>
              {detecting ? (
                <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-4)' }}>Scanning for creative apps…</div>
              ) : detectErr ? (
                <div style={{ padding: '10px 12px', background: 'var(--st-error-wash)', border: '1px solid var(--st-error-bd)', borderRadius: 'var(--r-card)', fontSize: 'var(--fs-desc)', color: 'var(--st-error-bright)' }}>
                  {detectErr}
                </div>
              ) : apps.length === 0 ? (
                <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-4)' }}>No creative apps detected on this machine.</div>
              ) : (
                <>
                  <NativeSelect value={appId} onChange={(e) => setAppId(e.target.value)} aria-label="Creative app">
                    {apps.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}{a.installed ? '' : ' (not installed)'}{a.experimental ? ' · experimental' : ''}
                      </option>
                    ))}
                  </NativeSelect>
                  <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                    {(['enable', 'disable'] as const).map((act) => {
                      const on = creativeAction === act
                      return (
                        <button
                          key={act}
                          type="button"
                          onClick={() => setCreativeAction(act)}
                          style={{
                            flex: 1, textAlign: 'center', padding: '6px 0', borderRadius: 'var(--r-button)',
                            background: on ? 'var(--bg-accent-soft)' : 'var(--bg-input)',
                            border: `1px solid ${on ? 'var(--bd-accent)' : 'var(--bd-1)'}`,
                            color: on ? 'var(--accent-ink)' : 'var(--tx-3)',
                            fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-meta)', fontWeight: on ? 600 : 400, cursor: 'pointer'
                          }}
                        >
                          {act === 'enable' ? 'Enable' : 'Disable'}
                        </button>
                      )
                    })}
                  </div>
                  {creativeAction === 'enable' && selectedApp && !selectedApp.installed && (
                    <div style={{ marginTop: 10, padding: '7px 10px', background: 'var(--st-needsyou-soft)', border: '1px solid var(--st-needsyou-bd)', borderRadius: 'var(--r-card)', fontSize: 'var(--fs-desc)', color: 'var(--st-needsyou)' }}>
                      {selectedApp.name} is not installed on this machine — install it before enabling.
                    </div>
                  )}
                  <div style={hint}>
                    {creativeAction === 'enable'
                      ? `Enables ${selectedApp?.name ?? 'the app'} as an MCP tool for all ${readyCount} selected character${readyCount === 1 ? '' : 's'} (propagated to every provider).`
                      : `Turns off ${selectedApp?.name ?? 'the app'}’s MCP server for all ${readyCount} selected character${readyCount === 1 ? '' : 's'} (its installed files stay in place).`}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Not-locally-operable characters — surfaced up-front so the "Apply to N"
              count is never a surprise. */}
          {!preparing && unreadyCount > 0 && (
            <div style={{ marginTop: 16, padding: '8px 11px', background: 'var(--st-needsyou-soft)', border: '1px solid var(--st-needsyou-bd)', borderRadius: 'var(--r-card)', fontSize: 'var(--fs-desc)', color: 'var(--st-needsyou)' }}>
              {unreadyCount} of {count} selected character{unreadyCount === 1 ? '' : 's'} couldn’t be prepared on this machine and will be skipped.
            </div>
          )}
        </>
      )}

      {/* ── RUNNING / DONE — per-character results ──────────────────────── */}
      {phase !== 'config' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ ...label, marginBottom: 0 }}>{opSummary}</span>
            {phase === 'done' && (
              <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-meta)', color: failCount ? 'var(--st-error)' : 'var(--st-running)' }}>
                {okCount}/{okCount + failCount} applied
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflow: 'auto' }}>
            {readyAgents.map((a) => {
              const r = results.get(a.id) ?? 'pending'
              const ok = r === 'ok'
              const errText = typeof r === 'object' ? r.error : ''
              const running = r === 'running'
              return (
                <div
                  key={a.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
                    background: 'var(--bg-elev)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-card)'
                  }}
                >
                  <span style={{ fontSize: 'var(--fs-body)', fontWeight: 600, color: 'var(--tx-1)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.name}
                  </span>
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {ok ? (
                      <Pill variant="green" selected><Icon name="check" size={11} /> Applied</Pill>
                    ) : errText ? (
                      <span title={errText} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-meta)', color: 'var(--st-error)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <Icon name="warn" size={11} /> {errText}
                      </span>
                    ) : running ? (
                      <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-4)' }}>Applying…</span>
                    ) : (
                      <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-dim)' }}>Queued</span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Modal>

    {/* "Choose a server" — the reused scrollable server picker (same catalog body
        as the per-character McpEditorModal's "Add custom…" menu), presented in its
        own Modal so its list always scrolls. Picking one sets the pending `pick`,
        which the existing Apply-to-N fan-out then applies to every ready character. */}
    <McpServerPickerModal
      open={pickerOpen}
      onClose={() => setPickerOpen(false)}
      onPick={(p) => setPick(p)}
      title="Choose a server to add"
      subtitle={`Adds to ${readyCount} selected character${readyCount === 1 ? '' : 's'} on their next task`}
    />
    </>
  )
}

export default BulkOfficeMcpModal
