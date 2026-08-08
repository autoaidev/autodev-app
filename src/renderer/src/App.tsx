import { useCallback, useEffect, useState } from 'react'
import { AppShell, ErrorBoundary } from '@renderer/ui'
import { AgentsView } from '@renderer/views/AgentsView'
import { FleetView } from '@renderer/views/FleetView'
import { OfficeView } from '@renderer/views/OfficeView'
import { SessionsView } from '@renderer/views/SessionsView'
import { SettingsView2 } from '@renderer/views/SettingsView2'
import MakeAppView from './MakeAppView'
import { ATTENTION_STATES, type AgentState } from '@renderer/components/agent/AgentRow'
import { MAIN_NAV, SETTINGS_NAV, type NavId } from './nav'

// One vocabulary for "link this local agent to an office character", re-exported
// so the legacy SessionsBrowser (still in the compile graph) keeps resolving it.
export const CONNECT_LABEL = 'Connect to office'

/**
 * AutoDev redesign v2 — the app shell / router.
 *
 * Stages 1–2 built the primitives (@renderer/ui) and the eight screens
 * (views/*). This file is the seam that wires them into the running Electron
 * renderer: it owns the top-nav routing state, the shell-level chrome for the
 * content-only screens, the fleet-wide running/needs-you counts fed to the nav
 * bar, and the soft-hook CustomEvents the screens dispatch. The legacy shell is
 * preserved verbatim in App.legacy.tsx for reference.
 *
 * ── Nav model ────────────────────────────────────────────────────────────────
 * Two screens (AgentsView, FleetView) render their OWN <AppShell> (they need the
 * search box + rail tied to their local state), so we render THEM directly and
 * let their embedded shell paint the nav — they broadcast `redesign:nav` on a
 * nav click (via nav.ts → navTo) and we pick it up here. The remaining
 * content-only screens (Office / Sessions / Make-app / Settings) get their
 * chrome from the <AppShell> WE wrap them in, with `onNavChange` routing straight
 * to `go()`. Both paths share MAIN_NAV + SETTINGS_NAV so the nav is identical
 * everywhere.
 *
 * ── Keep-alive terminals ─────────────────────────────────────────────────────
 * Office (Operate PTYs via TerminalTabs) and Sessions (Resume/New PTYs via
 * TerminalPane) MUST NOT be unmounted on a tab switch — unmount = SIGKILL of the
 * live child + lost scrollback. So once a view is opened it stays MOUNTED for the
 * rest of the session; switching tabs only toggles CSS `display`. `opened` never
 * shrinks; the inactive layers render with `display:none`. This applies to every
 * view uniformly, so no live PTY is ever destroyed by navigation.
 *
 * ── Soft-hook events ─────────────────────────────────────────────────────────
 *  • 'redesign:nav'         → switch the top-nav tab (detail = nav id)
 *  • 'redesign:new-agent'   → route to the Make-app / spawn funnel
 *  • 'autodev:open-agent'   → switch to Agents; AgentsView owns the selection and
 *                             resolves the office identity → workspace path itself
 *  • 'office:stop-all'      → emitted by FleetView's Stop-all, received by the
 *                             mounted OfficeView to kill its Operate PTYs. Kept
 *                             working purely by keeping OfficeView mounted; no
 *                             App-level action is needed (documented, not dropped).
 *  • 'redesign:toast'       → global toast (detail = { msg, err? })
 */
