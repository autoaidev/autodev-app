import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppShell, ErrorBoundary, CommandPalette, type Command } from '@renderer/ui'
import { CliStatusProvider } from '@renderer/services/cliStatus'
import { AdvancedModeProvider } from '@renderer/services/advancedMode'
import { ThemeProvider } from '@renderer/services/theme'
import { AgentsView } from '@renderer/views/AgentsView'
import { FleetView } from '@renderer/views/FleetView'
import { OfficeView } from '@renderer/views/OfficeView'
import { SessionsView } from '@renderer/views/SessionsView'
import { SettingsView2 } from '@renderer/views/SettingsView2'
import MakeAppView from './MakeAppView'
import { useFleetCounts } from '@renderer/services/agentStore'
import { AppActionsProvider, useAppActions } from '@renderer/services/appActions'
import { HelpPanel } from '@renderer/components/help/HelpPanel'
import { MAIN_NAV, SETTINGS_NAV, type NavId } from './nav'

/**
 * AutoDev redesign v2 — the app shell / router.
 *
 * Stages 1–2 built the primitives (@renderer/ui) and the eight screens
 * (views/*). This file is the seam that wires them into the running Electron
 * renderer: it owns the top-nav routing state, the shell-level chrome for the
 * content-only screens, the fleet-wide running/needs-you counts fed to the nav
 * bar, and the typed app-actions bus the screens talk through. The legacy shell is
 * preserved verbatim in _archive/App.legacy.tsx for reference (out of the compile
 * graph — see tsconfig.web.json `exclude`).
 *
 * ── Nav model ────────────────────────────────────────────────────────────────
 * Two screens (AgentsView, FleetView) render their OWN <AppShell> (they need the
 * search box + rail tied to their local state), so we render THEM directly and
 * let their embedded shell paint the nav — they call `useAppActions().navigate`
 * on a nav click and it routes to `go()` here. The remaining content-only screens
 * (Office / Sessions / Make-app / Settings) get their chrome from the <AppShell>
 * WE wrap them in, with `onNavChange` routing straight to `go()`. Both paths share
 * MAIN_NAV + SETTINGS_NAV so the nav is identical everywhere.
 *
 * ── Keep-alive terminals ─────────────────────────────────────────────────────
 * Office (Operate PTYs via TerminalTabs) and Sessions (Resume/New PTYs via
 * TerminalPane) MUST NOT be unmounted on a tab switch — unmount = SIGKILL of the
 * live child + lost scrollback. So once a view is opened it stays MOUNTED for the
 * rest of the session; switching tabs only toggles CSS `display`. `opened` never
 * shrinks; the inactive layers render with `display:none`. This applies to every
 * view uniformly, so no live PTY is ever destroyed by navigation.
 *
 * ── App-actions bus (services/appActions) ────────────────────────────────────
 * The screens talk to this shell through the typed <AppActionsProvider> we wrap
 * the whole tree in — no window CustomEvents. App supplies the single-consumer
 * handlers it owns; the provider fans the broadcast intents out to any view that
 * subscribed (kept mounted by the keep-alive layers).
 *  • navigate        → switch the top-nav tab (onNavigate = go)
 *  • newAgent        → route to the Make-app / spawn funnel (go('makeapp'))
 *  • openAgent(ref)  → bring the Agents tab forward (go('agents')); AgentsView
 *                      subscribes and resolves the office identity → workspace path
 *  • focusAttention  → bring the Agents tab forward; AgentsView subscribes and
 *                      selects the first agent that needs you
 *  • toast(msg,err)  → global toast (onToast = setToast)
 *  • stopAll         → fanned out to the mounted OfficeView, which kills its
 *                      Operate PTYs via termRegistry.stopAll (App wires no handler)
 */
