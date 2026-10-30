import React, { useEffect, useRef, useState } from 'react'
import { StatusPill, Chip, AgentAvatar, IconButton, Icon, ContextMenu } from '@renderer/ui'
import type { StatusVariant } from '@renderer/ui'
import { stateColor } from '@renderer/services/model'
import { providerAccent } from '@renderer/services/identity'
import { runModeLabel } from '@renderer/lib/providers'
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
  /**
   * The character is LIVE on ANOTHER machine — the backend reports it online but THIS
   * app owns no local session for it. Operating here would steal that remote session
   * (the office WS is last-wins per slug), so the card goes WATCH-ONLY: no Operate
   * button, an "On another PC" badge, and a Watch affordance (focus → read-only
   * stream). Ignored while this app runs a local session (`running`). */
  liveElsewhere?: boolean
  /** Stop this app's Operate session for the character (kills its PTY). */
  onStop?: () => void
  /** Restart it — stop the live Operate session, then connect & operate again. */
  onRestart?: () => void
  /** Open the SETTINGS editor for this character (provider / model / name). */
  onSettings?: () => void
  /** Open the RENAME dialog for this character. Absent → the action is hidden from
   *  the ⋯ "More actions" menu. */
  onRename?: () => void
  /** Open the DELETE confirm dialog for this character. Absent → the action is
   *  hidden from the ⋯ "More actions" menu. */
  onDelete?: () => void
  /** Reveal the character's working folder (its office loop/operate cwd) in the OS
   *  file manager. Absent → the folder button is hidden. */
  onOpenFolder?: () => void
  /** Open the per-character EVENTS modal (the enriched EventsPanel scoped to this
   *  agent, with search + paging). Absent → the events button is hidden. */
  onOpenEvents?: () => void
  /**
   * This character's LATEST office event as a short muted one-liner (item 6) —
   * reuses the same hook-event feed the Events panel reads. Truncated hard so it
   * never grows the card. Empty/undefined → nothing is shown. */
  latestEvent?: string
  /**
   * The character's loop is PAUSED for re-authentication (local AgentState
   * `activity === 'needs-auth'`). Drives a provider-aware "sign in" affordance —
   * for grok, a 🔑 hint that opens the interactive sign-in action. */
  needsAuth?: boolean
  /** The provider that raised the needs-auth (grok-cli / grok-tui / claude…) — the
   *  sign-in hint is grok-specific; other providers keep the generic attention line. */
  authProvider?: string
  /** Invoke the provider-aware sign-in action (grok → open the sign-in modal). */
  onSignIn?: () => void
  /** The character's effective model as a friendly label (e.g. "Grok 4"), shown as a
   *  muted line so a set (or bulk-set) model is confirmable at a glance. Empty = hidden. */
  modelLabel?: string
  /** When true, show a bulk-selection checkbox (independent of the focus `selected`). */
  selectable?: boolean
  /** Whether this card is in the bulk selection. */
  checked?: boolean
  /** Toggle the bulk selection for this character. */
  onToggleSelect?: () => void
  /**
   * The character is actively WORKING right now — the merged verdict from
   * `characterWorking()` (immediate local hooks signal winning over the laggy
   * office-presence poll). Drives the prominent animated "Working…" indicator so a
   * task picked up from pixel-office is unmistakable and immediate, instead of the
   * subtle grey subtitle + breathing dot. Undefined/false → the calm idle line. */
  working?: boolean
  /**
   * A short "what it's doing" line (last office narration / current task) shown as
   * the activity subtitle WHILE working. Falls back to "Working…" + elapsed when
   * absent — never fabricated. */
  activityText?: string
  /** When this character started working (epoch ms), for the "Working… · 12s"
   *  elapsed readout when no narration text is available. */
  workingSince?: number
  /**
   * Epoch ms of the character's last witnessed activity transition (from the app's
   * live activity stream — NOT a new data path). When the card is idle this drives a
   * dim "idle · 4m ago" suffix. Absent → just "idle" (never a fabricated time). */
  lastActivity?: number
}

/** A dim "just now / N m ago / N h ago / N d ago" relative label from an epoch-ms
 *  timestamp. Empty string when unknown, so callers render nothing (no "NaN ago"). */
