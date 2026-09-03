/**
 * AutoDev redesign v2 — top-nav model, shared by App.tsx (the router) and the two
 * screens that render their OWN <AppShell> (AgentsView, FleetView). Keeping the
 * item list in one place means the primary nav is identical everywhere. Screens
 * switch tabs through the typed action bus (useAppActions().navigate) rather than
 * importing App (which would be a cycle); this module is now pure data/types.
 */
import type { NavItemDef } from '@renderer/ui'

export type NavId = 'agents' | 'fleet' | 'office' | 'sessions' | 'makeapp' | 'settings'

/** Primary top-nav items (left cluster). Order = tab order. Each carries a glyph so
 *  the bar is scannable by icon (icon inherits currentColor → flips on the active tab). */
export const MAIN_NAV: NavItemDef[] = [
  { id: 'office', label: 'Office', icon: 'office' },
  { id: 'agents', label: 'Agents', icon: 'agents' },
  { id: 'fleet', label: 'Fleet', icon: 'fleet' },
  { id: 'sessions', label: 'Sessions', icon: 'clock' },
  { id: 'makeapp', label: 'Make app', icon: 'sparkle' }
]

/** Far-right highlighted nav item (AppShell `rightNav` slot). */
export const SETTINGS_NAV: NavItemDef = { id: 'settings', label: 'Settings', icon: 'settings' }
