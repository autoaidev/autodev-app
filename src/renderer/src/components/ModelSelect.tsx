import React, { useMemo, useState } from 'react'
import { useModelCatalog, modelsForFamily } from '@renderer/lib/providers'

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

const fmtCtx = (n?: number): string => {
  if (!n) return ''
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`
}

const inputStyle: React.CSSProperties = {
  width: '100%', background: 'var(--bg-input)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)',
  color: 'var(--tx-1)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)', padding: '7px 9px', outline: 'none'
}
const selectStyle: React.CSSProperties = { ...inputStyle, appearance: 'none', cursor: 'pointer' }
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

  const onSelect = (v: string): void => {
    if (v === CUSTOM) { setForceCustom(true); return }
    setForceCustom(false)
    onChange(v)
  }

  const s = compact ? { ...selectStyle, padding: '4px 7px', fontSize: 'var(--fs-meta)' } : selectStyle

  return (
    <div>
      <select id={id} value={custom ? CUSTOM : value} onChange={(e) => onSelect(e.target.value)} style={s} aria-label="Model">
        <option value="">Provider default</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}{m.contextLimit ? ` · ${fmtCtx(m.contextLimit)} ctx` : ''}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {custom && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="model id (e.g. claude-opus-4-8)"
          aria-label="Custom model id"
          autoFocus={forceCustom}
          style={customInputStyle}
        />
      )}
    </div>
  )
}

export default ModelSelect
