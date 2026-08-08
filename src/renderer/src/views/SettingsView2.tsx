import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Icon, StatusDot } from '@renderer/ui'

/**
 * 2h — Settings, sectioned (replaces the legacy SettingsView).
 *
 * A 208px settings-nav on the left + a single scrolling, sectioned form on the
 * right. Nav items scroll to / highlight their section; every control shows a
 * REAL default so nothing reads as an empty zero.
 *
 * Backing reality (CURRENT-APP.md §1h + §1g):
 *   - The ONLY app preference the main process persists today is `officeBaseUrl`
 *     (getSettings/setSettings). That drives the "Pixel Office" section, which is
 *     the one fully-wired, Save-gated control.
 *   - officeStatus()/officeOffices() give the live connection badge + office count.
 *   - Everything else (agent-default provider, task timeout, retry, rate-limit
 *     fallback, agents folder, keep-loops-running, MCP, notifications, storage)
 *     has NO persistence surface yet — those controls render sensible defaults
 *     and are marked // TODO(redesign) so Stage 3 can wire real storage.
 */

type SectionId =
  | 'agent-defaults'
  | 'providers'
  | 'pixel-office'
  | 'mcp'
  | 'notifications'
  | 'storage'
  | 'about'

const NAV: { id: SectionId; label: string }[] = [
  { id: 'agent-defaults', label: 'Agent defaults' },
  { id: 'providers', label: 'Providers' },
  { id: 'pixel-office', label: 'Pixel Office' },
  { id: 'mcp', label: 'MCP' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'storage', label: 'Storage & logs' },
  { id: 'about', label: 'About' }
]

// Provider ids the app actually recognises (AgentState.provider). Labels frame the
// interactive-vs-headless distinction the mockup calls out.
const PROVIDER_OPTS: { value: string; label: string }[] = [
  { value: 'grok-cli', label: 'Grok — interactive' },
  { value: 'claude-tui', label: 'Claude — interactive' },
  { value: 'opencode-sdk', label: 'OpenCode — headless' },
  { value: 'copilot-sdk', label: 'Copilot — headless' }
]

interface OfficeStatus {
  connected: boolean
  base: string
  email?: string
}

