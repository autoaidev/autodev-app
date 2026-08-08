/**
 * AutoDev redesign v2 — TYPED app-actions bus (Stage 1 services layer).
 *
 * Replaces the untyped `window` CustomEvent bus that the redesigned screens use
 * to talk to the shell without importing App (which would be an import cycle):
 *
 *   navTo(id)                      →  useAppActions().navigate(id)
 *   dispatch 'redesign:new-agent'  →  useAppActions().newAgent()
 *   dispatch 'autodev:open-agent'  →  useAppActions().openAgent(ref)
 *   dispatch 'redesign:toast'      →  useAppActions().toast(msg, err?)
 *   dispatch 'office:stop-all'     →  useAppActions().stopAll()
 *
 * Two of those intents are BROADCAST — they had more than one independent
 * `addEventListener` receiver that stays wired even while its view is hidden
 * (the keep-alive layers in App never unmount):
 *   • 'autodev:open-agent' — App switches the tab AND AgentsView resolves the
 *                            ref → workspace path and selects it.
 *   • 'office:stop-all'    — OfficeView and PixelOfficeView each close their own
 *                            live Operate PTYs.
 * So the context can't be a plain set of App callbacks: it owns a subscriber
 * registry for those two, letting any view register a resolver the same way it
 * used to `window.addEventListener(...)`. The single-consumer intents
 * (navigate / newAgent / toast) are forwarded straight to the handlers App
 * wires when it renders <AppActionsProvider>.
 *
 * ── Migration model ──────────────────────────────────────────────────────────
 * App renders <AppActionsProvider {...its existing handlers}> around the view
 * tree and passes the callbacks it already implements (go / setToast). Emitters
 * (nav.ts, AgentRail-via-AgentsView, OfficeView, FleetView) call the typed
 * methods instead of window.dispatchEvent / navTo. Broadcast receivers
 * (AgentsView, OfficeView, PixelOfficeView) swap `window.addEventListener` for
 * `subscribeOpenAgent(fn)` / `subscribeStopAll(fn)` (both return an unsubscribe
 * fn, matching the old cleanup shape). nav.ts and the window events are NOT
 * removed in this stage.
 *
 * ── Hook API (useAppActions) ─────────────────────────────────────────────────
 *   navigate(nav: NavId): void
 *       Switch the primary top-nav tab. (was navTo / 'redesign:nav')
 *   openAgent(ref: AgentRef): void
 *       Ask the app to reveal a specific agent: App brings the Agents tab
 *       forward and every openAgent subscriber gets the ref to resolve+select.
 *       (was 'autodev:open-agent'; ref = { path?, officeSlug?, agentSlug? })
 *   newAgent(): void
 *       Route to the Make-app / spawn funnel. (was 'redesign:new-agent')
 *   toast(msg: string, err?: boolean): void
 *       Show the global toast. err=true styles it as an error / assertive.
 *       (was 'redesign:toast', detail { msg, err })
 *   stopAll(): void
 *       Broadcast "kill everything": every stopAll subscriber (heavy views with
 *       live Operate PTYs) tears its PTYs down. (was 'office:stop-all')
 *   subscribeOpenAgent(fn: (ref: AgentRef) => void): () => void
 *       Register an openAgent resolver; returns an unsubscribe fn.
 *   subscribeStopAll(fn: () => void): () => void
 *       Register a stop-all handler; returns an unsubscribe fn.
 *
 * Self-contained: no other service depends on this, and it depends only on
 * React + the NavId type from nav.ts.
 */
import React, { createContext, useCallback, useContext, useMemo, useRef } from 'react'
import type { NavId } from '@renderer/nav'

// Re-export so consumers get the nav vocabulary from the actions service without
// also reaching into nav.ts (which still owns the legacy window-event emitter).
export type { NavId }

/**
 * Identifies an agent to reveal. Mirrors the old 'autodev:open-agent' detail:
 * a concrete workspace `path` wins; otherwise the office identity
 * (officeSlug + agentSlug) is resolved to a local workspace by the subscriber
 * (AgentsView), which toasts if the character only runs remotely.
 */
export interface AgentRef {
  path?: string
  officeSlug?: string
  agentSlug?: string
}

/** Typed methods exposed by useAppActions(). See file header for semantics. */
export interface AppActions {
  navigate: (nav: NavId) => void
  openAgent: (ref: AgentRef) => void
  newAgent: () => void
  toast: (msg: string, err?: boolean) => void
  stopAll: () => void
  /** Reveal the agents that need attention. App brings the Agents tab forward and
   *  every focusAttention subscriber (AgentsView) selects the first one.
   *  (was 'redesign:focus-attention') */
  focusAttention: () => void
  subscribeOpenAgent: (fn: (ref: AgentRef) => void) => () => void
  subscribeStopAll: (fn: () => void) => () => void
  subscribeFocusAttention: (fn: () => void) => () => void
}

