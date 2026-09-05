import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Pill, StatusDot, InfoTip, Icon } from '@renderer/ui'
import {
  PROVIDER_GROUPS,
  providerLabel,
  providerAuthFor,
  vendorOf,
  fetchDefaultModels
} from '@renderer/lib/providers'
import { ModelSelect } from '@renderer/components/ModelSelect'
import { ServerRow } from '@renderer/components/mcp/ServerRow'
import { McpCatalogPicker } from '@renderer/components/mcp/McpCatalogPicker'
import { summarize, type McpServerStatus } from '@renderer/components/mcp/mcpStatus'
import { useDefaultMcp, saveDefaultMcp, type DefaultMcpEntry } from '@renderer/lib/mcp'
import { useAdvancedMode } from '@renderer/services/advancedMode'
import { useTheme, type ThemePref } from '@renderer/services/theme'

/**
 * 2h — Settings, sectioned (replaces the legacy SettingsView).
 *
 * A 208px settings-nav on the left + a single scrolling, sectioned form on the
 * right. Nav items scroll to / highlight their section; every control shows a
 * REAL value so nothing reads as an empty zero.
 *
 * Backing reality (CURRENT-APP.md §1h + §1g):
 *   - The ONLY app preference the main process persists today is `officeBaseUrl`
 *     (getSettings/setSettings). That drives the "Pixel Office" section.
 *   - officeStatus()/officeOffices() give the live connection badge + office count.
 *   - appVersion() (app:version) → the installed app version, shown in the footer
 *     and About.
 *   - officeKeyUsage() (office:keyUsage) → per-account provider key usage from the
 *     connected office's deployer vault; FAILS SOFT to [] when not connected.
 *   - listAgents() → the REAL tracked workspaces (Storage) + the MCP agent picker.
 *   - agentMcpStatus(path) → the live per-agent MCP connectivity list.
 */

type SectionId =
  | 'general'
  | 'providers'
  | 'default-models'
  | 'pixel-office'
  | 'mcp'
  | 'storage'
  | 'about'

// Full nav (Advanced). In Basic the MCP section is hidden — it's an expert,
// per-agent (.mcp.json) concern — and returns the moment Advanced is on.
const NAV_ALL: { id: SectionId; label: string; advancedOnly?: boolean }[] = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
  { id: 'default-models', label: 'Default models' },
  { id: 'pixel-office', label: 'Pixel Office' },
  { id: 'mcp', label: 'MCP', advancedOnly: true },
  { id: 'storage', label: 'Storage & logs' },
  { id: 'about', label: 'About' }
]

// The vendors that carry a per-provider default model (#8), keyed by the family
// the model catalog uses, labelled from the single provider vocabulary.
const DEFAULT_MODEL_VENDORS: { key: string; label: string }[] = PROVIDER_GROUPS.map((g) => ({
  key: vendorOf(g.options[0].id),
  label: g.vendor
}))

// Per-provider onboarding hint, keyed by the provider id. Labels come from
// lib/providers (the single source of provider vocabulary); this only adds the
// "how to authenticate / what it is" prose the mockup calls out. Any id not
// listed falls back to a generic line built from its vendor.
const PROVIDER_HINTS: Record<string, string> = {
  'claude-tui':
    'Anthropic Claude via the Claude Code TUI. Authenticate with `claude` (subscription or API key). Subscription tokens expire periodically and need re-login.',
  'claude-cli':
    'Anthropic Claude run headless (no terminal UI) for long unattended loops. Same `claude` sign-in as the interactive variant.',
  'copilot-cli':
    'GitHub Copilot via its CLI. Sign in with `copilot`; requires a Copilot plan that permits the model you pick.',
  'copilot-sdk':
    'GitHub Copilot via its SDK — headless, for unattended loops. Same `copilot` sign-in; the plan must allow the model.',
  'opencode-cli':
    'OpenCode via its CLI. Authenticate with `opencode auth login` on this machine.',
  'opencode-sdk':
    'OpenCode run headless via its SDK — no terminal UI, ideal for long unattended loops. Same `opencode auth login`.',
  'grok-cli':
    'xAI Grok, driven through its CLI. Authenticate with `grok`; tokens refresh automatically but can still expire.',
  'grok-tui':
    'xAI Grok via its interactive TUI. Same `grok` sign-in as the CLI variant.'
}
const providerHint = (id: string): string =>
  PROVIDER_HINTS[id] ??
  `${providerLabel(id)} — sign in with \`${providerAuthFor(id).cmd}\` on this machine.`

// About / footer links. The app has no `homepage` in package.json, so these are
// the canonical product URLs, opened in the system browser via openExternal.
const LINKS = {
  homepage: 'https://autoaidev.com',
  docs: 'https://autoaidev.com/docs',
  download: 'https://app.pixeloffice.org/download'
}
// Static package.json facts (renderer can't read package.json at runtime).
const AUTHOR = 'Peter Ivanov <peter@microweber.com>'
const LICENSE = 'MIT'

interface OfficeStatus {
  connected: boolean
  base: string
  email?: string
}

// Mirror of the preload KeyUsage shape without a cross-package import — derived
// straight from the exposed IPC signature so it can never drift.
type KeyUsage = Awaited<ReturnType<typeof window.api.officeKeyUsage>>[number]
type KeyUsageLimit = KeyUsage['limits'][number]

type AgentLite = { path: string; name: string }

/** severity → bar colour, with a pct-based fallback when the deployer sent none. */
function sevColor(sev?: string, pct?: number): string {
  if (sev === 'critical') return 'var(--st-error)'
  if (sev === 'warning') return 'var(--st-needsyou)'
  if (typeof pct === 'number') {
    if (pct >= 90) return 'var(--st-error)'
    if (pct >= 70) return 'var(--st-needsyou)'
  }
  return 'var(--st-running)'
}

/** compact relative time, e.g. "in 3h" / "5d ago" — empty for a bad/absent iso. */
function fmtWhen(iso?: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diff = t - Date.now()
  const abs = Math.abs(diff)
  let rel: string
  if (abs < 3_600_000) rel = `${Math.max(1, Math.round(abs / 60_000))}m`
  else if (abs < 86_400_000) rel = `${Math.round(abs / 3_600_000)}h`
  else rel = `${Math.round(abs / 86_400_000)}d`
  return diff >= 0 ? `in ${rel}` : `${rel} ago`
}