export default function App(): JSX.Element {
  const [nav, setNav] = useState<NavId>('agents')
  // Lazy-mount + keep-alive: a view is added on first visit and never removed, so
  // a mounted PTY survives every later tab switch (we only toggle `display`).
  const [opened, setOpened] = useState<Set<NavId>>(() => new Set<NavId>(['agents']))
  const [running, setRunning] = useState(0)
  const [needsYou, setNeedsYou] = useState(0)
  const [cliMissing, setCliMissing] = useState(false)
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)

  const go = useCallback((id: NavId) => {
    setNav(id)
    setOpened((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])

  // Soft-hook receivers. All three are dispatched by the screens (see nav.ts /
  // OfficeView / AgentRail). Selection of a specific agent is AgentsView's job —
  // it listens for 'autodev:open-agent' itself and stays mounted, so we only need
  // to bring the Agents tab forward here.
  useEffect(() => {
    const onNav = (e: Event): void => {
      const id = (e as CustomEvent).detail as NavId
      if (id) go(id)
    }
    const onNewAgent = (): void => go('makeapp')
    const onOpenAgent = (): void => go('agents')
    const onToast = (e: Event): void => {
      const d = (e as CustomEvent).detail as { msg: string; err?: boolean }
      if (d?.msg) setToast(d)
    }
    window.addEventListener('redesign:nav', onNav)
    window.addEventListener('redesign:new-agent', onNewAgent)
    window.addEventListener('autodev:open-agent', onOpenAgent)
    window.addEventListener('redesign:toast', onToast)
    return () => {
      window.removeEventListener('redesign:nav', onNav)
      window.removeEventListener('redesign:new-agent', onNewAgent)
      window.removeEventListener('autodev:open-agent', onOpenAgent)
      window.removeEventListener('redesign:toast', onToast)
    }
  }, [go])

  // Auto-dismiss the toast (matches the legacy 4s behaviour).
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(id)
  }, [toast])

  // The counts (running/needsYou) feed ONLY the shell we wrap the content-only
  // screens in — Agents/Fleet compute their own counts inside their embedded
  // shells. So this poll is worthless whenever a self-counting screen is foremost;
  // gate it to the content views to avoid a permanent 3rd concurrent listAgents
  // poll. When a content view comes forward we re-seed immediately so its RunPill
  // is correct on arrival.
  const contentActive =
    nav === 'office' || nav === 'sessions' || nav === 'makeapp' || nav === 'settings'

  // Fleet-wide counts for the shell's RunPill ("N running · M need you"), fed to
  // the AppShell we wrap the content views in. Seeded on entry, then kept live off
  // the same watch/poll signals the screens use.
  useEffect(() => {
    if (!contentActive) return
    let alive = true
    const load = (): void => {
      window.api.listAgents().then((list: AgentState[]) => {
        if (!alive) return
        setRunning(list.filter((a) => a.running).length)
        setNeedsYou(list.filter((a) => ATTENTION_STATES.has(a.activity)).length)
      })
    }
    load()
    const offChanged = window.api.onAgentsChanged(load)
    const offUpdated = window.api.onAgentUpdated(load)
    const poll = window.setInterval(load, 5000)
    return () => {
      alive = false
      offChanged()
      offUpdated()
      window.clearInterval(poll)
    }
  }, [contentActive])

  const recheckCli = useCallback(async () => {
    const c = (await window.api.cliCheck()) as { found: boolean }
    setCliMissing(!c.found)
  }, [])
  useEffect(() => {
    void recheckCli()
  }, [recheckCli])

  // ⌘K / Ctrl+K jumps to the searchable Agents screen — the shell-level command
  // affordance. This is a keyboard shortcut only; focusing a search box never navigates.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        go('agents')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])

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
            <FleetView />
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
            {contentShell(<MakeAppView />)}
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

      {cliMissing && <CliBanner onRecheck={recheckCli} />}
      {toast && <Toast msg={toast.msg} err={toast.err} />}
    </div>
  )
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

/**
 * App-level gate carried over from the legacy shell: without the `autodev` CLI on
 * PATH no agent can run, and the redesigned screens don't surface that on their
 * own. A non-intrusive floating strip (never displaces the 100vh screens) with a
 * recheck, so a missing CLI is visible instead of silently failing.
 */
function CliBanner({ onRecheck }: { onRecheck: () => Promise<void> }): JSX.Element {
  const [checking, setChecking] = useState(false)
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        // Sit BELOW the 34px title bar + 46px nav so the strip never covers the
        // window title or the nav brand; a small gap keeps it visually detached.
        top: 88,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        maxWidth: '92vw',
        background: 'var(--st-error-soft)',
        border: '1px solid var(--st-error-bd)',
        color: 'var(--st-error-bright)',
        padding: '7px 14px',
        borderRadius: 'var(--r-card)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--fs-desc)',
        boxShadow: '0 6px 24px rgba(0,0,0,.4)',
        zIndex: 1000
      }}
    >
      <span>
        The <code>autodev</code> CLI isn&rsquo;t installed &mdash; agents can&rsquo;t run until it is.
      </span>
      <button
        onClick={async () => {
          setChecking(true)
          await onRecheck()
          setChecking(false)
        }}
        style={{
          background: 'var(--bg-input)',
          border: '1px solid var(--bd-1)',
          color: 'var(--tx-1)',
          borderRadius: 'var(--r-button)',
          padding: '4px 10px',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--fs-desc)',
          cursor: 'pointer'
        }}
      >
        {checking ? 'Checking…' : 'Recheck'}
      </button>
    </div>
  )
}