export function SettingsView2(): JSX.Element {
  const [active, setActive] = useState<SectionId>('agent-defaults')

  // --- REAL, persisted preference: Pixel Office server URL ---------------------
  const [base, setBase] = useState('')
  const [savedBase, setSavedBase] = useState('')
  const [defaultBase, setDefaultBase] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedPulse, setSavedPulse] = useState(false)
  const [urlErr, setUrlErr] = useState('')

  // --- REAL, live connection signal for the Pixel Office card header ----------
  const [status, setStatus] = useState<OfficeStatus | null>(null)
  const [officeCount, setOfficeCount] = useState<number | null>(null)

  // --- Aspirational, NOT-YET-PERSISTED agent defaults -------------------------
  // TODO(redesign): no getSettings field backs any of these — they live in local
  // state only. Stage 3 should extend settings:get/set (or a per-provider store).
  const [provider, setProvider] = useState('grok-cli')
  const [timeoutMin, setTimeoutMin] = useState(30)
  const [retryOnTimeout, setRetryOnTimeout] = useState(true)
  const [fallbackProvider, setFallbackProvider] = useState('claude-tui')
  const [agentsFolder, setAgentsFolder] = useState('~/.autodev-app/offices')
  const [keepLoops, setKeepLoops] = useState(true)
  // Notifications (aspirational)
  const [notifyNeedsYou, setNotifyNeedsYou] = useState(true)
  const [notifyDone, setNotifyDone] = useState(false)
  const [notifyErrors, setNotifyErrors] = useState(true)

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
  }, [])

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

  const urlDirty = base.trim() !== savedBase.trim()
  const urlInvalid = !looksValid(base)

  const browseFolder = useCallback(async () => {
    // TODO(redesign): no directory-picker api is exposed in the preload surface
    // (CURRENT-APP.md lists no dialog:pickFolder). Left inert until Stage 3 adds
    // one; the field remains editable so the value is never lost.
  }, [])

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
          {/* TODO(redesign): no api exposes the app/CLI version. cli:check returns
              {found,path} only. Stage 3 should surface real versions. */}
          <div>autodev-app —</div>
          <div>cli —</div>
        </div>
      </nav>

      {/* right sectioned form (flex, scrolls) */}
      <div ref={contentRef} style={S.content}>
        <div style={S.inner}>
          {/* ── Agent defaults ─────────────────────────────────────────── */}
          <Section
            id="agent-defaults"
            innerRef={setRef('agent-defaults')}
            title="Agent defaults"
            subtitle="Applied to every new agent. Override any of these during setup."
          >
            <SettingRow
              label="Provider"
              desc="Interactive gives a terminal you can watch and steer; headless runs quiet."
            >
              <Dropdown value={provider} onChange={setProvider} options={PROVIDER_OPTS} />
            </SettingRow>

            <SettingRow
              label="Task timeout"
              desc="How long a single task may run before the loop intervenes."
            >
              <Slider
                min={5}
                max={120}
                step={5}
                value={timeoutMin}
                onChange={setTimeoutMin}
                format={(v) => `${v} min`}
              />
            </SettingRow>

            <SettingRow label="Retry on timeout" desc="Re-issue the task once if it times out.">
              <Toggle checked={retryOnTimeout} onChange={setRetryOnTimeout} label="Retry on timeout" />
            </SettingRow>

            <SettingRow
              label="Fall back to another provider on rate limit"
              desc="When the primary provider is rate-limited, continue on this one."
            >
              <Dropdown
                value={fallbackProvider}
                onChange={setFallbackProvider}
                options={[{ value: '', label: 'None' }, ...PROVIDER_OPTS]}
              />
            </SettingRow>

            <SettingRow
              label="Agents folder"
              desc="Where new agent workspaces are created on this machine."
            >
              <div style={{ display: 'flex', gap: 6, width: '100%' }}>
                <input
                  className="sv2-input"
                  value={agentsFolder}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(e) => setAgentsFolder(e.target.value)}
                  style={{ ...S.input, fontFamily: 'var(--font-mono)', flex: 1, minWidth: 0 }}
                />
                <Button variant="secondary" size="sm" onClick={() => void browseFolder()}>
                  Browse
                </Button>
              </div>
            </SettingRow>

            <SettingRow
              label="Keep loops running when window closes"
              desc="Agents keep working in the background; reopen to reattach."
              last
            >
              <Toggle
                checked={keepLoops}
                onChange={setKeepLoops}
                label="Keep loops running when window closes"
              />
            </SettingRow>

            {/* TODO(redesign): the six rows above are UI-only — settings:set accepts
                only { officeBaseUrl }. They do not persist yet. */}
            <div style={S.notPersistedNote}>
              These defaults are not saved yet — the app only persists the Pixel Office
              URL below. Wiring is Stage 3.
            </div>
          </Section>

          {/* ── Providers ──────────────────────────────────────────────── */}
          <Section
            id="providers"
            innerRef={setRef('providers')}
            title="Providers"
            subtitle="Which coding models this machine can launch. Credentials are managed per provider."
          >
            {/* TODO(redesign): no api enumerates configured providers or their auth
                state. This mirrors the known provider ids as a static reference. */}
            {PROVIDER_OPTS.map((p, i) => (
              <SettingRow
                key={p.value}
                label={p.label}
                desc={p.value}
                last={i === PROVIDER_OPTS.length - 1}
              >
                <span style={S.mutedValue}>installed</span>
              </SettingRow>
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

              <label htmlFor="sv2-office-url" style={S.fieldLabel}>
                SERVER URL
              </label>
              <input
                id="sv2-office-url"
                className="sv2-input"
                value={base}
                disabled={!loaded}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder={defaultBase || 'https://…'}
                onChange={(e) => {
                  setBase(e.target.value)
                  setUrlErr('')
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
              </div>

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
          <Section
            id="mcp"
            innerRef={setRef('mcp')}
            title="MCP"
            subtitle="Model Context Protocol servers shared with new agents."
          >
            {/* TODO(redesign): MCP config is authored per-workspace (.mcp.json via
                officeWriteSharedMcp) — there is no app-global MCP preference api. */}
            <div style={S.emptyNote}>
              MCP servers are configured per office / per workspace, not app-wide. Manage
              them from an office’s setup. No global MCP preference is stored yet.
            </div>
          </Section>

          {/* ── Notifications ──────────────────────────────────────────── */}
          <Section
            id="notifications"
            innerRef={setRef('notifications')}
            title="Notifications"
            subtitle="When the app should surface a desktop notification."
          >
            {/* TODO(redesign): no api persists notification prefs; UI-only for now. */}
            <SettingRow label="An agent needs you" desc="Asked a question or awaiting a choice.">
              <Toggle checked={notifyNeedsYou} onChange={setNotifyNeedsYou} label="Needs-you notifications" />
            </SettingRow>
            <SettingRow label="A task finished" desc="An agent completed its backlog.">
              <Toggle checked={notifyDone} onChange={setNotifyDone} label="Task-done notifications" />
            </SettingRow>
            <SettingRow label="Errors & timeouts" desc="A loop failed, timed out, or hit a rate limit." last>
              <Toggle checked={notifyErrors} onChange={setNotifyErrors} label="Error notifications" />
            </SettingRow>
            <div style={S.notPersistedNote}>Not saved yet — wiring is Stage 3.</div>
          </Section>

          {/* ── Storage & logs ─────────────────────────────────────────── */}
          <Section
            id="storage"
            innerRef={setRef('storage')}
            title="Storage & logs"
            subtitle="Where this app keeps workspaces and diagnostic logs on this machine."
          >
            {/* TODO(redesign): no api exposes log locations, sizes, or a clear action. */}
            <SettingRow label="Agents folder" desc="Workspace root for new agents.">
              <span style={{ ...S.mutedValue, fontFamily: 'var(--font-mono)' }}>{agentsFolder}</span>
            </SettingRow>
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
            {/* TODO(redesign): version strings need an api (cli:check returns only
                {found,path}; no app-version channel). Showing what we can. */}
            <SettingRow label="Application" desc="AutoDev desktop">
              <span style={{ ...S.mutedValue, fontFamily: 'var(--font-mono)' }}>autodev-app</span>
            </SettingRow>
            <SettingRow label="CLI" desc="Bundled autodev CLI" last>
              <span style={{ ...S.mutedValue, fontFamily: 'var(--font-mono)' }}>autodev-cli</span>
            </SettingRow>
          </Section>
        </div>
      </div>
    </div>
  )
}

/* ── local subcomponents ─────────────────────────────────────────────────── */

function Section(props: {
  id: string
  innerRef: (el: HTMLElement | null) => void
  title: string
  subtitle: string
  last?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <section
      id={props.id}
      ref={props.innerRef}
      style={{ scrollMarginTop: 12, marginBottom: props.last ? 0 : 34 }}
    >
      <h2 style={S.sectionTitle}>{props.title}</h2>
      <p style={S.sectionSub}>{props.subtitle}</p>
      <div>{props.children}</div>
    </section>
  )
}

function SettingRow(props: {
  label: string
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

function Toggle(props: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}): JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      onClick={() => props.onChange(!props.checked)}
      style={{
        position: 'relative',
        width: 32,
        height: 18,
        borderRadius: 999,
        border: '1px solid var(--bd-1)',
        background: props.checked ? 'var(--accent)' : 'var(--bg-input)',
        cursor: 'pointer',
        padding: 0,
        transition: 'background .12s ease',
        flexShrink: 0
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 1,
          left: props.checked ? 15 : 1,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: 'var(--bg-0)',
          transition: 'left .12s ease'
        }}
      />
    </button>
  )
}

function Dropdown(props: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}): JSX.Element {
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <select
        className="sv2-select"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        style={S.select}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span style={S.selectCaret} aria-hidden>
        <Icon name="chevron" size={12} />
      </span>
    </div>
  )
}