export function SettingsView2(): JSX.Element {
  // App-wide Advanced flag — gates the MCP section + the Providers detail below.
  const { advanced, setAdvanced } = useAdvancedMode()
  // App-wide theme preference (System/Dark/Light) — mirrors the top-nav ThemeToggle.
  const { theme, setTheme } = useTheme()
  const NAV = useMemo(() => NAV_ALL.filter((n) => advanced || !n.advancedOnly), [advanced])

  // Open on the General pane so the Advanced switch is the first thing a novice sees.
  const [active, setActive] = useState<SectionId>('general')

  // --- REAL, persisted preference: Pixel Office server URL ---------------------
  const [base, setBase] = useState('')
  const [savedBase, setSavedBase] = useState('')
  const [defaultBase, setDefaultBase] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedPulse, setSavedPulse] = useState(false)
  const [urlErr, setUrlErr] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  // --- Per-provider default models (#8) — an app preference that seeds new agents.
  // `defaultModels[vendor]` = '' means "provider default". `savedVendor` briefly
  // flags the row that just persisted so a select-to-save gives real feedback.
  const [defaultModels, setDefaultModels] = useState<Record<string, string>>({})
  const [savedVendor, setSavedVendor] = useState<string | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // --- REAL, live connection signal for the Pixel Office card header ----------
  const [status, setStatus] = useState<OfficeStatus | null>(null)
  const [officeCount, setOfficeCount] = useState<number | null>(null)

  // --- REAL, resolved CLI availability for the About / footer block -----------
  const [cli, setCli] = useState<{ found: boolean; path: string } | null>(null)

  // --- REAL app version (app:version) for the footer + About ------------------
  const [appVer, setAppVer] = useState<string>('')

  // --- Per-account provider key usage (office:keyUsage; fails soft to []) ------
  // null = still loading; [] = none available (not connected / no readable keys).
  const [keyUsage, setKeyUsage] = useState<KeyUsage[] | null>(null)

  // --- REAL tracked workspaces (listAgents) → Storage + the MCP agent picker --
  const [agents, setAgents] = useState<AgentLite[]>([])

  // --- Editable DEFAULT MCP servers (seed for NEW agents) ---------------------
  // Mirrors "Default models": persisted app-side (app-settings.json defaultMcp),
  // applied by SEEDING at agent create. Existing agents are untouched — use
  // "Apply to folder/selection" (BulkMcpModal) for those.
  const { defaults: defaultMcp, reload: reloadDefaultMcp } = useDefaultMcp()

  // --- Live per-agent MCP connectivity (agentMcpStatus) -----------------------
  const [mcpSel, setMcpSel] = useState<string>('')
  const [mcpData, setMcpData] = useState<{ servers: McpServerStatus[]; error?: string } | null>(null)
  const [mcpLoading, setMcpLoading] = useState(false)

  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef<Partial<Record<SectionId, HTMLElement | null>>>({})

  // Load the persisted URL once.
  useEffect(() => {
    void (async () => {
      const cfg = (await window.api.getSettings()) as { officeBaseUrl: string }
      const v = cfg.officeBaseUrl || ''
      setBase(v)
      setSavedBase(v)
      setDefaultBase(v)
      setLoaded(true)
    })()
    return () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current)
    }
  }, [])

  // Live connection status + office count (guarded: officeOffices THROWS on a dead
  // session, so only probe when connected and swallow failures).
  const refreshStatus = useCallback(async () => {
    try {
      const s = (await window.api.officeStatus()) as OfficeStatus
      setStatus(s)
      if (s.connected) {
        try {
          const offs = (await window.api.officeOffices()) as { slug: string }[]
          setOfficeCount(Array.isArray(offs) ? offs.length : null)
        } catch {
          setOfficeCount(null)
        }
      } else {
        setOfficeCount(null)
      }
    } catch {
      setStatus({ connected: false, base: '' })
      setOfficeCount(null)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  // Resolve CLI availability + app version once for the About section + footer.
  useEffect(() => {
    void (async () => {
      try {
        const r = (await window.api.cliCheck()) as { found: boolean; path: string }
        setCli({ found: !!r?.found, path: r?.path || '' })
      } catch {
        setCli({ found: false, path: '' })
      }
    })()
    void (async () => {
      try {
        setAppVer((await window.api.appVersion()) || '')
      } catch {
        setAppVer('')
      }
    })()
  }, [])

  // Per-account key usage. officeKeyUsage() is documented to fail soft to [], but
  // guard anyway so a rejection can never blank the page.
  useEffect(() => {
    void (async () => {
      try {
        const u = await window.api.officeKeyUsage()
        setKeyUsage(Array.isArray(u) ? u : [])
      } catch {
        setKeyUsage([])
      }
    })()
  }, [status?.connected])

  // Per-provider default models — read once; each change persists on select.
  useEffect(() => {
    void fetchDefaultModels().then(setDefaultModels)
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current)
    }
  }, [])

  const saveDefaultModel = useCallback(async (vendor: string, id: string) => {
    // Optimistic local update so the picker reflects the choice immediately.
    setDefaultModels((prev) => {
      const next = { ...prev }
      if (id.trim()) next[vendor] = id.trim()
      else delete next[vendor]
      return next
    })
    try {
      await window.api.setSettings({ defaultModels: { [vendor]: id.trim() } })
      setSavedVendor(vendor)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSavedVendor((v) => (v === vendor ? null : v)), 1600)
    } catch {
      /* a failed write leaves the optimistic value; the next open re-reads truth */
    }
  }, [])

  // Tracked workspaces (real folders) for Storage + the MCP picker.
  useEffect(() => {
    void (async () => {
      try {
        const a = (await window.api.listAgents()) as AgentLite[]
        setAgents(Array.isArray(a) ? a : [])
      } catch {
        setAgents([])
      }
    })()
  }, [])

  // Persist the whole default-MCP list, then re-read truth (replace semantics).
  const persistDefaultMcp = useCallback(async (next: DefaultMcpEntry[]) => {
    await saveDefaultMcp(next)
    reloadDefaultMcp()
  }, [reloadDefaultMcp])

  const addDefaultMcp = useCallback(
    (pick: { name: string; server: DefaultMcpEntry['server']; kind: DefaultMcpEntry['kind']; id?: string; label?: string }) => {
      if (defaultMcp.some((d) => d.name === pick.name)) return // dedupe by name
      void persistDefaultMcp([...defaultMcp, { id: pick.id, name: pick.name, label: pick.label, server: pick.server, kind: pick.kind }])
    },
    [defaultMcp, persistDefaultMcp]
  )
  const removeDefaultMcp = useCallback(
    (name: string) => void persistDefaultMcp(defaultMcp.filter((d) => d.name !== name)),
    [defaultMcp, persistDefaultMcp]
  )
  const toggleDefaultMcp = useCallback(
    (name: string) =>
      void persistDefaultMcp(
        defaultMcp.map((d) =>
          d.name === name ? { ...d, server: { ...d.server, enabled: d.server?.enabled === false } } : d
        )
      ),
    [defaultMcp, persistDefaultMcp]
  )

  const loadMcp = useCallback(async (path: string) => {
    setMcpSel(path)
    setMcpData(null)
    if (!path) return
    setMcpLoading(true)
    try {
      const r = (await window.api.agentMcpStatus(path)) as {
        servers?: McpServerStatus[]
        error?: string
      }
      setMcpData({ servers: Array.isArray(r?.servers) ? r.servers : [], error: r?.error })
    } catch (e) {
      setMcpData({ servers: [], error: String((e as Error)?.message ?? e) })
    } finally {
      setMcpLoading(false)
    }
  }, [])

  // Scroll-spy: highlight the nav item whose section is nearest the top.
  useEffect(() => {
    const root = contentRef.current
    if (!root) return
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id as SectionId)
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 }
    )
    for (const el of Object.values(sectionRefs.current)) if (el) obs.observe(el)
    return () => obs.disconnect()
    // Re-observe when Advanced toggles a section (MCP) in/out of the DOM.
  }, [advanced])

  const goTo = useCallback((id: SectionId) => {
    setActive(id)
    sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const looksValid = useCallback((v: string): boolean => {
    const s = v.trim()
    if (!s) return true
    try {
      const u = new URL(s)
      return u.protocol === 'https:' || u.protocol === 'http:'
    } catch {
      return false
    }
  }, [])

  const flashSaved = useCallback(() => {
    setSavedPulse(true)
    if (pulseTimer.current) clearTimeout(pulseTimer.current)
    pulseTimer.current = setTimeout(() => setSavedPulse(false), 1800)
  }, [])

  const saveUrl = useCallback(async () => {
    setUrlErr('')
    setSaving(true)
    const r = (await window.api.setSettings({ officeBaseUrl: base.trim() })) as {
      ok?: true
      officeBaseUrl?: string
      error?: string
    }
    setSaving(false)
    if (r?.error) {
      setUrlErr(r.error)
      return
    }
    const resolved = r.officeBaseUrl ?? ''
    setBase(resolved)
    setSavedBase(resolved)
    flashSaved()
    void refreshStatus()
  }, [base, flashSaved, refreshStatus])

  const resetUrl = useCallback(async () => {
    setUrlErr('')
    setSaving(true)
    const r = (await window.api.setSettings({ officeBaseUrl: '' })) as {
      officeBaseUrl?: string
      error?: string
    }
    setSaving(false)
    if (r?.error) {
      setUrlErr(r.error)
      return
    }
    const resolved = r.officeBaseUrl ?? ''
    setBase(resolved)
    setSavedBase(resolved)
    setDefaultBase(resolved)
    flashSaved()
  }, [flashSaved])

  const testConnection = useCallback(async () => {
    const b = base.trim()
    if (!b) {
      setTestResult({ ok: false, msg: 'Enter a Server URL first.' })
      return
    }
    if (!looksValid(base)) {
      setTestResult({ ok: false, msg: 'That doesn’t look like an http(s) URL.' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const r = (await window.api.officePing(b)) as { ok?: true; error?: string }
      setTestResult(r?.ok ? { ok: true, msg: 'Reachable — this is a Pixel Office.' } : { ok: false, msg: r?.error || 'Could not reach that server.' })
    } catch (e) {
      setTestResult({ ok: false, msg: String((e as Error)?.message ?? e) })
    } finally {
      setTesting(false)
    }
  }, [base, looksValid])

  const urlDirty = base.trim() !== savedBase.trim()
  const urlInvalid = !looksValid(base)

  const setRef = (id: SectionId) => (el: HTMLElement | null): void => {
    sectionRefs.current[id] = el
  }

  const connOffices = officeCount == null ? null : officeCount
  const connLabel = useMemo(() => {
    if (!status) return 'checking…'
    if (!status.connected) return 'not connected'
    return connOffices == null
      ? 'connected'
      : `connected · ${connOffices} office${connOffices === 1 ? '' : 's'}`
  }, [status, connOffices])

  const openLink = useCallback((url: string) => {
    void window.api.openExternal(url)
  }, [])

  return (
    <div style={S.root}>
      <style>{CSS}</style>

      {/* left settings-nav (208) */}
      <nav style={S.nav} aria-label="Settings sections">
        <div style={S.navLabel}>SETTINGS</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {NAV.map((n) => {
            const on = active === n.id
            return (
              <button
                key={n.id}
                className="sv2-nav-item"
                aria-current={on ? 'page' : undefined}
                onClick={() => goTo(n.id)}
                style={{
                  ...S.navItem,
                  background: on ? 'var(--bg-selected)' : 'transparent',
                  color: on ? 'var(--tx-hi)' : 'var(--tx-3)',
                  fontWeight: on ? 600 : 400,
                  boxShadow: on ? 'inset 2px 0 0 var(--accent)' : 'none'
                }}
              >
                {n.label}
              </button>
            )
          })}
        </div>
        <div style={S.navFooter}>
          <div>AutoDev desktop{appVer ? ` v${appVer}` : ''}</div>
          {cli && <div>{cli.found ? 'AutoDev CLI ready' : 'AutoDev CLI not installed'}</div>}
        </div>
      </nav>

      {/* right sectioned form (flex, scrolls) */}
      <div ref={contentRef} style={S.content}>
        <div style={S.inner}>
          {/* ── General (Advanced mode) ────────────────────────────────── */}
          <Section
            id="general"
            innerRef={setRef('general')}
            title="General"
            subtitle="How much of the app you see. Basic keeps a calm surface for everyday work; Advanced reveals every expert control."
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18, padding: '14px 0', borderBottom: 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={S.rowLabel}>Advanced mode</div>
                <div style={S.rowDesc}>
                  Show expert controls — MCP, raw logs, task timeouts, bulk actions and extra fleet
                  columns. Off by default; nothing essential is ever hidden.
                </div>
              </div>
              <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={advanced}
                  onClick={() => setAdvanced(!advanced)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 9,
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer'
                  }}
                >
                  <span style={{ fontSize: 11.5, color: advanced ? 'var(--st-running)' : 'var(--tx-4)', fontWeight: 600 }}>
                    {advanced ? 'On' : 'Off'}
                  </span>
                  <span
                    aria-hidden
                    style={{
                      position: 'relative',
                      width: 34,
                      height: 18,
                      borderRadius: 'var(--r-pill)',
                      background: advanced ? 'var(--accent)' : 'var(--bg-input)',
                      border: `1px solid ${advanced ? 'var(--accent)' : 'var(--bd-1)'}`,
                      transition: 'background .12s ease'
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        top: 1,
                        left: advanced ? 17 : 1,
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        background: advanced ? 'var(--tx-onaccent)' : 'var(--tx-4)',
                        transition: 'left .12s ease'
                      }}
                    />
                  </span>
                </button>
              </div>
            </div>

            {/* Appearance — System / Dark / Light. Default System follows the OS. */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18, padding: '14px 0', borderTop: '1px solid var(--bd-2)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={S.rowLabel}>Appearance</div>
                <div style={S.rowDesc}>
                  The app theme. System follows your OS light/dark setting; Dark and Light pin it.
                </div>
              </div>
              <div style={{ flexShrink: 0, display: 'inline-flex', borderRadius: 'var(--r-button)', border: '1px solid var(--bd-field)', background: 'var(--bg-input)', overflow: 'hidden' }}>
                {(['system', 'dark', 'light'] as ThemePref[]).map((opt) => {
                  const on = theme === opt
                  const lbl = opt === 'system' ? 'System' : opt === 'dark' ? 'Dark' : 'Light'
                  return (
                    <button
                      key={opt}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setTheme(opt)}
                      style={{
                        padding: '6px 14px',
                        border: 'none',
                        cursor: 'pointer',
                        fontFamily: 'var(--font-sans)',
                        fontSize: 'var(--fs-desc)',
                        fontWeight: on ? 700 : 500,
                        background: on ? 'var(--accent)' : 'transparent',
                        color: on ? 'var(--tx-onaccent)' : 'var(--tx-3)'
                      }}
                    >
                      {lbl}
                    </button>
                  )
                })}
              </div>
            </div>
          </Section>

          {/* ── Providers ──────────────────────────────────────────────── */}
          <Section
            id="providers"
            innerRef={setRef('providers')}
            title="Providers"
            subtitle="The provider CLIs this machine can launch — separate from the AutoDev CLI runner that drives them. Credentials are managed per provider; usage/limits below come from the connected office's key vault."
          >
            {/* All eight provider variants, grouped by vendor (lib/providers is the
                single source). Each vendor shows its one sign-in command; each
                variant reads GREEN "recognized" — the app knows this id — without
                asserting a sign-in state it can't yet probe. */}
            {PROVIDER_GROUPS.map((g) => {
              const auth = providerAuthFor(g.options[0].id)
              return (
                <div key={g.vendor} style={S.providerGroup}>
                  <div style={S.providerGroupHead}>
                    <span style={S.providerVendor}>{g.vendor}</span>
                    <code style={S.authCmd}>sign in:&nbsp;{auth.cmd}</code>
                  </div>
                  {/* Basic collapses each vendor to just its sign-in command (the head
                      above). The per-variant "recognized" rows are an expert detail —
                      shown only in Advanced. */}
                  {advanced && g.options.map((o, i) => (
                    <SettingRow
                      key={o.id}
                      label={
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          {providerLabel(o.id)}
                          <InfoTip label={providerLabel(o.id)} width={260}>
                            {providerHint(o.id)}
                          </InfoTip>
                        </span>
                      }
                      desc={o.id}
                      last={i === g.options.length - 1}
                    >
                      <Pill variant="green" selected style={{ fontSize: 10.5 }}>
                        <StatusDot status="running" size={6} />
                        recognized
                      </Pill>
                    </SettingRow>
                  ))}
                </div>
              )
            })}

            {/* Per-account key usage from the office vault (Claude 5h+weekly,
                OpenRouter credit, …). An expert diagnostic (usage limit bars) — shown
                only in Advanced; Basic keeps the Providers pane to sign-in commands. */}
            {advanced && (
              <>
                <div style={S.subHead}>
                  <span style={S.subHeadTitle}>Key usage</span>
                  <InfoTip label="Key usage" width={270}>
                    Live provider key usage/limits from the connected Pixel Office’s deployer vault —
                    one card per credential. Not connected to an office ⇒ nothing to show here.
                  </InfoTip>
                </div>
                {keyUsage == null ? (
                  <div style={S.usageMuted}>Checking key usage…</div>
                ) : keyUsage.length === 0 ? (
                  <div style={S.emptyNote}>
                    No provider key usage to show. Sign in to a Pixel Office on the Office tab — its
                    credential vault reports the live usage/limits for each provider account here.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {keyUsage.map((u, i) => (
                      <KeyUsageCard key={`${u.provider}-${u.label ?? i}`} u={u} />
                    ))}
                  </div>
                )}
              </>
            )}

            <div style={{ ...S.helpText, borderTop: 'none', paddingTop: 8 }}>
              <strong style={{ color: 'var(--tx-3)' }}>Authenticate each provider before you run agents.</strong>{' '}
              Every provider signs in through its own CLI on this machine — run the command shown for
              each vendor and follow its login. The app can’t yet verify which are signed in, so if a
              headless loop or an office “Connect all” reports a needs-auth error, re-run that
              provider’s login.
            </div>
          </Section>

          {/* ── Default models (#8) ────────────────────────────────────── */}
          <Section
            id="default-models"
            innerRef={setRef('default-models')}
            title="Default models"
            subtitle="A house model per provider, pre-selected when you create a new agent (single-agent Setup, Make-app teams, and add-a-folder). Leave a provider on “Provider default” to let it pick its own. Existing agents are unaffected — and you can still override the model per agent."
          >
            {DEFAULT_MODEL_VENDORS.map((v, i) => (
              <div
                key={v.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 18,
                  padding: '14px 0',
                  borderBottom: i === DEFAULT_MODEL_VENDORS.length - 1 ? 'none' : '1px solid var(--bd-2)'
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={S.rowLabel}>{v.label}</div>
                  <div style={S.rowDesc}>Pre-selected for new {v.label} agents.</div>
                </div>
                <div style={{ width: 240, flexShrink: 0 }}>
                  <ModelSelect
                    compact
                    vendor={v.key}
                    value={defaultModels[v.key] ?? ''}
                    onChange={(id) => void saveDefaultModel(v.key, id)}
                  />
                  {savedVendor === v.key && (
                    <div style={{ marginTop: 5, fontSize: 10.5, color: 'var(--st-running)' }} role="status">
                      Saved ✓
                    </div>
                  )}
                </div>
              </div>
            ))}
          </Section>

          {/* ── Pixel Office (REAL, wired) ─────────────────────────────── */}
          <Section
            id="pixel-office"
            innerRef={setRef('pixel-office')}
            title="Pixel Office"
            subtitle="The remote office server the app connects to when you sign in."
          >
            <div style={S.card}>
              <div style={S.cardHead}>
                <span style={S.cardTitle}>Pixel Office</span>
                <span
                  style={{
                    ...S.connMeta,
                    color: status?.connected ? 'var(--st-running)' : 'var(--tx-4)'
                  }}
                >
                  <StatusDot status={status?.connected ? 'running' : 'idle'} />
                  {connLabel}
                </span>
              </div>

              <label htmlFor="sv2-office-url" style={{ ...S.fieldLabel, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                SERVER URL
                <InfoTip label="Server URL" width={250}>
                  The address of your Pixel Office server, e.g. <code>https://app.pixeloffice.org</code>. https only — http is allowed for localhost. Test it below before you sign in on the Office tab.
                </InfoTip>
              </label>
              <input
                id="sv2-office-url"
                className="sv2-input"
                value={base}
                disabled={!loaded}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder={defaultBase || 'https://app.pixeloffice.org'}
                onChange={(e) => {
                  setBase(e.target.value)
                  setUrlErr('')
                  setTestResult(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && urlDirty && !urlInvalid && !saving) void saveUrl()
                }}
                style={{
                  ...S.input,
                  fontFamily: 'var(--font-mono)',
                  borderColor: urlInvalid ? 'var(--st-error-bd)' : 'var(--bd-1)'
                }}
              />

              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!loaded || saving || urlInvalid || !urlDirty}
                  onClick={() => void saveUrl()}
                >
                  {saving ? 'Saving…' : savedPulse ? 'Saved ✓' : 'Save'}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!loaded || saving || base.trim() === ''}
                  onClick={() => void resetUrl()}
                >
                  Reset
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!loaded || testing || urlInvalid || base.trim() === ''}
                  onClick={() => void testConnection()}
                >
                  {testing ? 'Testing…' : 'Test connection'}
                </Button>
              </div>

              {testResult && (
                <div
                  role="status"
                  style={{
                    ...S.errText,
                    color: testResult.ok ? 'var(--st-running)' : 'var(--st-error-bright)'
                  }}
                >
                  {testResult.ok ? '✓ ' : ''}
                  {testResult.msg}
                </div>
              )}

              {urlInvalid && (
                <div role="alert" style={S.errText}>
                  That doesn’t look like an http(s) URL.
                </div>
              )}
              {urlErr && (
                <div role="alert" style={S.errText}>
                  {urlErr}
                </div>
              )}

              <div style={S.helpText}>
                https only — http allowed for localhost. Applies on your next connect;
                a currently signed-in session is unaffected until you reconnect.
              </div>
            </div>
          </Section>

          {/* ── MCP ────────────────────────────────────────────────────── */}
          {/* Expert, per-agent (.mcp.json) surface — hidden in Basic, one click (the
              Advanced switch above) away. */}
          {advanced && (
          <Section
            id="mcp"
            innerRef={setRef('mcp')}
            title={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                MCP
                <InfoTip label="MCP" showHeading width={270}>
                  Model Context Protocol — the standard that lets an agent talk to external
                  tools/servers (a shared office, a memory store, the filesystem). Each server
                  is an entry in the agent’s <code>.mcp.json</code>.
                </InfoTip>
              </span>
            }
            subtitle="Editable default MCP servers that seed new agents, and a live connectivity check for any agent. MCP is configured per agent (.mcp.json); defaults here are a create-time seed applied through the CLI."
          >
            <div style={S.subHead}>
              <span style={S.subHeadTitle}>Default MCP servers</span>
              <InfoTip label="Default MCP servers" width={290}>
                These seed every NEW agent you create (single-agent Setup, Make-app teams, add-a-folder).
                Existing agents are unaffected — use the rail/Fleet <strong>Set MCP…</strong> action to
                apply them to agents you already have. Every write goes through the AutoDev CLI.
              </InfoTip>
              <div style={{ marginLeft: 'auto' }}>
                <McpCatalogPicker
                  buttonLabel="Add server"
                  exclude={new Set(defaultMcp.map((d) => d.name))}
                  onPick={addDefaultMcp}
                />
              </div>
            </div>
            {defaultMcp.length === 0 ? (
              <div style={S.emptyNote}>
                No default MCP servers yet. Add one with <strong>Add server</strong> above — it will be
                seeded into every new agent. Leave this empty to create agents with no MCP servers
                pre-wired.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {defaultMcp.map((m) => {
                  const enabled = m.server?.enabled !== false
                  const remote = typeof m.server?.url === 'string' && m.server.url
                  const detail = remote
                    ? m.server.url
                    : [m.server?.command, ...(m.server?.args ?? [])].filter(Boolean).join(' ')
                  return (
                    <div key={m.name} style={S.mcpCard}>
                      <div style={S.mcpCardHead}>
                        <span style={S.mcpName} title={m.name}>{m.label || m.name}</span>
                        <span style={S.transportBadge}>{remote ? 'remote' : 'stdio'}</span>
                        {m.kind && m.kind !== 'custom' && (
                          <Pill variant="neutral" style={{ fontSize: 9 }}>{m.kind}</Pill>
                        )}
                        <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', color: enabled ? 'var(--st-running)' : 'var(--tx-dim)' }}>
                          {enabled ? 'enabled' : 'disabled'}
                        </span>
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                          <Button variant="ghost" size="sm" onClick={() => toggleDefaultMcp(m.name)}>
                            {enabled ? 'Disable' : 'Enable'}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => removeDefaultMcp(m.name)}>
                            Remove
                          </Button>
                        </div>
                      </div>
                      {detail && <code style={S.mcpDetail}>{detail}</code>}
                    </div>
                  )
                })}
              </div>
            )}

            <div style={S.subHead}>
              <span style={S.subHeadTitle}>Check an agent</span>
              <InfoTip label="Connectivity check" width={270}>
                Pick a tracked agent to probe its configured MCP servers live — ready (green),
                failing (red) or disabled. This is the same check the agent’s Inspector → MCP runs.
              </InfoTip>
            </div>
            {agents.length === 0 ? (
              <div style={S.emptyNote}>
                No agents added yet. Add one on the Agents tab, then pick it here to run a live
                MCP connectivity check.
              </div>
            ) : (
              <>
                <div style={{ position: 'relative', maxWidth: 320 }}>
                  <select
                    className="sv2-select"
                    aria-label="Agent to check MCP connectivity for"
                    value={mcpSel}
                    onChange={(e) => void loadMcp(e.target.value)}
                    style={S.select}
                  >
                    <option value="">Select an agent…</option>
                    {agents.map((a) => (
                      <option key={a.path} value={a.path}>
                        {a.name || a.path}
                      </option>
                    ))}
                  </select>
                  <span style={S.selectCaret}>
                    <Icon name="chevron" size={13} />
                  </span>
                </div>

                {mcpLoading && <div style={{ ...S.usageMuted, marginTop: 10 }}>Checking servers…</div>}

                {!mcpLoading && mcpData && (
                  <div style={{ marginTop: 10 }}>
                    {mcpData.error ? (
                      <div role="alert" style={S.errText}>
                        {mcpData.error}
                      </div>
                    ) : mcpData.servers.length === 0 ? (
                      <div style={S.usageMuted}>
                        No MCP servers configured for this agent.
                      </div>
                    ) : (
                      <>
                        {(() => {
                          const c = summarize(mcpData.servers)
                          return (
                            <div style={S.mcpSummary}>
                              <span style={{ color: 'var(--st-running)' }}>{c.ready} ready</span>
                              <span style={S.mcpSummaryDot}>·</span>
                              <span style={{ color: c.failing ? 'var(--st-error)' : 'var(--tx-4)' }}>
                                {c.failing} failing
                              </span>
                              <span style={S.mcpSummaryDot}>·</span>
                              <span style={{ color: 'var(--tx-dim)' }}>{c.disabled} disabled</span>
                            </div>
                          )
                        })()}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
                          {mcpData.servers.map((s) => (
                            <ServerRow key={s.name} server={s} />
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </Section>
          )}

          {/* ── Storage & logs ─────────────────────────────────────────── */}
          <Section
            id="storage"
            innerRef={setRef('storage')}
            title="Storage & logs"
            subtitle="Where this app keeps workspaces and diagnostic logs on this machine."
          >
            {/* REAL tracked workspaces from listAgents() — each is a folder on disk
                you added. Replaces the former single fabricated root. */}
            <div style={{ padding: '14px 0', borderBottom: '1px solid var(--bd-2)' }}>
              <div style={S.rowLabel}>Agent workspaces</div>
              <div style={S.rowDesc}>
                The folders the app tracks — each agent lives in the workspace you added for it.
              </div>
              {agents.length === 0 ? (
                <div style={{ ...S.usageMuted, marginTop: 8 }}>
                  No workspaces yet — add an agent on the Agents tab.
                </div>
              ) : (
                <div style={S.pathList}>
                  {agents.map((a) => (
                    <button
                      key={a.path}
                      type="button"
                      className="sv2-path"
                      title={`Open ${a.path}`}
                      onClick={() => void window.api.openPath(a.path)}
                      style={S.pathRow}
                    >
                      <Icon name="folder" size={12} />
                      <span style={S.pathText}>{a.path}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <SettingRow label="Logs" desc="Diagnostic logs for support." last>
              <span style={S.mutedValue}>managed by the app</span>
            </SettingRow>
          </Section>

          {/* ── About ──────────────────────────────────────────────────── */}
          <Section
            id="about"
            innerRef={setRef('about')}
            title="About"
            subtitle="AutoDev desktop."
            last
          >
            <SettingRow label="Application" desc="AutoDev desktop">
              <span style={{ ...S.mutedValue, fontFamily: 'var(--font-mono)' }}>autodev-app</span>
            </SettingRow>
            <SettingRow label="Version" desc="Installed app build.">
              <span style={{ ...S.mutedValue, fontFamily: 'var(--font-mono)' }}>
                {appVer ? `v${appVer}` : 'checking…'}
              </span>
            </SettingRow>
            <SettingRow label="Author" desc="Maintainer.">
              <span style={S.mutedValue}>{AUTHOR}</span>
            </SettingRow>
            <SettingRow label="License" desc="Distribution terms.">
              <span style={{ ...S.mutedValue, fontFamily: 'var(--font-mono)' }}>{LICENSE}</span>
            </SettingRow>
            <SettingRow
              label="AutoDev CLI"
              desc={cli?.found ? cli.path : 'The runner that drives agents (bundled autodev CLI)'}
            >
              <span style={S.mutedValue}>
                {cli == null ? 'checking…' : cli.found ? 'ready' : 'not installed'}
              </span>
            </SettingRow>
            <SettingRow label="Links" desc="Home, docs and downloads — opens in your browser." last>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {(
                  [
                    ['Homepage', LINKS.homepage],
                    ['Docs', LINKS.docs],
                    ['Download', LINKS.download]
                  ] as const
                ).map(([label, url]) => (
                  <button
                    key={label}
                    type="button"
                    className="sv2-link"
                    onClick={() => openLink(url)}
                    style={S.linkBtn}
                  >
                    {label}
                    <Icon name="external" size={10} />
                  </button>
                ))}
              </span>
            </SettingRow>
          </Section>
        </div>
      </div>
    </div>
  )
}

/* ── local subcomponents ─────────────────────────────────────────────────── */

function KeyUsageCard({ u }: { u: KeyUsage }): JSX.Element {
  const title = u.label || providerLabel(u.provider) || u.provider
  const errMsg =
    u.error === 'reauth_required'
      ? 'Login expired — re-authenticate this account to resume.'
      : u.error === 'rate_limited'
        ? 'Rate-limited by the provider — resumes when the window clears.'
        : u.error
  return (
    <div style={S.usageCard}>
      <div style={S.usageHead}>
        <span style={S.usageLabel}>{title}</span>
        <span style={S.usageProvider}>
          {u.provider}
          {u.kind ? ` · ${u.kind}` : ''}
        </span>
      </div>
      {errMsg ? (
        <div style={{ ...S.errText, marginTop: 6 }}>{errMsg}</div>
      ) : u.unlimited ? (
        <div style={{ ...S.usageMuted, marginTop: 6 }}>No spend cap on this key.</div>
      ) : u.limits.length === 0 ? (
        <div style={{ ...S.usageMuted, marginTop: 6 }}>No usage reported.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 9 }}>
          {u.limits.map((lim, i) => (
            <UsageBar key={`${lim.label}-${i}`} lim={lim} />
          ))}
        </div>
      )}
      {u.expiresAt && (
        <div style={S.usageExpiry}>
          Key expires {fmtWhen(u.expiresAt)}
          <span style={{ color: 'var(--tx-gutter)' }}> · {new Date(u.expiresAt).toLocaleDateString()}</span>
        </div>
      )}
    </div>
  )
}

function UsageBar({ lim }: { lim: KeyUsageLimit }): JSX.Element {
  const derived =
    typeof lim.used === 'number' && typeof lim.limit === 'number' && lim.limit > 0
      ? Math.round((lim.used / lim.limit) * 100)
      : null
  const raw = typeof lim.pct === 'number' ? lim.pct : derived
  const pct = raw == null ? null : Math.max(0, Math.min(100, raw))
  const color = sevColor(lim.severity, pct ?? undefined)
  const value =
    typeof lim.used === 'number' && typeof lim.limit === 'number'
      ? `$${lim.used.toFixed(2)} / $${lim.limit.toFixed(2)}`
      : pct != null
        ? `${pct}%`
        : '—'
  return (
    <div>
      <div style={S.barTop}>
        <span style={S.barLabel}>{lim.label}</span>
        <span style={S.barVal}>{value}</span>
      </div>
      {pct != null && (
        <div style={S.barTrack}>
          <div style={{ ...S.barFill, width: `${pct}%`, background: color }} />
        </div>
      )}
      {lim.resetAt && <div style={S.barReset}>resets {fmtWhen(lim.resetAt)}</div>}
    </div>
  )
}

function Section(props: {
  id: string
  innerRef: (el: HTMLElement | null) => void
  title: React.ReactNode
  subtitle: string
  tag?: string
  last?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <section
      id={props.id}
      ref={props.innerRef}
      style={{ scrollMarginTop: 12, marginBottom: props.last ? 0 : 34 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={S.sectionTitle}>{props.title}</h2>
        {props.tag && (
          <Pill variant="neutral" style={{ fontSize: 9.5, letterSpacing: '.04em', textTransform: 'uppercase' }}>
            {props.tag}
          </Pill>
        )}
      </div>
      <p style={S.sectionSub}>{props.subtitle}</p>
      <div>{props.children}</div>
    </section>
  )
}

function SettingRow(props: {
  label: React.ReactNode
  desc?: string
  last?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '14px 0',
        borderBottom: props.last ? 'none' : '1px solid var(--bd-2)'
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={S.rowLabel}>{props.label}</div>
        {props.desc && <div style={S.rowDesc}>{props.desc}</div>}
      </div>
      <div style={{ width: 210, flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
        {props.children}
      </div>
    </div>
  )
}

/* ── styles (tokens only) ────────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    background: 'var(--bg-0)',
    fontFamily: 'var(--font-sans)'
  },
  nav: {
    width: 208,
    flexShrink: 0,
    borderRight: '1px solid var(--bd-nav)',
    padding: '16px 10px',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-0)'
  },
  navLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '.11em',
    color: 'var(--tx-4)',
    padding: '0 8px',
    marginBottom: 10
  },
  navItem: {
    textAlign: 'left',
    border: 'none',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    fontFamily: 'inherit',
    cursor: 'pointer',
    background: 'transparent'
  },
  navFooter: {
    marginTop: 'auto',
    paddingTop: 14,
    fontFamily: 'var(--font-mono)',
    fontSize: 9.5,
    lineHeight: 1.6,
    color: 'var(--tx-ghost)',
    padding: '14px 8px 0'
  },
  content: {
    flex: 1,
    minWidth: 0,
    overflow: 'auto',
    padding: '22px 26px'
  },
  inner: { maxWidth: 660 },
  sectionTitle: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
    letterSpacing: '-.01em',
    color: 'var(--tx-hi)'
  },
  sectionSub: {
    margin: '4px 0 8px',
    fontSize: 11.5,
    color: 'var(--tx-5)',
    lineHeight: 1.5
  },
  rowLabel: { fontSize: 12.5, fontWeight: 600, color: 'var(--tx-1)' },
  rowDesc: { fontSize: 11, color: 'var(--tx-5)', marginTop: 3, lineHeight: 1.45 },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '7px 10px',
    background: 'var(--bg-input)',
    border: '1px solid var(--bd-1)',
    borderRadius: 6,
    color: 'var(--tx-1)',
    fontSize: 11.5,
    outline: 'none'
  },
  select: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '7px 30px 7px 10px',
    background: 'var(--bg-input)',
    border: '1px solid var(--bd-1)',
    borderRadius: 6,
    color: 'var(--tx-1)',
    fontSize: 11.5,
    fontFamily: 'var(--font-sans)',
    appearance: 'none',
    WebkitAppearance: 'none',
    cursor: 'pointer',
    outline: 'none'
  },
  selectCaret: {
    position: 'absolute',
    right: 9,
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    color: 'var(--tx-4)',
    display: 'flex'
  },
  card: {
    background: 'var(--bg-panel)',
    border: '1px solid var(--bd-nav)',
    borderRadius: 9,
    padding: '15px 16px'
  },
  cardHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14
  },
  cardTitle: { fontSize: 12.5, fontWeight: 700, color: 'var(--tx-hi)' },
  connMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    letterSpacing: '.02em'
  },
  fieldLabel: {
    display: 'block',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '.11em',
    color: 'var(--tx-4)',
    marginBottom: 6
  },
  helpText: {
    fontSize: 10.5,
    color: 'var(--tx-5)',
    lineHeight: 1.5,
    marginTop: 12,
    borderTop: '1px solid var(--bd-2)',
    paddingTop: 10
  },
  errText: { color: 'var(--st-error-bright)', fontSize: 11, marginTop: 8 },
  mutedValue: { fontSize: 11.5, color: 'var(--tx-4)' },
  authCmd: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    color: 'var(--tx-3)',
    background: 'var(--bg-input)',
    border: '1px solid var(--bd-field)',
    borderRadius: 'var(--r-chip)',
    padding: '2px 7px',
    whiteSpace: 'nowrap'
  },
  emptyNote: {
    fontSize: 11.5,
    color: 'var(--tx-4)',
    lineHeight: 1.55,
    padding: '14px 16px',
    background: 'var(--bg-panel)',
    border: '1px solid var(--bd-nav)',
    borderRadius: 8
  },
  // provider grouping
  providerGroup: { marginBottom: 6 },
  providerGroupHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '12px 0 4px'
  },
  providerVendor: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '.06em',
    textTransform: 'uppercase',
    color: 'var(--tx-4)'
  },
  // subsection heads (Key usage, Default servers, Check an agent)
  subHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    margin: '20px 0 10px'
  },
  subHeadTitle: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '.08em',
    textTransform: 'uppercase',
    color: 'var(--tx-3)'
  },
  // key-usage cards
  usageCard: {
    background: 'var(--bg-panel)',
    border: '1px solid var(--bd-nav)',
    borderRadius: 9,
    padding: '12px 14px'
  },
  usageHead: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10
  },
  usageLabel: { fontSize: 12, fontWeight: 700, color: 'var(--tx-hi)' },
  usageProvider: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    color: 'var(--tx-4)'
  },
  usageMuted: { fontSize: 11, color: 'var(--tx-5)' },
  usageExpiry: {
    marginTop: 10,
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--tx-4)'
  },
  barTop: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 4
  },
  barLabel: { fontSize: 11, color: 'var(--tx-2)' },
  barVal: { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--tx-3)' },
  barTrack: {
    height: 5,
    borderRadius: 3,
    background: 'var(--st-track-bg)',
    overflow: 'hidden'
  },
  barFill: { height: '100%', borderRadius: 3, transition: 'width .3s ease' },
  barReset: {
    marginTop: 3,
    fontSize: 9.5,
    fontFamily: 'var(--font-mono)',
    color: 'var(--tx-gutter)'
  },
  // default MCP cards
  mcpCard: {
    background: 'var(--bg-panel)',
    border: '1px solid var(--bd-nav)',
    borderRadius: 8,
    padding: '10px 12px'
  },
  mcpCardHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 },
  mcpName: { fontSize: 12, fontWeight: 700, color: 'var(--tx-1)' },
  transportBadge: {
    fontFamily: 'var(--font-mono)',
    fontSize: 9.5,
    letterSpacing: '.04em',
    color: 'var(--tx-4)',
    background: 'var(--bg-chip-idle)',
    border: '1px solid var(--bd-1)',
    borderRadius: 'var(--r-chip)',
    padding: '1px 5px'
  },
  mcpDetail: {
    display: 'block',
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    color: 'var(--tx-dim)',
    wordBreak: 'break-all'
  },
  mcpHint: { fontSize: 10.5, color: 'var(--tx-5)', lineHeight: 1.45, marginTop: 4 },
  mcpSummary: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    letterSpacing: '.04em'
  },
  mcpSummaryDot: { color: 'var(--tx-gutter)' },
  // storage — real workspace paths
  pathList: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 },
  pathRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    width: '100%',
    textAlign: 'left',
    background: 'transparent',
    border: 'none',
    borderRadius: 5,
    padding: '4px 6px',
    cursor: 'pointer',
    color: 'var(--tx-3)'
  },
  pathText: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  // about links
  linkBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: 'var(--bg-input)',
    border: '1px solid var(--bd-1)',
    borderRadius: 'var(--r-button)',
    color: 'var(--tx-2)',
    fontFamily: 'var(--font-sans)',
    fontSize: 11,
    fontWeight: 600,
    padding: '4px 9px',
    cursor: 'pointer'
  }
}

const CSS = `
.sv2-nav-item:hover { color: var(--tx-2) !important; }
.sv2-input:focus { border-color: var(--accent) !important; }
.sv2-select:focus { border-color: var(--accent) !important; }
.sv2-input::placeholder { color: var(--tx-faint); }
.sv2-select option { background: var(--bg-elev); color: var(--tx-1); }
.sv2-path:hover { background: var(--bg-selected) !important; color: var(--tx-1) !important; }
.sv2-link:hover { border-color: var(--accent) !important; color: var(--tx-1) !important; }
`
