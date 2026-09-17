import React from 'react'
import { StatusPill, Chip, AgentAvatar, IconButton, Icon } from '@renderer/ui'
import type { StatusVariant } from '@renderer/ui'
import { stateColor } from '@renderer/services/model'
import { providerAccent } from '@renderer/services/identity'
import { useAdvancedMode } from '@renderer/services/advancedMode'
import { AgentLifecycleControls } from '@renderer/components/agent/AgentLifecycleControls'
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
  /**
   * True when THIS app owns a live Operate session (interactive PTY) for the
   * character — i.e. the loop this app launched and can stop. Drives which
   * lifecycle control the card shows: Start when not running, Stop + Restart when
   * running. Distinct from `agent.online` (office presence, which may be a remote
   * loop this app cannot stop per-character).
   */
  running?: boolean
  /** Stop this app's Operate session for the character (kills its PTY). */
  onStop?: () => void
  /** Restart it — stop the live Operate session, then connect & operate again. */
  onRestart?: () => void
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
  running,
  onStop,
  onRestart,
  onSettings,
  modelLabel,
  selectable,
  checked,
  onToggleSelect
}: CharacterCardProps): React.JSX.Element {
  const connected = agent.online
  // Basic softens the CTA to a plain "Connect" and hides the online "Open console"
  // (operating a live terminal is an Advanced action). Advanced keeps both.
  const { advanced } = useAdvancedMode()
  const accent = providerAccent(agent.provider)
  const tick = tickFor(agent)
  // Live status as a tint-pair StatusPill: offline → neutral OFFLINE, waiting on you
  // → warn NEEDS YOU, live → good LIVE. One consistent status language app-wide.
  const status: { variant: StatusVariant; label: string } = !connected
    ? { variant: 'neutral', label: 'OFFLINE' }
    : tick === 'needs-you'
      ? { variant: 'warn', label: 'NEEDS YOU' }
      : { variant: 'good', label: 'LIVE' }
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
        padding: 'var(--pad-card)',
        borderRadius: 'var(--r-card-lg)',
        // Lifted card (top-lit gradient + composite depth) that carries the PROVIDER
        // hue on its left edge even at rest / offline, so a stopped character is a
        // recognizable colored object rather than a dim grey tile.
        background: 'var(--grad-card)',
        border: `1px solid ${selected && connected ? 'var(--bd-panel-sel)' : 'var(--bd-card)'}`,
        boxShadow: [
          `inset 3px 0 0 ${accent.fg}`,
          selected && connected ? 'inset 0 0 0 1px var(--accent)' : '',
          'var(--depth-card)'
        ]
          .filter(Boolean)
          .join(', '),
        // Offline is dimmed, but far less than before so its provider hue still reads.
        opacity: connected ? 1 : 0.74,
        cursor: 'pointer',
        minWidth: 0
      }}
    >
      {/* HEADER ROW — avatar · name · gear. Name owns all the slack (flex + ellipsis)
          so it truncates cleanly; the provider Chip and StatusPill live on their OWN
          row below, so neither can clip mid-word or be occluded by the other (F2). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
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
        <div
          title={agent.name}
          style={{
            flex: 1,
            minWidth: 0,
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

      {/* META ROW — provider Chip (left, brand hue, flex:none so it never clips) ·
          model label (takes the slack, ellipsis) · StatusPill (right, flex:none).
          The two pills are pinned to opposite ends with the model between them, so
          they can never overlap regardless of card width. */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, rowGap: 5, minWidth: 0 }}>
        {agent.provider && (
          <Chip variant="provider" provider={agent.provider} style={{ flex: '0 0 auto', maxWidth: '100%' }}>
            {providerLabel(agent.provider)}
          </Chip>
        )}
        {modelLabel && (
          <span
            title={`Model: ${modelLabel}`}
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              fontSize: 'var(--fs-tiny)',
              color: 'var(--tx-5)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {modelLabel}
          </span>
        )}
        <StatusPill
          variant={status.variant}
          label={status.label}
          size="sm"
          // A LIVE (online, not waiting-on-you) character breathes to signal presence.
          live={connected && tick !== 'needs-you'}
          style={{ marginLeft: 'auto', flex: '0 0 auto' }}
        />
      </div>

      {/* Offline subtitle is just "not connected" — redundant with the idle dot + the
          Connect link, so Basic drops it (keeps the card to name + ring + Connect).
          A connected character keeps its live status line; Advanced keeps both. */}
      {(connected || advanced) && (
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
      )}

      {/* LIFECYCLE controls — on their own footer row so they never overlap the
          status / meta pills (F2). Which control shows follows the app-owned Operate
          session state (`running`), not office presence:
            • running  → Stop + Restart (you can stop what this app launched), plus an
                         Advanced "Open console" link to focus the live terminal.
            • !running → Start: "Connect & operate" (offline) / "Operate" (online but
                         no app session). Operating a live online character is an
                         Advanced action, so Basic hides Start for an already-online
                         character (matches the prior card behavior); an offline
                         character keeps its Connect CTA in Basic. */}
      {running ? (
        // Shared Start/Stop/Restart cluster (icon variant) — Start is driven by the
        // office Connect CTA below, so this surface only needs Stop + Restart. The
        // Advanced "Open console" link rides along in the cluster's `after` slot.
        <AgentLifecycleControls
          running
          name={agent.name}
          size={24}
          iconSize={12}
          busy={busy}
          hideStart
          onStop={() => onStop?.()}
          onRestart={() => onRestart?.()}
          after={
            advanced && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onOperate()
                }}
                disabled={busy}
                aria-label={`Open console for ${agent.name}`}
                style={{
                  marginLeft: 2,
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
                {busy ? 'Opening…' : 'Open console'}
              </button>
            )
          }
        />
      ) : (
        (advanced || !connected) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOperate()
            }}
            disabled={busy}
            aria-label={connected ? `Operate ${agent.name}` : `Connect ${agent.name}`}
            style={{
              alignSelf: 'flex-start',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
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
            <Icon name="play" size={11} />
            {busy
              ? 'Connecting…'
              : connected
                ? 'Operate'
                : advanced
                  ? 'Connect & operate'
                  : 'Connect'}
          </button>
        )
      )}
    </div>
  )
}

export default CharacterCard
