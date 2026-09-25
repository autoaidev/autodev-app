import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button } from '@renderer/ui'
import { ModelSelect } from '@renderer/components/ModelSelect'
import { NativeSelect } from '@renderer/components/NativeSelect'
import { AgentState } from '@renderer/services/model'
import { actions } from '@renderer/services/agentStore'
import { useAppActions } from '@renderer/services/appActions'
import { modelKeyFor, vendorOf, PROVIDER_GROUPS, ENGINE_FAMILIES, defaultProviderIdForFamily } from '@renderer/lib/providers'

/**
 * BulkModelModal (#6) — set the ENGINE (provider) and/or model across a multi-agent
 * selection in one pass.
 *
 * Two things this drives, chosen via the top "Engine" selector:
 *   1. KEEP CURRENT ENGINE (default) — model-only, exactly the original behavior.
 *      A selection can span vendors, and one model id is only valid for one vendor,
 *      so the modal makes the target explicit:
 *        - When the selection spans >1 vendor, a small vendor picker chooses WHICH
 *          vendor a concrete model applies to; the write only touches that vendor's
 *          items (each via its OWN key — grokModel for grok, claudeModel for claude…).
 *        - "Provider default" (the empty ModelSelect value) is provider-agnostic, so
 *          it applies to EVERY selected item (clears each one's own vendor key).
 *   2. A SPECIFIC ENGINE — CONVERSION. Every selected item is switched to that
 *      provider FAMILY (Claude/Grok/OpenCode/Copilot) and the model dropdown shows
 *      THAT engine's models; Apply writes BOTH provider and model to ALL selected
 *      items (the per-vendor split doesn't apply — the whole selection targets the
 *      one chosen engine). This is the office equivalent of the per-character
 *      CharacterSettingsModal's `updateCharacter({ provider: family, model })`.
 * After applying, we offer to restart/reconnect the still-active items so the new
 * engine/model (which only takes hold on the next loop/connect) applies now.
 *
 * ── Two persistence backends, one modal ─────────────────────────────────────
 * The SAME picker drives two very different writes without duplicating the UI:
 *   • LOCAL agents (Fleet): pass `agents` + `paths`. Each write goes through the
 *     `autodev config set <vendorKey>` path the per-agent Setup uses; the follow-up
 *     restarts the RUNNING agents.
 *   • OFFICE characters: pass a `BulkModelAdapter` (built from officeService). Each
 *     write persists via `updateCharacter({ model })` (PATCH /api/agents/{id}) — NOT
 *     `config set` — keeping every character's own provider; the follow-up reconnects
 *     the ONLINE characters.
 * The adapter is the seam: when provided it fully supplies the selection, the
 * per-item write, and the (optional) apply-now follow-up. When absent the modal
 * derives the local adapter from `agents`/`paths`, so existing Fleet call sites are
 * unchanged.
 */

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
/** Proper vendor display name (e.g. "OpenCode", "GitHub Copilot") from the family key. */
const vendorLabel = (v: string): string =>
  PROVIDER_GROUPS.find((g) => vendorOf(g.options[0].id) === v)?.vendor ?? cap(v)

/** One selected thing the modal applies a model to — a local agent OR an office character. */
export interface BulkModelItem {
  /** Stable identity handed back to `setModel`/`applyNow.run` (workspace path OR character id). */
  key: string
  /** Provider id/family (drives vendor grouping; both `claude` and `claude-tui` resolve alike). */
  provider: string
  /** Still-active (running local agent / online office character) — drives the follow-up offer. */
  active: boolean
}

