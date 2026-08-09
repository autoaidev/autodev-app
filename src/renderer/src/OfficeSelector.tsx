import type { LocalOffice, Office } from './composables/useOfficeSelection'
import { NEW_OFFICE } from './composables/useOfficeSelection'

// Match the app-wide field styling (theme.css tokens — same set as MakeAppView's
// `.makeapp-input`), so this control reads as the same field group as the rest of
// the app. Legacy --bg/--border/--fg/--muted vars are gone.
const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', marginBottom: 0, padding: '8px 10px',
  background: 'var(--bg-input)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)',
  color: 'var(--tx-1)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)', outline: 'none'
}
const fieldLabel: React.CSSProperties = {
  display: 'block', fontSize: 'var(--fs-desc)', fontWeight: 600, color: 'var(--tx-2)', margin: '0 0 6px'
}

export interface OfficeSelectorProps {
  /** Whether we have a live pixel-office session (gates the REMOTE office option). */
  connected: boolean
  /** "Connect to pixel office" checkbox. */
  useOffice: boolean
  onToggle: (v: boolean) => void
  /** Office list + current selection (bindings from useOfficeSelection). */
  offices: Office[]
  selectedOfficeId: string
  onSelect: (v: string) => void
  disabled?: boolean
  /** Show the ＋ New office option (Spawn-agents creates one from the description; Create dialog picks existing only). */
  allowNewOffice?: boolean
  /** Label for the ＋ New office option. */
  newOfficeLabel?: string
  /** Explanatory note shown when the checkbox is unchecked (local-only). */
  uncheckedNote?: React.ReactNode
  /** Shown in place of the dropdown when checked but there are no existing offices and ＋New isn't allowed. */
  noOfficesNote?: React.ReactNode
  /** Unique-id prefix so multiple selectors can coexist on a page. */
  idPrefix?: string
  /** Wrap in a bordered card (default). Set false to render inline (e.g. inside a modal). */
  boxed?: boolean
  /**
   * LOCAL offices derived from the live fleet — lets you spawn into a folder that
   * already houses a team, independent of any pixel-office connection. When
   * non-empty, a "Spawn into an existing local office" picker is shown even when
   * offline. `selectedLocalOffice` is the currently-chosen folder path ('' = none).
   */
  localOffices?: LocalOffice[]
  selectedLocalOffice?: string
  onSelectLocalOffice?: (path: string) => void
}

/**
 * Presentational office selector. Two independent sections:
 *  • LOCAL — pick an existing local-office folder (from the fleet) to spawn into.
 *    Always available (no connection needed) whenever `localOffices` is non-empty.
 *  • REMOTE — the "Connect to pixel office" checkbox + office dropdown, shown only
 *    while connected. Preserved so a signed-in user can still target a pixel office.
 * State/behavior come from `useOfficeSelection` via props.
 */
export default function OfficeSelector({
  connected,
  useOffice,
  onToggle,
  offices,
  selectedOfficeId,
  onSelect,
  disabled,
  allowNewOffice = false,
  newOfficeLabel = '＋ New office',
  uncheckedNote,
  noOfficesNote,
  idPrefix = 'office',
  boxed = true,
  localOffices = [],
  selectedLocalOffice = '',
  onSelectLocalOffice
}: OfficeSelectorProps): JSX.Element | null {
  const hasLocal = localOffices.length > 0 && !!onSelectLocalOffice
  // Nothing to show if we're offline AND there are no local offices to target.
  if (!connected && !hasLocal) return null

  const checkId = `${idPrefix}-useoffice`
  const selectId = `${idPrefix}-office`
  const localId = `${idPrefix}-localoffice`
  const showNoOffices = useOffice && !allowNewOffice && offices.length === 0
  // Only reflect the local selection if it actually points at a known local office.
  const localValue = localOffices.some((o) => o.path === selectedLocalOffice) ? selectedLocalOffice : ''

  const body = (
    <>
      {/* ── LOCAL offices — independent of the pixel-office connection ── */}
      {hasLocal && (
        <div style={{ marginBottom: connected ? 12 : 0 }}>
          <label style={fieldLabel} htmlFor={localId}>Spawn into an existing local office</label>
          <select
            id={localId}
            value={localValue}
            onChange={(e) => onSelectLocalOffice?.(e.target.value)}
            style={inp}
            disabled={disabled}
          >
            <option value="">＋ New folder (choose below)</option>
            {localOffices.map((o) => (
              <option key={o.path} value={o.path}>
                {o.label} — {o.count} agent{o.count === 1 ? '' : 's'}
              </option>
            ))}
          </select>
          <p style={{ margin: '6px 0 0', fontSize: 'var(--fs-meta)', color: 'var(--tx-dim)', lineHeight: 1.5 }}>
            Pick a folder that already holds a team to spawn the new agents alongside it — no pixel office required.
          </p>
        </div>
      )}

      {/* ── REMOTE pixel office — only meaningful while connected ── */}
      {connected && (
        <>
          <label htmlFor={checkId} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 'var(--fs-body)', color: 'var(--tx-1)' }}>
            <input id={checkId} type="checkbox" checked={useOffice} onChange={(e) => onToggle(e.target.checked)}
              style={{ width: 'auto', margin: 0 }} disabled={disabled} />
            Connect to pixel office
          </label>
          {useOffice ? (
            showNoOffices ? (
              <p style={{ margin: '8px 0 0', fontSize: 'var(--fs-meta)', color: 'var(--tx-dim)', lineHeight: 1.5 }}>
                {noOfficesNote ?? 'No offices yet — create one in the Office view first.'}
              </p>
            ) : (
              <div style={{ marginTop: 10 }}>
                <label style={fieldLabel} htmlFor={selectId}>Office</label>
                <select id={selectId} value={selectedOfficeId}
                  onChange={(e) => onSelect(e.target.value)} style={inp} disabled={disabled}>
                  {allowNewOffice && <option value={NEW_OFFICE}>{newOfficeLabel}</option>}
                  {offices.map((o) => <option key={o.id} value={String(o.id)}>{o.name}</option>)}
                </select>
              </div>
            )
          ) : (
            uncheckedNote && (
              <p style={{ margin: '8px 0 0', fontSize: 'var(--fs-meta)', color: 'var(--tx-dim)', lineHeight: 1.5 }}>{uncheckedNote}</p>
            )
          )}
        </>
      )}
    </>
  )

  if (!boxed) return <div style={{ marginBottom: 14 }}>{body}</div>
  return (
    <div style={{ marginBottom: 16, padding: 12, background: 'var(--bg-panel)', border: '1px solid var(--bd-card)', borderRadius: 'var(--r-card)' }}>
      {body}
    </div>
  )
}
