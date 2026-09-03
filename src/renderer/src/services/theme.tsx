import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'

/**
 * Theme — the app-wide light/dark selection. Mirrors the AdvancedModeProvider:
 * one shared context, seeded from the persisted `theme` preference (same
 * plaintext app-settings file as advancedMode / officeBaseUrl, via
 * getSettings/setSettings), so the choice survives restarts and is identical on
 * every screen.
 *
 * The stored PREFERENCE is one of 'system' | 'dark' | 'light' (default 'system').
 * The RESOLVED theme ('dark' | 'light') is what's actually applied — 'system'
 * resolves via `prefers-color-scheme` and live-updates when the OS flips.
 *
 * Applying = stamping `data-theme` on <html> (document.documentElement). Every
 * color the UI renders is a token in ui/theme.css, and that file's
 * `:root[data-theme=light]` block overrides the whole surface — so this single
 * attribute flips the entire app. (No attribute / data-theme=dark = the dark
 * default.)
 */
export type ThemePref = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'

export interface ThemeState {
  /** the persisted preference: system | dark | light */
  theme: ThemePref
  /** the theme actually applied right now (system → resolved via prefers-color-scheme) */
  resolved: ResolvedTheme
  /** true once the persisted preference has been read (avoids a flash of the wrong theme) */
  loaded: boolean
  /** persist + apply a new preference app-wide */
  setTheme: (t: ThemePref) => void
}

const media = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null

/** Resolve a preference to the concrete theme, consulting the OS for 'system'. */
function resolve(pref: ThemePref): ResolvedTheme {
  if (pref === 'light') return 'light'
  if (pref === 'dark') return 'dark'
  return media()?.matches ? 'light' : 'dark'
}

/** Stamp the resolved theme on <html> so the token overrides in theme.css apply. */
function apply(resolved: ResolvedTheme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', resolved)
  }
}

const ThemeContext = createContext<ThemeState>({
  theme: 'system',
  resolved: 'dark',
  loaded: false,
  setTheme: () => {}
})

export function useTheme(): ThemeState {
  return useContext(ThemeContext)
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [theme, setThemeState] = useState<ThemePref>('system')
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve('system'))
  const [loaded, setLoaded] = useState(false)

  // Seed from the persisted preference once, then apply.
  useEffect(() => {
    let live = true
    void window.api
      .getSettings()
      .then((s) => {
        if (!live) return
        const pref = (s?.theme as ThemePref) || 'system'
        setThemeState(pref)
        const r = resolve(pref)
        setResolved(r)
        apply(r)
      })
      .catch(() => {
        /* missing/corrupt settings read as system */
        apply(resolve('system'))
      })
      .finally(() => {
        if (live) setLoaded(true)
      })
    return () => {
      live = false
    }
  }, [])

  // While the preference is 'system', track OS light/dark changes live.
  useEffect(() => {
    if (theme !== 'system') return
    const mq = media()
    if (!mq) return
    const onChange = (): void => {
      const r = resolve('system')
      setResolved(r)
      apply(r)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = useCallback((t: ThemePref) => {
    setThemeState(t)
    const r = resolve(t)
    setResolved(r)
    apply(r)
    void window.api.setSettings({ theme: t }).catch(() => {})
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, resolved, loaded, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
