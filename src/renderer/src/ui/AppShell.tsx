import React from 'react'
import { SearchInput } from './SearchInput'
import { StatusDot } from './StatusDot'
import { CliBanner } from './CliBanner'
import { useCliStatus } from '@renderer/services/cliStatus'
import { useAppActions } from '@renderer/services/appActions'

/**
 * AppShell — the window chrome shared by every full screen: the 34px title-bar
 * strip, then the 46px nav bar (AutoDev brand square + wordmark, the primary
 * nav items, the ⌘K search, and the "12 running · 2 need you" status cluster).
 * Screen content renders as `children` below the chrome.
 *
 * The right cluster is assembled from convenience props (search / running+
 * needsYou / connectionLabel) plus a free `right` slot; `rightNav` renders a
 * far-right highlighted nav item (used for Settings in 2h).
 */

export interface NavItemDef {
  id: string
  label: string
}

const DEFAULT_NAV: NavItemDef[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'fleet', label: 'Fleet' },
  { id: 'office', label: 'Office' },
  { id: 'sessions', label: 'Sessions' }
]

/** A single top-nav item (also exported for standalone use). */
export function NavItem({
  label,
  active = false,
  onClick,
  className,
  style,
  ...rest
}: {
  label: React.ReactNode
  active?: boolean
  onClick?: () => void
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={className}
      style={{
        padding: '6px 12px',
        borderRadius: 'var(--r-button)',
        background: active ? 'var(--bg-selected)' : 'transparent',
        border: 'none',
        color: active ? 'var(--tx-hi)' : 'var(--tx-3)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--fs-body)',
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        ...style
      }}
      {...rest}
    >
      {label}
    </button>
  )
}

/** The running/needs-you status cluster in the nav bar. */
export function RunPill({
  running,
  needsYou,
  onNeedsYouClick,
  className,
  style,
  ...rest
}: {
  running: number
  needsYou?: number
  /** Invoked when the "N need you" tally is clicked (AppShell wires this to
   *  useAppActions().focusAttention). Presentational otherwise — no app context. */
  onNeedsYouClick?: () => void
} & React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  // Status truth: never a green dot beside a zero. At 0 running the pill goes grey
  // + reads "idle"; only once agents are actually working does it turn green.
  const active = running > 0
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 10px',
        borderRadius: 'var(--r-button)',
        background: 'var(--bg-input)',
        border: '1px solid var(--bd-field)',
        ...style
      }}
      {...rest}
    >
      <StatusDot status={active ? 'running' : 'idle'} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-desc)', fontWeight: 500, color: active ? 'var(--tx-2)' : 'var(--tx-dim)' }}>
        {active ? `${running} running` : 'idle'}
      </span>
      {needsYou != null && needsYou > 0 && (
        <>
          <span style={{ color: 'var(--st-idle)' }}>·</span>
          {/* Clickable (R5): jump to the first agent that needs attention so the
              tally isn't a dead-end. AppShell wires onNeedsYouClick to
              useAppActions().focusAttention; AgentsView subscribes and selects it. */}
          <button
            type="button"
            onClick={onNeedsYouClick}
            title="Show the agents that need you"
            style={{
              all: 'unset',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-desc)',
              fontWeight: 500,
              color: 'var(--st-needsyou)'
            }}
          >
            {needsYou} need you
          </button>
        </>
      )}
    </div>
  )
}

/** A connection status pill (green dot + mono host), used by the Office screen. */
export function ConnectionPill({
  label,
  connected = true,
  className,
  style,
  ...rest
}: {
  label: string
  connected?: boolean
} & React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 10px',
        borderRadius: 'var(--r-button)',
        background: 'var(--bg-input)',
        border: '1px solid var(--bd-field)',
        ...style
      }}
      {...rest}
    >
      <StatusDot status={connected ? 'running' : 'idle'} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-desc)', fontWeight: 500, color: 'var(--tx-2)' }}>
        {label}
      </span>
    </div>
  )
}

