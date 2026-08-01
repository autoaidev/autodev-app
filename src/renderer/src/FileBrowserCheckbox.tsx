export interface FileBrowserCheckboxProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  id?: string
}

/**
 * The shared "Enable file browser" checkbox + helper text. Reused by the Create
 * dialog and the Connect dialog so the control (and its copy) live in one place.
 * The caller decides how to apply it — `--file-browser` connect arg and/or the
 * `enableFileBrowser` settings key.
 */
export default function FileBrowserCheckbox({ checked, onChange, disabled, id }: FileBrowserCheckboxProps): JSX.Element {
  return (
    <label className="check" htmlFor={id} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0 10px', cursor: 'pointer' }}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} style={{ width: 'auto' }} />
      <span>Enable file browser <span style={{ color: 'var(--fg2,#8b95a7)', fontSize: 12 }}>— browse &amp; edit this agent's files from the office</span></span>
    </label>
  )
}
