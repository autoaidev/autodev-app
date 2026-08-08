import React from 'react'
import { StatusDot } from '@renderer/ui'
import { OfficeAgent, initials, tickFor } from './officeTypes'

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
}

export function CharacterCard({
  agent,
  selected,
  busy,
  onSelect,
  onOperate
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
        <div
          style={{
            width: 'var(--sz-avatar)',
            height: 'var(--sz-avatar)',
            flex: 'none',
            borderRadius: 'var(--r-chip)',
            background: 'var(--role-blue-av-bg)',
            color: 'var(--accent-ink)',
            border: connected ? '1px solid transparent' : '1px dashed var(--bd-idle-box)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-micro)',
            fontWeight: 700
          }}
        >
          {initials(agent.name)}
        </div>
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
        </div>
        <StatusDot status={dotStatus} glow={connected && tick === 'live'} />
      </div>

      <div
        style={{
          fontSize: 'var(--fs-desc)',
          color: tick === 'needs-you' ? 'var(--st-needsyou)' : 'var(--tx-4)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {subtitle}
      </div>

      {!connected && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOperate()
          }}
          disabled={busy}
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
          {busy ? 'Connecting…' : 'Connect & operate'}
        </button>
      )}
    </div>
  )
}

export default CharacterCard
