/**
 * AutoDev redesign v2 — top-nav model, shared by App.tsx (the router) and the two
 * screens that render their OWN <AppShell> (AgentsView, FleetView). Keeping the
 * item list in one place means the primary nav is identical everywhere, and the
 * screens can broadcast a nav intent without importing App (which would be a
 * cycle). App owns the receiving handler for `redesign:nav`.
 */
import type { NavItemDef } from '@renderer/ui'

export type NavId = 'agents' | 'fleet' | 'office' | 'sessions' | 'makeapp' | 'settings'

/** Primary top-nav items (left cluster). Order = tab order. */
export const MAIN_NAV: NavItemDef[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'fleet', label: 'Fleet' },
  { id: 'office', label: 'Office' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'makeapp', label: 'Make app' }
]

/** Far-right highlighted nav item (AppShell `rightNav` slot). */
export const SETTINGS_NAV: NavItemDef = { id: 'settings', label: 'Settings' }

/** Broadcast a top-nav switch. App listens for this and updates the router.
 *  Accepts a plain string (AppShell hands back the raw nav id). */
export const navTo = (id: NavId | string): void => {
  window.dispatchEvent(new CustomEvent('redesign:nav', { detail: id }))
}