/** The optional "apply now" follow-up shown after a successful write (restart / reconnect). */
export interface BulkModelApplyNow {
  /** Applied-phase subtitle, e.g. "3 online characters · reconnect to apply now". */
  subtitle: (n: number) => string
  /** Applied-phase body paragraph explaining why a running item needs the follow-up. */
  body: (n: number) => string
  /** Primary button label, e.g. "Reconnect 3 online". */
  buttonLabel: (n: number) => string
  /** Busy label while the follow-up runs, e.g. "Reconnecting…". */
  pendingLabel: string
  /** Confirmation toast after kicking off the follow-up, e.g. "Reconnecting this office…". */
  toast: (n: number) => string
  /** Run the follow-up over the active items' keys. */
  run: (activeKeys: string[]) => Promise<void>
}

/** The full backend the modal drives — selection + per-item write + optional follow-up. */
export interface BulkModelAdapter {
  items: BulkModelItem[]
  /**
   * Persist `model` ('' = provider default) for one item — and, when `family` is
   * given, ALSO switch the item's engine to that provider FAMILY (a conversion).
   * Return true on success. `family` undefined = keep the item's current engine.
   */
  setModel: (item: BulkModelItem, model: string, family?: string) => Promise<boolean>
  /** The optional restart/reconnect offered after applying to still-active items. */
  applyNow?: BulkModelApplyNow
  /** Selection-subtitle noun (singular), default "agent". */
  unit?: string
  /** Whether this backend can switch an item's engine (provider). Defaults to true;
   *  set false to hide the Engine selector (a backend that can only set the model). */
  canSetProvider?: boolean
}

interface BulkModelModalProps {
  open: boolean
  onClose: () => void
  /** Fired after a successful apply (or apply+follow-up) so the caller can clear the
   *  selection. Not fired on Cancel. */
  onApplied?: () => void
  /** LOCAL mode: the whole fleet (used to resolve each selected path → provider/running). */
  agents?: AgentState[]
  /** LOCAL mode: the selected workspace paths to apply the model to. */
  paths?: string[]
  /** GENERIC mode (office): supplies the selection, the per-item write, and the follow-up.
   *  When provided it fully replaces the local `agents`/`paths` derivation. */
  adapter?: BulkModelAdapter
}