/**
 * Handlers App wires for the single-consumer intents it owns (top-nav routing
 * state, the makeapp funnel, the global toast). All optional so the provider
 * typechecks and renders standalone (e.g. in tests) before App fills them in;
 * an unwired intent is a safe no-op.
 */
export interface AppActionsHandlers {
  /** Switch the top-nav tab (App's `go`). */
  onNavigate?: (nav: NavId) => void
  /** Bring the Agents tab forward for an openAgent (App's `go('agents')`). */
  onOpenAgentTab?: (ref: AgentRef) => void
  /** Route to the Make-app / spawn funnel (App's `go('makeapp')`). */
  onNewAgent?: () => void
  /** Show the global toast (App's `setToast`). */
  onToast?: (msg: string, err?: boolean) => void
  /** Optional app-side hook that also fires on stopAll (App needs none today). */
  onStopAll?: () => void
  /** Bring the Agents tab forward for a focusAttention (App's `go('agents')`). */
  onFocusAttention?: () => void
}

const AppActionsCtx = createContext<AppActions | null>(null)

/**
 * Wraps the view tree and provides the typed action bus. App passes the
 * callbacks it already implements; broadcast fan-out (openAgent / stopAll) is
 * owned here so any number of views can subscribe/unsubscribe independently.
 */
export function AppActionsProvider(
  props: AppActionsHandlers & { children: React.ReactNode }
): JSX.Element {
  const { onNavigate, onOpenAgentTab, onNewAgent, onToast, onStopAll, onFocusAttention, children } =
    props

  // Keep the latest handlers in a ref so the exposed methods stay referentially
  // stable (the context value never changes identity → no needless re-renders of
  // every consumer when App re-renders with fresh closures).
  const handlers = useRef<AppActionsHandlers>({})
  handlers.current = { onNavigate, onOpenAgentTab, onNewAgent, onToast, onStopAll, onFocusAttention }

  // Subscriber registries for the broadcast intents. Sets so a view can register
  // once and unregister cleanly, mirroring add/removeEventListener.
  const openAgentSubs = useRef(new Set<(ref: AgentRef) => void>())
  const stopAllSubs = useRef(new Set<() => void>())
  const focusAttentionSubs = useRef(new Set<() => void>())

  const navigate = useCallback((nav: NavId) => {
    handlers.current.onNavigate?.(nav)
  }, [])

  const openAgent = useCallback((ref: AgentRef) => {
    // App brings the Agents tab forward; subscribers (AgentsView) resolve+select.
    handlers.current.onOpenAgentTab?.(ref)
    openAgentSubs.current.forEach((fn) => fn(ref))
  }, [])

  const newAgent = useCallback(() => {
    handlers.current.onNewAgent?.()
  }, [])

  const toast = useCallback((msg: string, err?: boolean) => {
    handlers.current.onToast?.(msg, err)
  }, [])

  const stopAll = useCallback(() => {
    handlers.current.onStopAll?.()
    stopAllSubs.current.forEach((fn) => fn())
  }, [])

  const focusAttention = useCallback(() => {
    // App brings the Agents tab forward; subscribers (AgentsView) select the
    // first agent that needs attention.
    handlers.current.onFocusAttention?.()
    focusAttentionSubs.current.forEach((fn) => fn())
  }, [])

  const subscribeOpenAgent = useCallback((fn: (ref: AgentRef) => void) => {
    openAgentSubs.current.add(fn)
    return () => {
      openAgentSubs.current.delete(fn)
    }
  }, [])

  const subscribeStopAll = useCallback((fn: () => void) => {
    stopAllSubs.current.add(fn)
    return () => {
      stopAllSubs.current.delete(fn)
    }
  }, [])

  const subscribeFocusAttention = useCallback((fn: () => void) => {
    focusAttentionSubs.current.add(fn)
    return () => {
      focusAttentionSubs.current.delete(fn)
    }
  }, [])

  const value = useMemo<AppActions>(
    () => ({
      navigate,
      openAgent,
      newAgent,
      toast,
      stopAll,
      focusAttention,
      subscribeOpenAgent,
      subscribeStopAll,
      subscribeFocusAttention
    }),
    [
      navigate,
      openAgent,
      newAgent,
      toast,
      stopAll,
      focusAttention,
      subscribeOpenAgent,
      subscribeStopAll,
      subscribeFocusAttention
    ]
  )

  return <AppActionsCtx.Provider value={value}>{children}</AppActionsCtx.Provider>
}

/**
 * Access the typed app-actions bus. Throws if called outside an
 * <AppActionsProvider> so a missing wiring fails loudly at dev time rather than
 * silently dropping an intent (the old window bus would just no-op).
 */
export function useAppActions(): AppActions {
  const ctx = useContext(AppActionsCtx)
  if (!ctx) {
    throw new Error('useAppActions must be used within <AppActionsProvider>')
  }
  return ctx
}