function agoLabel(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return ''
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** A single "N s / N m / N h" elapsed readout from an epoch-ms start. */
function elapsedSince(since?: number): string {
  if (!since) return ''
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function CharacterCard({
  agent,
  selected,
  busy,
  onSelect,
  onOperate,
  running,
  liveElsewhere = false,
  onStop,
  onRestart,
  onSettings,
  onRename,
  onDelete,
  onOpenFolder,
  onOpenEvents,
  latestEvent,
  needsAuth = false,
  authProvider,
  onSignIn,
  modelLabel,
  selectable,
  checked,
  onToggleSelect,
  working = false,
  activityText,
  workingSince,
  lastActivity
}: CharacterCardProps): React.JSX.Element {
  const connected = agent.online
  // Live on ANOTHER PC (online, but this app owns no local session) → watch-only.
  // A local Operate session (`running`) always wins — it's ours to control.
  const elsewhere = liveElsewhere && !running
  // A grok character whose loop paused for re-auth gets a provider-aware "sign in"
  // affordance; other providers keep the generic needs-you attention line.
  const isGrok = /grok/i.test(authProvider || agent.provider || '')
  const showSignIn = needsAuth && isGrok && !!onSignIn
  // Basic softens the CTA to a plain "Connect" and hides the online "Open console"
  // (operating a live terminal is an Advanced action). Advanced keeps both.
  const { advanced } = useAdvancedMode()
  const accent = providerAccent(agent.provider)
  const tick = tickFor(agent)
  // Live status as a tint-pair StatusPill: offline → neutral OFFLINE, waiting on you
  // → warn NEEDS YOU, live → good LIVE. One consistent status language app-wide.
  // Pill reinforces the state in the app's existing status language: a WORKING
  // character reads WORKING (not the ambiguous LIVE), waiting → NEEDS YOU, online
  // but quiet → LIVE, offline → OFFLINE. Same 'good' tint for LIVE/WORKING so the
  // animated subtitle below — not a new colour — carries the "actively doing" cue.
  // A re-auth pause is a "needs you" state even when the office presence heuristic
  // (tickFor) hasn't caught it — surface it as the same amber NEEDS YOU.
  const needsYou = tick === 'needs-you' || needsAuth
  const status: { variant: StatusVariant; label: string } = !connected
    ? { variant: 'neutral', label: 'OFFLINE' }
    : needsYou
      ? { variant: 'warn', label: needsAuth ? 'SIGN IN' : 'NEEDS YOU' }
      : working
        ? { variant: 'good', label: 'WORKING' }
        : { variant: 'good', label: 'LIVE' }
  // The working activity line: a real narration if we have one, else "Working…"
  // plus elapsed-since-started — never a fabricated task. Truncated to one line by
  // the container's ellipsis.
  const elapsed = elapsedSince(workingSince)
  const workLine = (activityText && activityText.trim()) || (elapsed ? `Working… · ${elapsed}` : 'Working…')
  // subtitle when NOT working: amber attention line, else the raw status, else a
  // calm idle hint (no more speculative "working…" for a quiet online character).
  const subtitle = !connected
    ? 'not connected'
    : needsAuth
      ? 'sign in to grok to resume'
      : tick === 'needs-you'
        ? (agent.status || 'asked you a question')
        : (agent.status || 'idle')

  // Dim "idle · 4m ago" suffix: only when genuinely idle (online, not waiting-on-you,
  // not working) with the default idle label AND a known last-activity time. A light
  // 30s tick keeps the relative time fresh as it ages; it's armed ONLY while shown, so
  // resting cards don't each hold a live timer.
  const showAgo = connected && !needsYou && !working && subtitle === 'idle' && !!lastActivity
  const [, setAgoTick] = useState(0)
  useEffect(() => {
    if (!showAgo) return
    const id = setInterval(() => setAgoTick((t) => t + 1), 30000)
    return () => clearInterval(id)
  }, [showAgo])
  const idleAgo = showAgo ? agoLabel(lastActivity) : ''

  // ── ⋯ "More actions" menu (Rename / Delete) ──────────────────────────────
  // Shown whenever at least one management action is wired (the office is one the
  // user owns/operates — the app only ever lists owned offices, and the backend
  // DELETE/PATCH routes are owner-scoped). Anchored with fixed coords off the
  // button rect so it floats over the (overflow:auto) grid instead of being
  // clipped. Escape closes and focus lands on the first item on open.
  const showMore = !!(onRename || onDelete)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)
  const menuWrapRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menuPos) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); setMenuPos(null) }
    }
    window.addEventListener('keydown', onKey, true)
    const t = setTimeout(() => {
      menuWrapRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    }, 0)
    return () => { window.removeEventListener('keydown', onKey, true); clearTimeout(t) }
  }, [menuPos])

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
      {/* HEADER — split into TWO rows so the action icons can't squeeze the name
          off the card (F3): ROW 1 is identity (checkbox · avatar · name — the name
          owns the whole row and truncates cleanly only when genuinely too long);
          ROW 2 is the action controls (events · folder · settings · ⋯). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
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
        </div>
        {/* ROW 2 — action controls on their own row so ROW 1's name is never clipped. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
        {onOpenEvents && (
          <IconButton
            label={`Events for ${agent.name}`}
            icon="bolt"
            size={22}
            iconSize={12}
            onClick={(e) => {
              e.stopPropagation()
              onOpenEvents()
            }}
          />
        )}
        {onOpenFolder && (
          <IconButton
            label="Open folder"
            icon="folder"
            size={22}
            iconSize={12}
            onClick={(e) => {
              e.stopPropagation()
              onOpenFolder()
            }}
          />
        )}
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
        {showMore && (
          <IconButton
            label={`More actions for ${agent.name}`}
            icon="more"
            size={22}
            iconSize={12}
            active={!!menuPos}
            onClick={(e) => {
              e.stopPropagation()
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setMenuPos((p) => (p ? null : { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) }))
            }}
          />
        )}
        </div>
      </div>

      {/* ⋯ menu — Rename / Delete. Floating (fixed) so it isn't clipped by the
          grid's overflow; clicks/keys are kept from bubbling to the card's
          select handler. */}
      {showMore && menuPos && (
        <div ref={menuWrapRef} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <ContextMenu
            onClose={() => setMenuPos(null)}
            style={{ position: 'fixed', top: menuPos.top, right: menuPos.right, minWidth: 180 }}
            items={[
              ...(onRename ? [{ label: 'Rename', icon: 'editor' as const, onClick: () => onRename() }] : []),
              ...(onDelete ? [{ label: 'Delete', icon: 'trash' as const, danger: true, onClick: () => onDelete() }] : [])
            ]}
          />
        </div>
      )}

      {/* META ROW — provider Chip (left, brand hue, flex:none so it never clips) ·
          model label (takes the slack, ellipsis) · StatusPill (right, flex:none).
          The two pills are pinned to opposite ends with the model between them, so
          they can never overlap regardless of card width. */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, rowGap: 5, minWidth: 0 }}>
        {agent.provider && (() => {
          // WHICH DRIVER: show the EXACT provider id + its run mode (e.g.
          // "grok-acp · ACP loop" vs "grok-tui · TUI") so the real engine behind a
          // character is visible at a glance — the family badge alone said "Grok"
          // for both, hiding whether the persistent ACP loop or the interactive TUI
          // is actually running. A bare family id (no variant suffix) keeps the plain
          // brand label. Stays one compact, provider-tinted pill.
          const mode = runModeLabel(agent.provider)
          const exact = agent.provider.toLowerCase()
          return (
            <Chip
              variant="provider"
              provider={agent.provider}
              title={mode ? `Driver: ${exact} · ${mode}` : `Provider: ${providerLabel(agent.provider)}`}
              style={{ flex: '0 0 auto', maxWidth: '100%' }}
            >
              {mode ? exact : providerLabel(agent.provider)}
              {mode && <span style={{ opacity: 0.7, fontWeight: 500 }}> · {mode}</span>}
            </Chip>
          )
        })()}
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
          // Breathe ONLY while actively WORKING — an idle/online character shows a
          // solid, STATIC dot (no perpetual "loading" animation on a resting card).
          live={working}
          style={{ marginLeft: 'auto', flex: '0 0 auto' }}
        />
      </div>

      {/* ACTIVITY LINE. When WORKING, an unmistakable animated indicator: three
          typing-style dots (the shared .ad-thinking motion, auto-stilled under
          prefers-reduced-motion) + a clear "Working…" / narration line in running
          green — visually distinct from the calm grey idle line, and never just a
          recolor. When not working, the calm status line (idle / needs-you / raw
          office status). Offline shows only "not connected" (Basic drops it). */}
      {working ? (
        <div
          title={workLine}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 'var(--fs-desc)',
            color: stateColor('working'),
            fontWeight: 600,
            minWidth: 0
          }}
        >
          {/* three staggered dots — the "typing"/thinking indicator (reduced-motion
              falls back to static dimmed dots, still clearly present). */}
          <span className="ad-thinking" aria-hidden="true" style={{ flex: 'none', color: stateColor('working') }}>
            <i /><i /><i />
          </span>
          <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {workLine}
          </span>
          {/* screen-reader-only truth (the dots are aria-hidden). */}
          <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            working
          </span>
        </div>
      ) : (
        (connected || advanced) && (
          <div
            style={{
              fontSize: 'var(--fs-desc)',
              // Waiting-on-you → amber; online-but-quiet → calm grey (idle); offline
              // → dim. A quiet online character no longer borrows the working green.
              color: !connected
                ? 'var(--tx-4)'
                : needsYou
                  ? stateColor('needs-auth')
                  : 'var(--tx-4)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {subtitle}
            {idleAgo && (
              // Dimmer + smaller than the idle label, so it reads as a quiet timestamp.
              <span style={{ color: 'var(--tx-ghost)', fontSize: 'var(--fs-tiny)' }}> · {idleAgo}</span>
            )}
          </div>
        )
      )}

      {/* GROK SIGN-IN hint (item 2) — a provider-aware 🔑 affordance for a grok
          character whose loop paused for re-auth. Opens the interactive sign-in
          action (device-code login / XAI_API_KEY). Non-grok providers keep the
          generic NEEDS YOU line above. */}
      {showSignIn && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onSignIn?.() }}
          aria-label={`Sign in to grok for ${agent.name}`}
          style={{
            alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '2px 8px', borderRadius: 'var(--r-pill)',
            background: 'var(--st-warn-tint)', border: '1px solid var(--st-warn-ink)',
            color: 'var(--st-warn-ink)', fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-tiny)', fontWeight: 700, cursor: 'pointer'
          }}
        >
          <span aria-hidden="true">🔑</span> grok — sign in
        </button>
      )}

      {/* LATEST EVENT (item 6) — this character's most-recent office event as a hard-
          truncated, dim one-liner. Reuses the Events-panel feed. Shown ONLY while the
          agent is actively WORKING (0.3.80): when idle it was stale noise competing
          with the calm "idle · Nm ago" line, so it's hidden unless work is live. */}
      {working && latestEvent && latestEvent.trim() && (
        <div
          title={latestEvent}
          style={{
            fontSize: 'var(--fs-tiny)', color: 'var(--tx-ghost)', fontFamily: 'var(--font-mono)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0
          }}
        >
          {latestEvent}
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
      ) : elsewhere ? (
        // Watch-only: this character is live on another machine. NO Operate (it would
        // steal the remote session) — an "On another PC" badge + a Watch affordance
        // that focuses the card so its read-only office stream shows below.
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            title="This character is running on another machine — watch-only here"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '2px 8px', borderRadius: 'var(--r-pill)',
              background: 'var(--bg-input)', border: '1px solid var(--bd-1)',
              color: 'var(--tx-4)', fontSize: 'var(--fs-tiny)', fontWeight: 600
            }}
          >
            <Icon name="external" size={10} /> On another PC
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onSelect() }}
            aria-label={`Watch ${agent.name} (read-only)`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0,
              background: 'transparent', border: 'none', color: 'var(--accent)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-desc)', fontWeight: 600, cursor: 'pointer'
            }}
          >
            <Icon name="clock" size={11} /> Watch
          </button>
        </div>
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
