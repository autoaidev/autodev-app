import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button } from '@renderer/ui'
import { ModelSelect } from '@renderer/components/ModelSelect'
import { NativeSelect } from '@renderer/components/NativeSelect'
import { AgentState } from '@renderer/services/model'
import { actions } from '@renderer/services/agentStore'
import { useAppActions } from '@renderer/services/appActions'
import { modelKeyFor, vendorOf, PROVIDER_GROUPS } from '@renderer/lib/providers'

/**
 * BulkModelModal (#6) — set the model across a multi-agent selection in one pass.
 *
 * Mixed-provider handling: a selection can span vendors, and one model id is only
 * valid for one vendor. Rather than guess, the modal makes the target explicit:
 *   - When the selection spans >1 vendor, a small vendor picker chooses WHICH
 *     vendor a concrete model applies to; the write only touches that vendor's
 *     agents (each via its OWN key — grokModel for grok, claudeModel for claude…).
 *   - "Provider default" (the empty ModelSelect value) is provider-agnostic, so it
 *     applies to EVERY selected agent (clears each one's own vendor key).
 * After applying, we offer to restart the running agents so the new model (which
 * only takes hold on the next loop) applies now. Every write goes through the same
 * `config set <vendorKey>` path the per-agent Setup uses.
 */

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
/** Proper vendor display name (e.g. "OpenCode", "GitHub Copilot") from the family key. */
const vendorLabel = (v: string): string =>
  PROVIDER_GROUPS.find((g) => vendorOf(g.options[0].id) === v)?.vendor ?? cap(v)

interface BulkModelModalProps {
  open: boolean
  /** The whole fleet (used to resolve each selected path → provider/running). */
  agents: AgentState[]
  /** The selected workspace paths to apply the model to. */
  paths: string[]
  onClose: () => void
  /** Fired after a successful apply (or apply+restart) so the caller can clear the
   *  selection. Not fired on Cancel. */
  onApplied?: () => void
}

