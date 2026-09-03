import React from 'react'
import { StatusDot, AgentAvatar, IconButton } from '@renderer/ui'
import { stateColor } from '@renderer/services/model'
import { OfficeAgent, tickFor } from './officeTypes'

/**
 * CharacterCard — one tile in the 4-col character grid (2c).
 *
 * Connected: avatar tile + name + provider mono + status dot + activity subtitle.
 * Disconnected: dashed avatar border, dimmed, with a blue "Connect & operate" CTA.
 * Selected + connected: inset accent ring.
 */

/**
 * Canonical provider display — one label form app-wide (matches Settings'
 * "Grok / Claude / OpenCode / Copilot"), so the rail never shows the raw runner
 * id (`grok-cli` / `grok-tui`). The runner suffix is dropped; the family name is
 * what the user recognises.
 */
export function providerLabel(id: string): string {
  const s = (id || '').toLowerCase()
  if (s.startsWith('grok')) return 'Grok'
  if (s.startsWith('claude')) return 'Claude'
  if (s.startsWith('opencode')) return 'OpenCode'
  if (s.startsWith('copilot')) return 'Copilot'
  return id
}
export interface CharacterCardProps {
  agent: OfficeAgent
  selected: boolean
  busy: boolean
  onSelect: () => void
  onOperate: () => void
  /** Open the SETTINGS editor for this character (provider / model / name). */
  onSettings?: () => void
  /** The character's effective model as a friendly label (e.g. "Grok 4"), shown as a
   *  muted line so a set (or bulk-set) model is confirmable at a glance. Empty = hidden. */
  modelLabel?: string
  /** When true, show a bulk-selection checkbox (independent of the focus `selected`). */
  selectable?: boolean
  /** Whether this card is in the bulk selection. */
  checked?: boolean
  /** Toggle the bulk selection for this character. */
  onToggleSelect?: () => void
}

export function CharacterCard({
  agent,
  selected,
  busy,
  onSelect,
  onOperate,
  onSettings,
  modelLabel,
  selectable,
  checked,
  onToggleSelect
}: CharacterCardProps): React.JSX.Element {
  const connected = agent.online
  const tick = tickFor(agent)
  const dotStatus = !connected ? 'idle' : tick === 'needs-you' ? 'needs-you' : 'running'
  // subtitle: amber attention line, else the raw status, else provider hint.
  const subtitle = !connected
    ? 'not connected'
    : tick === 'needs-you'
      ? (agent.status || 'asked you a question')
      : (agent.status || 'working…')

  return (
    <div
      onClick={onSelect}
      role="button"
      aria-pressed={selected}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        padding: '10px 11px',
        borderRadius: 'var(--r-card)',
        background: 'var(--bg-panel)',
        border: `1px solid ${selected && connected ? 'var(--bd-panel-sel)' : 'var(--bd-nav)'}`,
        boxShadow: selected && connected ? 'inset 0 0 0 1px var(--accent-tint)' : undefined,
        opacity: connected ? 1 : 0.55,
        cursor: 'pointer',
        minWidth: 0
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {selectable && (
          <input
            type="checkbox"
            checked={!!checked}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              e.stopPropagation()
              onToggleSelect?.()
            }}
            aria-label={`Select ${agent.name} for bulk actions`}
            style={{ cursor: 'pointer', margin: 0, flex: 'none' }}
          />
        )}
        {/* shared identity tile — per-character hue + provider ring (same system the
            Agents rail / Fleet table use), so every office character is a distinct
            colored object instead of the same fixed blue square. */}
        <AgentAvatar
          name={agent.name}
          idKey={agent.id}
          provider={agent.provider}
          size={22}
          disconnected={!connected}
          dim={!connected}
          // Online character → its real pixel-art face; offline → dashed monogram.
          avatarUrl={agent.avatarUrl}
          avatarColor={agent.color}
          online={connected}
          title={agent.name}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 'var(--fs-meta)',
              fontWeight: 600,
              color: 'var(--tx-hi)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {agent.name}
          </div>
          {agent.provider && (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-tiny)',
                color: 'var(--tx-4)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {providerLabel(agent.provider)}
            </div>
          )}
          {modelLabel && (
            <div
              title={`Model: ${modelLabel}`}
              style={{
                fontSize: 'var(--fs-tiny)',
                color: 'var(--tx-5)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {modelLabel}
            </div>
          )}
        </div>
        <StatusDot status={dotStatus} glow={connected && tick === 'live'} />
        {onSettings && (
          <IconButton
            label={`Settings for ${agent.name}`}
            icon="gear"
            size={22}
            iconSize={12}
            onClick={(e) => {
              e.stopPropagation()
              onSettings()
            }}
          />
        )}
      </div>

      <div
        style={{
          fontSize: 'var(--fs-desc)',
          // Status LABEL color from the shared state map (R-E): connected+working →
          // running green, waiting-on-you → amber, offline → dim. So an online,
          // working character no longer reads the same grey as an idle one.
          color: !connected
            ? 'var(--tx-4)'
            : stateColor(tick === 'needs-you' ? 'needs-auth' : 'working'),
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {subtitle}
      </div>

      {/* Operate affordance — ALWAYS present (D1). For an ONLINE character this is
          the only way to open its live terminal; offline it doubles as connect. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onOperate()
        }}
        disabled={busy}
        aria-label={connected ? `Open console for ${agent.name}` : `Connect and operate ${agent.name}`}
        style={{
          alignSelf: 'flex-start',
          padding: 0,
          background: 'transparent',
          border: 'none',
          color: 'var(--accent)',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--fs-desc)',
          fontWeight: 600,
          cursor: busy ? 'default' : 'pointer'
        }}
      >
        {busy
          ? connected
            ? 'Opening…'
            : 'Connecting…'
          : connected
            ? 'Open console'
            : 'Connect & operate'}
      </button>
    </div>
  )
}

export default CharacterCard
