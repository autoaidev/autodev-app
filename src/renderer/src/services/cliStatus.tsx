import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'

/**
 * CLI status — one shared source of truth for "is the AutoDev CLI (the runner
 * that drives agents) present on this machine?". The redesign screens each render
 * their OWN <AppShell>, so a single fixed/overlay banner (the old approach) landed
 * ON TOP of whichever header sat at that y-offset. Instead we expose the state via
 * context: <AppShell> reads it and paints ONE full-width banner row in its own
 * layout slot below the nav on every screen (pushing content down), and the
 * empty-state Start CTAs read it to disable a button that would only fail.
 *
 * Note the distinction the banner spells out: the PROVIDER CLIs (grok-cli /
 * claude-tui) may be installed while the AutoDev runner that invokes them is not —
 * `missing` here refers ONLY to the AutoDev CLI (cli:check → resolveCliJs).
 */
export interface CliStatus {
  /** true when the AutoDev CLI runner is NOT resolvable (cli:check → found:false). */
  missing: boolean
  /** a recheck is in flight (drives the Recheck button's "Checking…" label). */
  checking: boolean
  /** re-run cli:check and update `missing`. */
  recheck: () => Promise<void>
}

// Safe default so any <AppShell> rendered outside the provider (tests, the legacy
// shell) simply reports "not missing" and hides the banner instead of throwing.
const CliStatusContext = createContext<CliStatus>({
  missing: false,
  checking: false,
  recheck: async () => {}
})

export function useCliStatus(): CliStatus {
  return useContext(CliStatusContext)
}

export function CliStatusProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [missing, setMissing] = useState(false)
  const [checking, setChecking] = useState(false)

  const recheck = useCallback(async () => {
    setChecking(true)
    try {
      const c = (await window.api.cliCheck()) as { found: boolean }
      setMissing(!c.found)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void recheck()
  }, [recheck])

  return <CliStatusContext.Provider value={{ missing, checking, recheck }}>{children}</CliStatusContext.Provider>
}