export function BulkModelModal({ open, agents, paths, onClose, onApplied }: BulkModelModalProps): React.JSX.Element {
  const appActions = useAppActions()
  const selected = useMemo(() => {
    const set = new Set(paths)
    return agents.filter((a) => set.has(a.path))
  }, [agents, paths])

  // Distinct vendors in the selection, with counts (drives the mixed-provider picker).
  const vendorCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of selected) {
      const v = vendorOf(a.provider || '')
      m.set(v, (m.get(v) || 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [selected])

  const [vendor, setVendor] = useState('')
  const [value, setValue] = useState('') // '' = provider default (provider-agnostic)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'pick' | 'applied'>('pick')
  const [runningAfter, setRunningAfter] = useState<AgentState[]>([])

  // Seed the picker ONCE per open (busiest vendor first, Provider default). Guarded
  // by a ref so the agentStore's background poll — which re-creates `vendorCounts`
  // every few seconds while the modal is open — can't reset an in-progress choice
  // or bounce the 'applied' phase back to 'pick'.
  const seeded = useRef(false)
  useEffect(() => {
    if (!open) {
      seeded.current = false
      return
    }
    if (seeded.current) return
    seeded.current = true
    setVendor(vendorCounts[0]?.[0] ?? 'claude')
    setValue('')
    setPhase('pick')
    setBusy(false)
    setRunningAfter([])
  }, [open, vendorCounts])

  const mixed = vendorCounts.length > 1
  // A concrete model only touches the chosen vendor's agents; Provider default ('')
  // is provider-agnostic and touches all selected.
  const targets = useMemo(
    () => (value.trim() ? selected.filter((a) => vendorOf(a.provider || '') === vendor) : selected),
    [value, selected, vendor]
  )

  const apply = async (): Promise<void> => {
    if (targets.length === 0) return
    setBusy(true)
    let n = 0
    for (const a of targets) {
      try {
        const r = (await window.api.runCli(
          ['config', 'set', modelKeyFor(a.provider || ''), value.trim(), a.path]
        )) as { code?: number }
        if (!r || r.code === 0) n++
      } catch {
        /* per-agent failure is counted by omission; surfaced in the toast total */
      }
    }
    setBusy(false)
    const running = targets.filter((a) => a.running)
    appActions.toast(
      `Set model for ${n} agent${n === 1 ? '' : 's'}${value.trim() ? '' : ' to provider default'}.`,
      n === 0
    )
    if (n > 0 && running.length > 0) {
      setRunningAfter(running)
      setPhase('applied')
    } else {
      onApplied?.()
      onClose()
    }
  }

  const restartRunning = async (): Promise<void> => {
    setBusy(true)
    for (const a of runningAfter) {
      try {
        await actions.restart(a.path)
      } catch {
        /* a failed restart still leaves the model saved; next start applies it */
      }
    }
    setBusy(false)
    appActions.toast(`Restarting ${runningAfter.length} agent${runningAfter.length === 1 ? '' : 's'}…`)
    onApplied?.()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set model"
      subtitle={
        phase === 'applied'
          ? `${runningAfter.length} running agent${runningAfter.length === 1 ? '' : 's'} · restart to apply now`
          : `${selected.length} selected agent${selected.length === 1 ? '' : 's'}`
      }
      subtitleMono
      width={460}
      footer={
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {phase === 'pick' ? (
            <>
              <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={() => void apply()} disabled={busy || targets.length === 0}>
                {busy ? 'Applying…' : `Apply to ${targets.length}`}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={() => { onApplied?.(); onClose() }} disabled={busy}>
                Not now
              </Button>
              <Button variant="primary" size="sm" onClick={() => void restartRunning()} disabled={busy}>
                {busy ? 'Restarting…' : `Restart ${runningAfter.length} running`}
              </Button>
            </>
          )}
        </div>
      }
    >
      {phase === 'applied' ? (
        <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-2)', lineHeight: 1.55 }}>
          Model saved. A running agent only picks up a new model on its next loop —
          restart the {runningAfter.length} running agent{runningAfter.length === 1 ? '' : 's'} to apply it now,
          or leave them to apply on their next task.
        </div>
      ) : (
        <>
          {mixed && (
            <div style={{ marginBottom: 12 }}>
              <span style={labelStyle}>Apply a specific model to</span>
              <NativeSelect
                value={vendor}
                onChange={(e) => {
                  // Switching target vendor must not carry a stale Custom id from the
                  // previous provider (a grok id could otherwise be applied to a claude
                  // agent). Reset the draft to Provider default; the `key={vendor}` on
                  // ModelSelect below remounts it so its Custom… input collapses too.
                  setVendor(e.target.value)
                  setValue('')
                }}
                aria-label="Provider to set the model for"
              >
                {vendorCounts.map(([v, n]) => (
                  <option key={v} value={v}>
                    {vendorLabel(v)} — {n} agent{n === 1 ? '' : 's'}
                  </option>
                ))}
              </NativeSelect>
              <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginTop: 5, lineHeight: 1.45 }}>
                Your selection spans {vendorCounts.length} providers. A specific model applies only to
                the chosen provider&rsquo;s agents. <strong>Provider default</strong> applies to all selected.
              </div>
            </div>
          )}

          <span style={labelStyle}>Model</span>
          {/* key={vendor}: remount on vendor switch so ModelSelect's internal Custom…
              state resets (dropdown returns to Provider default, no stale raw input).
              ModelSelect carries the same on-blur "Not a known <provider> model"
              warning the per-agent picker and Fleet editor show. */}
          <ModelSelect key={vendor} vendor={vendor} value={value} onChange={setValue} />

          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginTop: 8, lineHeight: 1.45 }}>
            {value.trim()
              ? `Applies to ${targets.length} ${vendorLabel(vendor)} agent${targets.length === 1 ? '' : 's'}${mixed ? ' (other providers in the selection are skipped)' : ''}. Restart to take hold.`
              : `Provider default — applies to all ${selected.length} selected agent${selected.length === 1 ? '' : 's'}. Restart to take hold.`}
          </div>
        </>
      )}
    </Modal>
  )
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

export default BulkModelModal
