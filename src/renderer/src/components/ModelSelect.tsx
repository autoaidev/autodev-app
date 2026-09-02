import React, { useMemo, useState } from 'react'
import { useModelCatalog, modelsForFamily, fmtCtx, vendorOf } from '@renderer/lib/providers'
import { NativeSelect } from '@renderer/components/NativeSelect'

/**
 * ModelSelect — the SINGLE model picker used by both the local Agent setup modal
 * and the office Character settings modal (and the Inspector's inline row).
 *
 * It turns the previously free-text model field into a real dropdown sourced from
 * the live CLI catalog (`window.api.listModels()`), while preserving two things a
 * free-text field gave power users:
 *   - "Provider default" (empty value) — the model the provider picks itself.
 *   - "Custom…" — reveals a raw id input for a model not (yet) in the catalog,
 *     and is auto-selected when a persisted value isn't a known catalog id, so an
 *     existing setting is never silently dropped.
 *
 * The friendly `label` is shown with a muted context-window hint ("· 200k ctx");
 * the raw `id` is what persists. `vendor` may be a family (`claude`) or a full
 * provider id (`claude-tui`) — both resolve to the same catalog family.
 */

const CUSTOM = '__custom__'

const inputStyle: React.CSSProperties = {
  width: '100%', background: 'var(--bg-input)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)',
  color: 'var(--tx-1)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)', padding: '7px 9px', outline: 'none'
}
const customInputStyle: React.CSSProperties = { ...inputStyle, marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-meta)' }

export interface ModelSelectProps {
  /** Provider family or full provider id (e.g. `claude` or `claude-tui`). */
  vendor: string
  /** The persisted raw model id ('' = provider default). */
  value: string
  /** Called with the new raw model id ('' = provider default). */
  onChange: (value: string) => void
  /** Optional select id (for label association). */
  id?: string
  compact?: boolean
}

export function ModelSelect({ vendor, value, onChange, id, compact }: ModelSelectProps): React.JSX.Element {
  const { catalog } = useModelCatalog()
  const models = useMemo(() => modelsForFamily(catalog, vendor), [catalog, vendor])
  const known = useMemo(() => new Set(models.map((m) => m.id)), [models])

  // A persisted id that isn't in the catalog → show Custom… with the raw input so
  // the setting survives. `forceCustom` lets a user open Custom… while empty too.
  const [forceCustom, setForceCustom] = useState(false)
  const custom = forceCustom || (!!value && !known.has(value))

  // #9 — validate a typed Custom id against the catalog ON BLUR (not per keystroke,
  // which would nag mid-type). A non-empty id the catalog doesn't know is NOT
  // blocked — power users need unlisted ids — but we warn it'll be sent verbatim.
  const [touched, setTouched] = useState(false)
  const unknownCustom = custom && touched && !!value.trim() && !known.has(value.trim())

  const onSelect = (v: string): void => {
    if (v === CUSTOM) { setForceCustom(true); setTouched(false); return }
    setForceCustom(false)
    setTouched(false)
    onChange(v)
  }

  return (
    <div>
      <NativeSelect id={id} compact={compact} value={custom ? CUSTOM : value} onChange={(e) => onSelect(e.target.value)} aria-label="Model">
        <option value="">Provider default</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}{m.contextLimit ? ` · ${fmtCtx(m.contextLimit)} ctx` : ''}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </NativeSelect>
      {custom && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder="model id (e.g. claude-opus-4-8)"
          aria-label="Custom model id"
          aria-invalid={unknownCustom || undefined}
          autoFocus={forceCustom}
          style={customInputStyle}
        />
      )}
      {unknownCustom && (
        <div
          role="note"
          style={{ marginTop: 5, fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', lineHeight: 1.4 }}
        >
          Not a known {vendorOf(vendor)} model — will be sent as-is.
        </div>
      )}
    </div>
  )
}

export default ModelSelect
