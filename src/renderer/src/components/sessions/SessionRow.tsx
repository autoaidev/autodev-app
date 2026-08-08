import { StatusDot, Pill } from '@renderer/ui'
import { type SessionMeta, ago, baseName, countLabel } from './types'

/**
 * A single session list row (2d). The task title is the HEADLINE (never a wall of
 * "(untitled)"); the id + provider collapse into a dim mono meta line. Live rows
 * carry a green glow dot + a LIVE badge and, when selected, the inset accent rail
 * (applied by the parent via the `.sel` class).
 */
export function SessionRow({
  session,
  selected,
  onSelect
}: {
  session: SessionMeta
  selected: boolean
  onSelect: (s: SessionMeta) => void
}): JSX.Element {
  const s = session
  const meta = `${baseName(s.cwd)} · ${s.provider} · ${ago(s.mtime)} · ${countLabel(s)}`
  return (
    <button
      type="button"
      className={'sv-row' + (selected ? ' sel' : '') + (s.live ? '' : ' idle')}
      aria-pressed={selected}
      onClick={() => onSelect(s)}
    >
      <div className="sv-row-top">
        <StatusDot status={s.live ? 'running' : 'idle'} glow={s.live} />
        <span className="sv-row-title" title={s.title}>{s.title || '(untitled)'}</span>
        {s.live && <Pill variant="green" mono selected>LIVE</Pill>}
      </div>
      <div className="sv-row-meta" title={`${s.cwd} · ${s.id}`}>{meta}</div>
    </button>
  )
}

export default SessionRow
