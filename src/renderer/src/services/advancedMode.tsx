import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'

/**
 * Advanced mode — one shared, app-wide flag that decides whether the UI shows the
 * calm Basic surface (default) or the full expert surface (MCP, raw logs, task
 * timeouts, bulk actions, extra fleet columns…). It persists in the same
 * plaintext app-settings file as the office URL (`advancedMode`, via
 * getSettings/setSettings), so the choice survives restarts and is identical on
 * every screen.
 *
 * The DISCLOSURE CONTRACT: nothing load-bearing is ever hidden. With Advanced OFF
 * an expert control is either absent from the calm surface OR — inside a modal —
 * collapsed under an always-present "Advanced ▸" disclosure (see <AdvancedSection>)
 * that opens in ONE click. Flipping this flag is itself one click (the top-nav
 * toggle or the Settings → General switch), so every guarded control is reachable
 * in ≤1 click.
 *
 * Mirrors the CliStatusProvider/useCliStatus shape: a context with a safe default
 * so any tree rendered outside the provider (tests, isolated stories) reads as
 * Basic instead of throwing.
 */
export interface AdvancedMode {
  /** true when expert controls should be shown / disclosures default-expanded. */
  advanced: boolean
  /** true once the persisted flag has been read (avoids a Basic→Advanced flash). */
  loaded: boolean
  /** persist + apply a new value app-wide. */
  setAdvanced: (v: boolean) => void
  /** convenience flip. */
  toggle: () => void
}

const AdvancedModeContext = createContext<AdvancedMode>({
  advanced: false,
  loaded: false,
  setAdvanced: () => {},
  toggle: () => {}
})

export function useAdvancedMode(): AdvancedMode {
  return useContext(AdvancedModeContext)
}

export function AdvancedModeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [advanced, setAdvancedState] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // Seed from the persisted preference once.
  useEffect(() => {
    let live = true
    void window.api
      .getSettings()
      .then((s) => {
        if (live) setAdvancedState(!!s?.advancedMode)
      })
      .catch(() => {
        /* missing/corrupt settings read as Basic */
      })
      .finally(() => {
        if (live) setLoaded(true)
      })
    return () => {
      live = false
    }
  }, [])

  // Optimistic local update + persist; a failed write leaves the local value (the
  // next read reconciles). No await needed — the flag is UI-only.
  const setAdvanced = useCallback((v: boolean) => {
    setAdvancedState(v)
    void window.api.setSettings({ advancedMode: v }).catch(() => {})
  }, [])

  const toggle = useCallback(() => setAdvanced(!advanced), [advanced, setAdvanced])

  return (
    <AdvancedModeContext.Provider value={{ advanced, loaded, setAdvanced, toggle }}>
      {children}
    </AdvancedModeContext.Provider>
  )
}