export default function App(): JSX.Element {
  const [nav, setNav] = useState<NavId>('office')
  // Lazy-mount + keep-alive: a view is added on first visit and never removed, so
  // a mounted PTY survives every later tab switch (we only toggle `display`).
  const [opened, setOpened] = useState<Set<NavId>>(() => new Set<NavId>(['office']))
  // Fleet-wide counts for the shell's RunPill ("N running · M need you"), fed to
  // the AppShell we wrap the content views in. Sourced from the shared agent store
  // so every consumer sees one live tally (no per-view listAgents poll).
  const { running, needsYou } = useFleetCounts()
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)
  // Optional folder seed for the Make-app funnel — set when a caller routes to
  // "new agent" with a specific folder (e.g. Sessions' "Open as agent" on a
  // non-workspace folder). Pre-fills the target folder in MakeAppView.
  const [makeSeedFolder, setMakeSeedFolder] = useState<string | undefined>(undefined)

  const [paletteOpen, setPaletteOpen] = useState(false)
  // Shared Help & getting-started panel — opened from the AppShell "?" button and
  // the ⌘K palette (both via useAppActions().openHelp → onOpenHelp below).
  const [helpOpen, setHelpOpen] = useState(false)

  const go = useCallback((id: NavId) => {
    setNav(id)
    setOpened((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])

  // The ⌘K command surface — nav destinations + primary actions, runnable from any
  // screen. Wired through the same `go` router + Make-app funnel the nav uses.
  const commands = useMemo<Command[]>(
    () => [
      ...MAIN_NAV.map((n) => ({
        id: `go-${n.id}`,
        label: `Go to ${n.label}`,
        hint: 'Navigate',
        keywords: n.id,
        run: () => go(n.id as NavId)
      })),
      {
        id: `go-${SETTINGS_NAV.id}`,
        label: `Go to ${SETTINGS_NAV.label}`,
        hint: 'Navigate',
        keywords: 'preferences config',
        run: () => go(SETTINGS_NAV.id as NavId)
      },
      {
        // Honestly names the describe→team wizard. Adding ONE local agent is the
        // sidebar's "+ New agent" (single-agent create modal), not this funnel —
        // so this command must not be labeled the ambiguous "New agent".
        id: 'generate-team',
        label: 'Generate a team',
        hint: 'Action',
        keywords: 'spawn create make app team new agent single',
        run: () => go('makeapp')
      },
      {
        id: 'help',
        label: 'Help & getting started',
        hint: 'Help',
        keywords: 'onboarding checklist docs tutorial shortcuts keyboard guide',
        run: () => setHelpOpen(true)
      }
    ],
    [go]
  )

  // Auto-dismiss the toast (matches the legacy 4s behaviour).
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(id)
  }, [toast])

  // ⌘K / Ctrl+K opens the global command palette — a real command surface that
  // works from every screen (nav + primary actions), not just a jump to Agents.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const layer = (active: boolean): React.CSSProperties =>
    active
      ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }
      : { display: 'none' }

  // Chrome for the content-only screens. The inner flex:1 wrapper gives each view
  // a definite box to fill under the 34+46px chrome (their roots use height:100%
  // / flex:1, which resolve against it).
  //
  // No search box here: these screens (Office / Sessions / Make-app / Settings)
  // have no local list to filter, and focusing a box must never navigate. ⌘K
  // stays available as the global keyboard shortcut below.
  const contentShell = (content: React.ReactNode): JSX.Element => (
    <AppShell
      activeNav={nav}
      nav={MAIN_NAV}
      rightNav={SETTINGS_NAV}
      onNavChange={(id) => go(id as NavId)}
      running={running}
      needsYou={needsYou}
      style={{ height: '100%' }}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{content}</div>
    </AppShell>
  )

  return (
    <ThemeProvider>
    <CliStatusProvider>
    <AdvancedModeProvider>
    <AppActionsProvider
      onNavigate={go}
      onOpenAgentTab={() => go('agents')}
      onNewAgent={(seed) => {
        setMakeSeedFolder(seed?.path)
        go('makeapp')
      }}
      onToast={(msg, err) => setToast({ msg, err })}
      onFocusAttention={() => go('agents')}
      onOpenHelp={() => setHelpOpen(true)}
    >
    <OpenFolderBridge />
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--bg-0)'
      }}
    >
      {/* Each keep-alive layer gets its OWN ErrorBoundary so a render throw in one
          view shows a local fallback card while SIBLING layers stay mounted and
          their live PTYs keep running — the whole point of the keep-alive design.
          `resetKey={nav}` (a prop, NOT React `key`) clears a caught error on the
          next navigation without ever remounting a healthy view's shell. */}
      {/* Agents + Fleet bring their own AppShell (own search/rail state). */}
      {opened.has('agents') && (
        <div style={layer(nav === 'agents')}>
          <ErrorBoundary resetKey={nav} label="Agents">
            <AgentsView />
          </ErrorBoundary>
        </div>
      )}
      {opened.has('fleet') && (
        <div style={layer(nav === 'fleet')}>
          <ErrorBoundary resetKey={nav} label="Fleet">
            <FleetView visible={nav === 'fleet'} />
          </ErrorBoundary>
        </div>
      )}
      {/* Content-only screens get the shell from here; kept mounted for keep-alive. */}
      {opened.has('office') && (
        <div style={layer(nav === 'office')}>
          <ErrorBoundary resetKey={nav} label="Office">
            {contentShell(<OfficeView visible={nav === 'office'} />)}
          </ErrorBoundary>
        </div>
      )}
      {opened.has('sessions') && (
        <div style={layer(nav === 'sessions')}>
          <ErrorBoundary resetKey={nav} label="Sessions">
            {contentShell(<SessionsView active={nav === 'sessions'} />)}
          </ErrorBoundary>
        </div>
      )}
      {opened.has('makeapp') && (
        <div style={layer(nav === 'makeapp')}>
          <ErrorBoundary resetKey={nav} label="Make-app">
            {contentShell(<MakeAppView initialFolder={makeSeedFolder} />)}
          </ErrorBoundary>
        </div>
      )}
      {opened.has('settings') && (
        <div style={layer(nav === 'settings')}>
          <ErrorBoundary resetKey={nav} label="Settings">
            {contentShell(<SettingsView2 />)}
          </ErrorBoundary>
        </div>
      )}

      {toast && <Toast msg={toast.msg} err={toast.err} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
    </AppActionsProvider>
    </AdvancedModeProvider>
    </CliStatusProvider>
    </ThemeProvider>
  )
}

