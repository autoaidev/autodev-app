import React from 'react'
import { SearchInput } from './SearchInput'
import { StatusDot } from './StatusDot'
import { IconButton } from './IconButton'
import { Icon, type IconName } from './Icon'
import { CliBanner } from './CliBanner'
import { useCliStatus } from '@renderer/services/cliStatus'
import { useAdvancedMode } from '@renderer/services/advancedMode'
import { useTheme, type ThemePref } from '@renderer/services/theme'
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
  /** optional leading glyph rendered beside the label so tabs are scannable by icon */
  icon?: IconName
}

const DEFAULT_NAV: NavItemDef[] = [
  { id: 'office', label: 'Office', icon: 'office' },
  { id: 'agents', label: 'Agents', icon: 'agents' },
  { id: 'fleet', label: 'Fleet', icon: 'fleet' },
  { id: 'sessions', label: 'Sessions', icon: 'clock' }
]

/**
 * PixelMark — the small pixel-art AutoDev brand glyph (a robot head) that
 * replaces the flat solid-blue square. Painted from a tiny char grid: `b` = the
 * accent blue body, `w` = the warm secondary accent (the eyes) — which is how the
 * warm accent enters the chrome so blue isn't the only color on screen. Purely
 * decorative (aria-hidden); the wordmark beside it carries the name.
 */