export interface AppShellProps {
  /** id of the active nav item */
  activeNav: string
  onNavChange?: (id: string) => void
  /** nav items (defaults to Agents / Fleet / Office / Sessions) */
  nav?: NavItemDef[]
  /**
   * Render the search box in the right cluster. It is a controllable filter —
   * pass `searchValue` + `onSearchChange` to wire it to a screen's own list.
   * Focusing it NEVER navigates (screens with their own rail filter should not
   * pass a box at all). The ⌘K affordance is a global keyboard shortcut owned by
   * the router, surfaced here only as the `kbd` hint badge.
   */
  search?: boolean
  searchValue?: string
  onSearchChange?: (v: string) => void
  searchPlaceholder?: string
  /** render the running/needs-you cluster */
  running?: number
  needsYou?: number
  /** render a connection pill (Office screen) */
  connectionLabel?: string
  /** free-form trailing content in the right cluster (e.g. a settings icon) */
  right?: React.ReactNode
  /** far-right highlighted nav item (Settings slot in 2h) */
  rightNav?: NavItemDef
  className?: string
  style?: React.CSSProperties
  children?: React.ReactNode
}

export function AppShell({
  activeNav,
  onNavChange,
  nav = DEFAULT_NAV,
  search = false,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  running,
  needsYou,
  connectionLabel,
  right,
  rightNav,
  className,
  style,
  children
}: AppShellProps): React.JSX.Element {
  const barBase: React.CSSProperties = {
    background: 'var(--bg-topbar)',
    borderBottom: '1px solid var(--bd-nav)'
  }

  // The AutoDev-CLI-missing banner is painted here — in its OWN full-width row
  // between the nav and the screen content — so it reserves layout space and pushes
  // content down on EVERY screen (Agents / Sessions / Settings / …) instead of
  // floating over a header. One source of truth (context), one placement app-wide.
  const cli = useCliStatus()
  // The "N need you" tally routes through the typed app-actions bus (was a
  // 'redesign:focus-attention' window event); AgentsView subscribes to select.
  const { focusAttention } = useAppActions()

  return (
    <div
      className={className}
      style={{ display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-0)', ...style }}
    >
      {/* The OS window frame already renders the "AutoDev" title, so the app no
          longer paints a second 34px title strip here (was a duplicate wordmark
          stacked on every screen). The nav bar below carries the brand mark. */}

      {/* nav bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 'var(--h-navbar)',
          padding: '0 14px',
          ...barBase
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 16 }}>
          <div
            style={{
              width: 'var(--sz-brand-square)',
              height: 'var(--sz-brand-square)',
              borderRadius: 'var(--r-tiny)',
              background: 'var(--accent)'
            }}
          />
          <div
            style={{
              fontSize: 'var(--fs-brand)',
              fontWeight: 700,
              color: 'var(--tx-hi)',
              letterSpacing: 'var(--ls-tight)'
            }}
          >
            AutoDev
          </div>
        </div>

        {nav.map((n) => (
          <NavItem
            key={n.id}
            label={n.label}
            active={n.id === activeNav}
            onClick={() => onNavChange?.(n.id)}
          />
        ))}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {search && (
            <SearchInput
              kbd="⌘K"
              value={searchValue}
              onChange={(e) => onSearchChange?.(e.target.value)}
              placeholder={searchPlaceholder}
            />
          )}
          {running != null && (
            <RunPill running={running} needsYou={needsYou} onNeedsYouClick={focusAttention} />
          )}
          {connectionLabel && <ConnectionPill label={connectionLabel} />}
          {right}
          {rightNav && (
            <NavItem
              label={rightNav.label}
              active={rightNav.id === activeNav}
              onClick={() => onNavChange?.(rightNav.id)}
            />
          )}
        </div>
      </div>

      {/* Full-width CLI-missing row — reserves its own space below the nav (never an
          overlay). Renders null when the CLI is present, collapsing to zero height. */}
      <CliBanner missing={cli.missing} checking={cli.checking} onRecheck={cli.recheck} />

      {children}
    </div>
  )
}

export default AppShell
