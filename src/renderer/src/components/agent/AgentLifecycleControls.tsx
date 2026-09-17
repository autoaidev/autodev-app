import React from 'react'
import { Button, IconButton, Icon } from '@renderer/ui'

/**
 * AgentLifecycleControls — the ONE Start / Stop / Restart control cluster shared
 * by every agent-card surface (office CharacterCard, Fleet rows, the Agents-view
 * detail card). Before this, each surface hand-rolled the same running→Stop/Start
 * toggle + Restart with slightly different labels and busy handling; this unifies
 * the decision + a11y + disabled logic so look and behavior stay identical.
 *
 * Which control shows follows `running`:
 *   • running  → Stop + Restart
 *   • !running → Start + Restart
 * Restart is always available (the agent has a workspace / session to restart;
 * on an errored agent it doubles as Retry).
 *
 * Two presentations, one behavior:
 *   • variant="icon"   — compact IconButton cluster (CharacterCard, Fleet rows).
 *   • variant="button" — labeled Buttons with a CTA hierarchy (AgentDetail header):
 *                        Start is the accent hero, Stop/Restart are demoted.
 *
 * The wiring is the caller's: office cards pass OfficeView's operate/stop/restart,
 * local cards pass agentStore start/stop/restart. This component never reaches for
 * a store itself.
 */
export interface AgentLifecycleControlsProps {
  /** True when a live loop/session this surface can stop is running. */
  running: boolean
  onStart?: () => void
  onStop?: () => void
  onRestart?: () => void
  /** Disables every control + softens the label (e.g. while an operate call is in flight). */
  busy?: boolean
  /** Disable only Stop (e.g. an external loop this app didn't launch and can't kill). */
  stopDisabled?: boolean
  /** Agent name — folded into the accessible labels ("Stop <name>"). */
  name?: string
  /** Presentation. Default 'icon'. */
  variant?: 'icon' | 'button'
  /** icon variant only — IconButton box + glyph px (defaults 22 / 11). */
  size?: number
  iconSize?: number
  /** Hide Start when stopped (office cards drive Start through their own Connect CTA). */
  hideStart?: boolean
  /** Extra node rendered after the cluster (e.g. an "Open console" link). */
  after?: React.ReactNode
  style?: React.CSSProperties
}

export function AgentLifecycleControls({
  running,
  onStart,
  onStop,
  onRestart,
  busy = false,
  stopDisabled = false,
  name,
  variant = 'icon',
  size = 22,
  iconSize = 11,
  hideStart = false,
  after,
  style
}: AgentLifecycleControlsProps): React.JSX.Element {
  const who = name ? ` ${name}` : ''
  // Keep clicks off the enclosing clickable row/card, then run the handler.
  const guard = (fn?: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn?.()
  }

  if (variant === 'button') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...style }}>
        {running ? (
          <Button size="sm" variant="secondary" onClick={guard(onStop)} disabled={busy || stopDisabled}>
            <Icon name="stop" size={10} /> Stop
          </Button>
        ) : (
          !hideStart && (
            <Button size="sm" variant="cta" onClick={guard(onStart)} disabled={busy}>
              <Icon name="play" size={10} color="var(--tx-onaccent)" /> Start
            </Button>
          )
        )}
        <Button size="sm" variant="ghost" onClick={guard(onRestart)} disabled={busy}>
          <Icon name="restart" size={11} /> Restart
        </Button>
        {after}
      </div>
    )
  }

  // icon variant
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0, ...style }}>
      {running ? (
        <IconButton
          label={`Stop${who}`}
          icon="stop"
          size={size}
          iconSize={iconSize}
          disabled={busy || stopDisabled}
          onClick={guard(onStop)}
        />
      ) : (
        !hideStart && (
          <IconButton
            label={`Start${who}`}
            icon="play"
            size={size}
            iconSize={iconSize}
            disabled={busy}
            onClick={guard(onStart)}
          />
        )
      )}
      <IconButton
        label={`Restart${who}`}
        icon="restart"
        size={size}
        iconSize={iconSize}
        disabled={busy}
        onClick={guard(onRestart)}
      />
      {after}
    </div>
  )
}

export default AgentLifecycleControls