const PIXEL_GRID = [
  '.bbbbb.',
  'bbbbbbb',
  'bwbbbwb',
  'bbbbbbb',
  'bbbbbbb',
  '.bbbbb.',
  '..b.b..'
]
function PixelMark({ size = 18 }: { size?: number }): React.JSX.Element {
  const cols = PIXEL_GRID[0].length
  const rows = PIXEL_GRID.length
  const cell = 2
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${cols * cell} ${rows * cell}`}
      aria-hidden
      focusable={false}
      style={{ flex: 'none', shapeRendering: 'crispEdges' }}
    >
      {PIXEL_GRID.flatMap((line, y) =>
        line.split('').map((ch, x) =>
          ch === '.' ? null : (
            <rect
              key={`${x}-${y}`}
              x={x * cell}
              y={y * cell}
              width={cell}
              height={cell}
              fill={ch === 'w' ? 'var(--accent-warm)' : 'var(--accent)'}
            />
          )
        )
      )}
    </svg>
  )
}

/** A single top-nav item (also exported for standalone use). */
export function NavItem({
  label,
  icon,
  active = false,
  onClick,
  className,
  style,
  ...rest
}: {
  label: React.ReactNode
  /** optional leading glyph; inherits currentColor so it flips to onaccent when active */
  icon?: IconName
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
        // icon + label ride together; the icon inherits currentColor so it flips to
        // onaccent ink on the active tab automatically.
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '8px 12px',
        borderRadius: 'var(--r-button)',
        // Active tab is the BOLDEST thing in the bar: a SOLID accent fill (not a
        // faint tint) with onaccent ink + a soft accent glow, so the current view
        // is unmistakable at a glance. Inactive items stay transparent/ghost.
        background: active ? 'var(--accent)' : 'transparent',
        border: 'none',
        boxShadow: active ? '0 1px 4px rgba(0, 0, 0, .35), inset 0 1px 0 rgba(255, 255, 255, .18)' : 'none',
        color: active ? 'var(--tx-onaccent)' : 'var(--tx-3)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--fs-body)',
        fontWeight: active ? 700 : 400,
        cursor: 'pointer',
        ...style
      }}
      {...rest}
    >
      {icon && <Icon name={icon} size={14} />}
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

/**
 * AdvancedToggle — the small app-wide "Advanced" switch in the nav's right
 * cluster. One click flips the persisted flag that reveals every expert control
 * (MCP, raw logs, timeouts, bulk actions, extra columns). Reads/writes the shared
 * useAdvancedMode context, so it stays in sync with the Settings → General switch.
 */
export function AdvancedToggle(): React.JSX.Element {
  const { advanced, toggle } = useAdvancedMode()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={advanced}
      onClick={toggle}
      title={advanced ? 'Advanced mode on — hide expert controls' : 'Advanced mode off — show expert controls'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 9px',
        borderRadius: 'var(--r-button)',
        background: advanced ? 'var(--accent-tint)' : 'var(--bg-input)',
        border: `1px solid ${advanced ? 'var(--accent)' : 'var(--bd-field)'}`,
        cursor: 'pointer'
      }}
    >
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-desc)', fontWeight: 500, color: advanced ? 'var(--tx-hi)' : 'var(--tx-3)' }}>
        Advanced
      </span>
      <span
        aria-hidden
        style={{
          position: 'relative',
          width: 24,
          height: 14,
          flex: 'none',
          borderRadius: 'var(--r-pill)',
          background: advanced ? 'var(--accent)' : 'var(--bg-topbar)',
          border: `1px solid ${advanced ? 'var(--accent)' : 'var(--bd-1)'}`,
          transition: 'background .12s ease'
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: advanced ? 11 : 1,
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: advanced ? 'var(--tx-onaccent)' : 'var(--tx-4)',
            transition: 'left .12s ease'
          }}
        />
      </span>
    </button>
  )
}

/**
 * ThemeToggle — a compact quick control in the nav's right cluster that cycles the
 * app theme System → Light → Dark → System. Reads/writes the shared useTheme
 * context, so it stays in sync with the Settings → General → Appearance control.
 * Each mode shows a glyph (◐ system · ☀ light · ☾ dark) so the current choice is
 * legible at a glance; the active-view accent is never spent here.
 */
const THEME_ORDER: ThemePref[] = ['system', 'light', 'dark']
const THEME_META: Record<ThemePref, { glyph: string; label: string }> = {
  system: { glyph: '◐', label: 'System' },
  light: { glyph: '☀', label: 'Light' },
  dark: { glyph: '☾', label: 'Dark' }
}
export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme } = useTheme()
  const meta = THEME_META[theme]
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${meta.label}. Switch to ${THEME_META[next].label}`}
      title={`Theme: ${meta.label} — click for ${THEME_META[next].label}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 9px',
        borderRadius: 'var(--r-button)',
        background: 'var(--bg-input)',
        border: '1px solid var(--bd-field)',
        cursor: 'pointer'
      }}
    >
      <span aria-hidden style={{ fontSize: 13, lineHeight: 1, color: 'var(--tx-2)' }}>
        {meta.glyph}
      </span>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-desc)', fontWeight: 500, color: 'var(--tx-3)' }}>
        {meta.label}
      </span>
    </button>
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

/**
 * AppVersionLabel — the installed app version (e.g. "v0.3.63") shown small + muted
 * beside the Help button. Read once from the main-process `app:version` IPC
 * (window.api.appVersion). Renders nothing until the version resolves, so it never
 * flashes a placeholder.
 */
export function AppVersionLabel(): React.JSX.Element | null {
  const [ver, setVer] = React.useState('')
  React.useEffect(() => {
    let live = true
    void window.api
      .appVersion?.()
      .then((v) => {
        if (live && v) setVer(v)
      })
      .catch(() => {
        /* version unavailable — render nothing */
      })
    return () => {
      live = false
    }
  }, [])
  if (!ver) return null
  return (
    <span
      title={`AutoDev v${ver}`}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-desc)',
        fontWeight: 500,
        color: 'var(--tx-dim)',
        whiteSpace: 'nowrap'
      }}
    >
      v{ver}
    </span>
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
  // The top bar carries an identity: a subtle brand gradient + a bold 2px accent
  // bottom border (the one saturated line that anchors the chrome).
  const barBase: React.CSSProperties = {
    background: 'var(--grad-topbar)',
    borderBottom: '2px solid var(--accent)'
  }

  // The AutoDev-CLI-missing banner is painted here — in its OWN full-width row
  // between the nav and the screen content — so it reserves layout space and pushes
  // content down on EVERY screen (Agents / Sessions / Settings / …) instead of
  // floating over a header. One source of truth (context), one placement app-wide.
  const cli = useCliStatus()
  // The "N need you" tally routes through the typed app-actions bus (was a
  // 'redesign:focus-attention' window event); AgentsView subscribes to select.
  const { focusAttention, openHelp } = useAppActions()

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
          <PixelMark size={18} />
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
            icon={n.icon}
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
          {/* Theme and Advanced-mode toggles were removed from the top bar (0.3.63):
              the app is always Advanced, and the theme is changed from Settings →
              General → Appearance. */}
          {/* Global Help affordance — opens the shared Help & getting-started panel
              (checklist + shortcuts + docs) through the typed app-actions bus, so a
              first-time user always has one discoverable entry to guidance. */}
          <IconButton label="Help & getting started" icon="help" iconSize={13} onClick={openHelp} />
          {/* Installed app version — small + muted, next to Help, so the build is
              always visible at a glance without competing with the controls. */}
          <AppVersionLabel />
          {rightNav && (
            <NavItem
              label={rightNav.label}
              icon={rightNav.icon}
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
