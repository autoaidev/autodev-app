import type { Office } from './composables/useOfficeSelection'
import { NEW_OFFICE } from './composables/useOfficeSelection'

// Match the app-wide input styling (styles.css `input,select,textarea` / `.fld-input`)
// so this control reads as the same field set as the rest of the app.
const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', marginBottom: 0, padding: '8px 10px',
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--fg)', fontSize: 13
}

export interface OfficeSelectorProps {
  /** Only rendered when connected — a pixel-office selector is meaningless offline. */
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
}

/**
 * Presentational "Connect to pixel office" selector: a checkbox that, when on,
 * reveals an office dropdown (optionally with a ＋ New office option). Shared by
 * the Create dialog and the Spawn-agents view so both drive one implementation.
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
  boxed = true
}: OfficeSelectorProps): JSX.Element | null {
  if (!connected) return null

  const checkId = `${idPrefix}-useoffice`
  const selectId = `${idPrefix}-office`
  const showNoOffices = useOffice && !allowNewOffice && offices.length === 0

  const body = (
    <>
      <label htmlFor={checkId} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--fg)' }}>
        <input id={checkId} type="checkbox" checked={useOffice} onChange={(e) => onToggle(e.target.checked)}
          style={{ width: 'auto', margin: 0 }} disabled={disabled} />
        Connect to pixel office
      </label>
      {useOffice ? (
        showNoOffices ? (
          <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
            {noOfficesNote ?? 'No offices yet — create one in the Office view first.'}
          </p>
        ) : (
          <div style={{ marginTop: 10 }}>
            <label className="fld" htmlFor={selectId}>Office</label>
            <select className="fld-input" id={selectId} value={selectedOfficeId}
              onChange={(e) => onSelect(e.target.value)} style={inp} disabled={disabled}>
              {allowNewOffice && <option value={NEW_OFFICE}>{newOfficeLabel}</option>}
              {offices.map((o) => <option key={o.id} value={String(o.id)}>{o.name}</option>)}
            </select>
          </div>
        )
      ) : (
        uncheckedNote && (
          <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>{uncheckedNote}</p>
        )
      )}
    </>
  )

  if (!boxed) return <div style={{ marginBottom: 14 }}>{body}</div>
  return (
    <div style={{ marginBottom: 16, padding: 12, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
      {body}
    </div>
  )
}