/**
 * Bridges the main process's `--open-folder` launches (Windows Explorer's
 * right-click "Open as AutoDev agent") into the same "open as agent" flow the
 * Sessions view uses: register the folder as an agent and reveal it, or — if it
 * isn't yet an AutoDev workspace — route to the create-agent funnel seeded with it.
 *
 * Two delivery paths (see main/index.ts): a COLD-start folder is pulled once via
 * `consumeOpenFolder()` on mount; WARM deliveries (a second launch while the app
 * runs) arrive on the `app:openFolder` broadcast. Renders nothing — it only owns
 * the subscription, and must live inside <AppActionsProvider> to reach the bus.
 */
function OpenFolderBridge(): null {
  const { openAgent, newAgent, toast } = useAppActions()
  useEffect(() => {
    const openAsAgent = async (cwd: string): Promise<void> => {
      if (!cwd) return
      try {
        const r = (await window.api.addAgent(cwd)) as { error?: string; path?: string }
        if (r && typeof r === 'object' && 'error' in r && r.error) {
          newAgent({ path: cwd })
          return
        }
        openAgent({ path: cwd })
      } catch {
        toast('Could not open that folder as an agent.', true)
      }
    }
    // Cold start: pull a folder passed before this listener existed.
    void window.api.consumeOpenFolder().then((p) => { if (p) void openAsAgent(p) })
    // Warm: a second launch relayed a folder while we were already running.
    return window.api.onOpenFolder((p) => { void openAsAgent(p) })
  }, [openAgent, newAgent, toast])
  return null
}

/** Global toast — floats above every screen; tokenised, no legacy CSS. */
function Toast({ msg, err }: { msg: string; err?: boolean }): JSX.Element {
  return (
    <div
      role="status"
      aria-live={err ? 'assertive' : 'polite'}
      style={{
        position: 'fixed',
        bottom: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: 'min(560px, 92vw)',
        background: err ? 'var(--st-error-soft)' : 'var(--bg-elev)',
        border: `1px solid ${err ? 'var(--st-error-bd)' : 'var(--bd-1)'}`,
        color: err ? 'var(--st-error-bright)' : 'var(--tx-1)',
        padding: '10px 16px',
        borderRadius: 'var(--r-card)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--fs-body)',
        boxShadow: '0 6px 24px rgba(0,0,0,.4)',
        zIndex: 1000
      }}
    >
      {msg}
    </div>
  )
}