function Slider(props: {
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  format: (v: number) => string
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
      <input
        className="sv2-range"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ flex: 1, minWidth: 0 }}
      />
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--tx-2)',
          minWidth: 46,
          textAlign: 'right'
        }}
      >
        {props.format(props.value)}
      </span>
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
  notPersistedNote: {
    fontSize: 10.5,
    color: 'var(--tx-5)',
    lineHeight: 1.5,
    marginTop: 12,
    fontStyle: 'italic'
  },
  emptyNote: {
    fontSize: 11.5,
    color: 'var(--tx-4)',
    lineHeight: 1.55,
    padding: '14px 16px',
    background: 'var(--bg-panel)',
    border: '1px solid var(--bd-nav)',
    borderRadius: 8
  }
}

const CSS = `
.sv2-nav-item:hover { color: var(--tx-2) !important; }
.sv2-input:focus { border-color: var(--accent) !important; }
.sv2-select:focus { border-color: var(--accent) !important; }
.sv2-input::placeholder { color: var(--tx-faint); }
.sv2-range {
  -webkit-appearance: none; appearance: none;
  height: 3px; border-radius: 2px;
  background: var(--st-track-bg);
  outline: none; cursor: pointer;
}
.sv2-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--accent); border: none; cursor: pointer;
}
.sv2-range::-moz-range-thumb {
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--accent); border: none; cursor: pointer;
}
.sv2-select option { background: var(--bg-elev); color: var(--tx-1); }
`