export function BulkModelModal({ open, agents, paths, adapter, onClose, onApplied }: BulkModelModalProps): React.JSX.Element {
  const appActions = useAppActions()

  // Local backend derived from agents+paths (unchanged config-set behavior). Only
  // used when no explicit adapter is passed.
  const localAdapter = useMemo<BulkModelAdapter>(() => {
    const set = new Set(paths ?? [])
    const selected = (agents ?? []).filter((a) => set.has(a.path))
    return {
      unit: 'agent',
      // Local agents CAN change engine: `autodev config set provider <id>` (the same
      // seam Fleet's provider picker uses). A conversion writes the concrete provider
      // id for the family, then the model under that family's key.
      canSetProvider: true,
      items: selected.map((a) => ({ key: a.path, provider: a.provider || '', active: !!a.running })),
      setModel: async (item, model, family) => {
        try {
          if (family) {
            const pr = (await window.api.runCli([
              'config', 'set', 'provider', defaultProviderIdForFamily(family), item.key
            ])) as { code?: number }
            if (pr && pr.code !== undefined && pr.code !== 0) return false
          }
          // On a conversion, write the model under the NEW family's key (grokModel…),
          // not the item's old vendor key.
          const r = (await window.api.runCli([
            'config', 'set', modelKeyFor(family ?? item.provider), model, item.key
          ])) as { code?: number }
          return !r || r.code === 0
        } catch {
          return false
        }
      },
      applyNow: {
        subtitle: (n) => `${n} running agent${n === 1 ? '' : 's'} · restart to apply now`,
        body: (n) =>
          `Model saved. A running agent only picks up a new model on its next loop — restart the ${n} running agent${n === 1 ? '' : 's'} to apply it now, or leave them to apply on their next task.`,
        buttonLabel: (n) => `Restart ${n} running`,
        pendingLabel: 'Restarting…',
        toast: (n) => `Restarting ${n} agent${n === 1 ? '' : 's'}…`,
        run: async (keys) => {
          for (const k of keys) {
            try {
              await actions.restart(k)
            } catch {
              /* a failed restart still leaves the model saved; next start applies it */
            }
          }
        }
      }
    }
  }, [agents, paths])

  const eff = adapter ?? localAdapter
  const items = eff.items
  const unit = eff.unit ?? 'agent'

  // Distinct vendors in the selection, with counts (drives the mixed-provider picker).
  const vendorCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const it of items) {
      const v = vendorOf(it.provider || '')
      m.set(v, (m.get(v) || 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [items])

  const [engine, setEngine] = useState('') // '' = keep current engine; else a provider FAMILY (conversion)
  const [vendor, setVendor] = useState('')
  const [value, setValue] = useState('') // '' = provider default (provider-agnostic)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'pick' | 'applied'>('pick')
  const [activeAfter, setActiveAfter] = useState<BulkModelItem[]>([])

  // Whether this backend can switch engines (office always; local via `config set
  // provider`). When false the Engine selector is hidden and it's model-only.
  const canEngine = eff.canSetProvider !== false

  // Seed the picker ONCE per open (busiest vendor first, Keep current engine,
  // Provider default). Guarded by a ref so a background poll — which re-creates
  // `vendorCounts` every few seconds while the modal is open — can't reset an
  // in-progress choice or bounce the 'applied' phase back to 'pick'.
  const seeded = useRef(false)
  useEffect(() => {
    if (!open) {
      seeded.current = false
      return
    }
    if (seeded.current) return
    seeded.current = true
    setEngine('')
    setVendor(vendorCounts[0]?.[0] ?? 'claude')
    setValue('')
    setPhase('pick')
    setBusy(false)
    setActiveAfter([])
  }, [open, vendorCounts])

  // Converting = a specific engine was chosen → switch the WHOLE selection to it.
  const converting = engine !== ''
  const engineLabel = ENGINE_FAMILIES.find((f) => f.family === engine)?.label ?? vendorLabel(engine)
  // The family driving the Model dropdown: the chosen engine when converting, else
  // the mixed-vendor sub-picker's vendor (model-only mode).
  const modelVendor = converting ? engine : vendor
  const mixed = vendorCounts.length > 1
  // When converting, EVERY selected item is a target. Otherwise the write is scoped to
  // the chosen engine's items (matches the "set model for Grok (12)" option) — model
  // ids are per-engine, so a single write can only target one engine's characters.
  const targets = useMemo(
    () => (converting ? items : items.filter((it) => vendorOf(it.provider || '') === vendor)),
    [converting, items, vendor]
  )

  const apply = async (): Promise<void> => {
    if (targets.length === 0) return
    setBusy(true)
    let n = 0
    for (const it of targets) {
      if (await eff.setModel(it, value.trim(), converting ? engine : undefined)) n++
    }
    setBusy(false)
    const active = targets.filter((it) => it.active)
    appActions.toast(
      converting
        ? `Converted ${n} ${unit}${n === 1 ? '' : 's'} to ${engineLabel}${value.trim() ? '' : ' (provider default model)'}.`
        : `Set model for ${n} ${unit}${n === 1 ? '' : 's'}${value.trim() ? '' : ' to provider default'}.`,
      n === 0
    )
    if (n > 0 && active.length > 0 && eff.applyNow) {
      setActiveAfter(active)
      setPhase('applied')
    } else {
      onApplied?.()
      onClose()
    }
  }

  const runFollowUp = async (): Promise<void> => {
    if (!eff.applyNow) return
    setBusy(true)
    try {
      await eff.applyNow.run(activeAfter.map((it) => it.key))
    } finally {
      setBusy(false)
    }
    appActions.toast(eff.applyNow.toast(activeAfter.length))
    onApplied?.()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={canEngine ? 'Set engine & model' : 'Set model'}
      subtitle={
        phase === 'applied' && eff.applyNow
          ? eff.applyNow.subtitle(activeAfter.length)
          : `${items.length} selected ${unit}${items.length === 1 ? '' : 's'}`
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
                {busy ? 'Applying…' : converting ? `Convert ${targets.length}` : `Apply to ${targets.length}`}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={() => { onApplied?.(); onClose() }} disabled={busy}>
                Not now
              </Button>
              <Button variant="primary" size="sm" onClick={() => void runFollowUp()} disabled={busy}>
                {busy ? eff.applyNow?.pendingLabel ?? 'Working…' : eff.applyNow?.buttonLabel(activeAfter.length) ?? 'Apply now'}
              </Button>
            </>
          )}
        </div>
      }
    >
      {phase === 'applied' && eff.applyNow ? (
        <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-2)', lineHeight: 1.55 }}>
          {eff.applyNow.body(activeAfter.length)}
        </div>
      ) : (
        <>
          {(canEngine || mixed) && (
            <div style={{ marginBottom: 12 }}>
              <span style={labelStyle}>Engine</span>
              <NativeSelect
                value={converting ? `to:${engine}` : `keep:${vendor}`}
                onChange={(e) => {
                  // One control, two modes: `keep:<family>` sets a model for that engine's
                  // items (no conversion); `to:<family>` converts the WHOLE selection to
                  // that engine. Reset the model draft either way so a stale id from another
                  // family can't carry over (ModelSelect remounts on key={modelVendor}).
                  const v = e.target.value
                  if (v.startsWith('to:')) { setEngine(v.slice(3)); setValue('') }
                  else { setEngine(''); setVendor(v.slice(5)); setValue('') }
                }}
                aria-label="Engine and scope for the selection"
              >
                <optgroup label="Keep engine — set model for">
                  {vendorCounts.map(([v, n]) => (
                    <option key={`keep:${v}`} value={`keep:${v}`}>
                      {vendorLabel(v)} — {n} selected
                    </option>
                  ))}
                </optgroup>
                {canEngine && (
                  <optgroup label="Convert all to">
                    {ENGINE_FAMILIES.map((f) => (
                      <option key={`to:${f.family}`} value={`to:${f.family}`}>
                        {f.label}
                      </option>
                    ))}
                  </optgroup>
                )}
              </NativeSelect>
              <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginTop: 5, lineHeight: 1.45 }}>
                {converting ? (
                  <>
                    Switches <strong>all {items.length}</strong> selected {unit}
                    {items.length === 1 ? '' : 's'} to {engineLabel} (keeps each one&rsquo;s
                    name &amp; identity), then sets the model below. Applies on the next connect.
                  </>
                ) : mixed ? (
                  <>Sets the model for one engine&rsquo;s {unit}s. Use “Convert all to …” to move the whole selection to a single engine.</>
                ) : (
                  <>Set the model for the current engine, or convert the selection to another engine.</>
                )}
              </div>
            </div>
          )}

          <span style={labelStyle}>Model</span>
          {/* key={modelVendor}: remount on engine/vendor switch so ModelSelect's
              internal Custom… state resets (dropdown returns to Provider default, no
              stale raw input). ModelSelect carries the same on-blur "Not a known
              <provider> model" warning the per-agent picker and Fleet editor show. */}
          <ModelSelect key={modelVendor} vendor={modelVendor} value={value} onChange={setValue} />

          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginTop: 8, lineHeight: 1.45 }}>
            {converting
              ? value.trim()
                ? `Convert all ${items.length} ${unit}${items.length === 1 ? '' : 's'} to ${engineLabel} and set model ${value.trim()}.`
                : `Convert all ${items.length} ${unit}${items.length === 1 ? '' : 's'} to ${engineLabel} with its provider-default model.`
              : value.trim()
                ? `Sets model ${value.trim()} on ${targets.length} ${vendorLabel(vendor)} ${unit}${targets.length === 1 ? '' : 's'}.`
                : `Sets the provider-default model on ${targets.length} ${vendorLabel(vendor)} ${unit}${targets.length === 1 ? '' : 's'}.`}
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
