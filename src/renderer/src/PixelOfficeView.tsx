import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import TerminalTabs, { OpenTerm } from './TerminalTabs'

interface OfficeAgent {
  office: string; officeSlug: string; id: string; name: string; slug: string; status?: string; online: boolean
  provider?: string; model?: string
}

/** One office grouped from the flat agent list, with its per-office online summary. */
interface OfficeGroup { slug: string; name: string; agents: OfficeAgent[]; onlineCount: number }

/** Descriptor for each TRACKED LOOP spawnOffice starts (main-process contract).
 *  `path` is the loop's workspace = the key into the `agent:log` stream buffer. */
interface SpawnAgent { agentId: string; agentSlug: string; name: string; path: string; provider: string; officeSlug: string }
type SpawnResult = { ok: true; agents: SpawnAgent[] } | { error: string; online?: string[] }
/** Provider override per character, forwarded to each loop's `autodev start -p`. */
interface SpawnOverride { agentId: string; provider: string }

/**
 * Prepare + start EVERY character in an office as a TRACKED AgentManager LOOP
 * (headless, log-streamed — NOT an interactive PTY). Returns the tracked agents so
 * the renderer can auto-open a read-only live log pane per character. Typed locally
 * (the preload bridge may not yet carry the overrides arg / the loop return shape).
 */
function officeSpawnOffice(officeSlug: string, overrides?: SpawnOverride[]): Promise<SpawnResult> {
  return (window.api as unknown as {
    officeSpawnOffice: (s: string, o?: SpawnOverride[]) => Promise<SpawnResult>
  }).officeSpawnOffice(officeSlug, overrides)
}

/** Stop every tracked loop of an office (and drop its scratch). Locally typed —
 *  `officeStopOffice` may not yet be on the preload `Api` surface. */
function officeStopOffice(officeSlug: string): Promise<{ ok?: boolean; stopped?: number; error?: string }> {
  return (window.api as unknown as {
    officeStopOffice: (s: string) => Promise<{ ok?: boolean; stopped?: number; error?: string }>
  }).officeStopOffice(officeSlug)
}

/** Provider override options offered per character (value passed straight to the
 *  loop's `-p` / the operate CLI). Empty value = use the agent's own provider. */
const PROVIDER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'claude', label: 'Claude' },
  { value: 'grok', label: 'Grok' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'copilot', label: 'Copilot' }
]

/** Map an office agent's provider (family OR a -cli/-tui/-sdk variant) to the
 *  interactive CLI to launch. Mirrors the main-process providerCommand so a
 *  single-character Operate uses the SAME command as a full office spawn. */
function providerToCommand(provider?: string): string {
  const p = String(provider ?? '').toLowerCase()
  const exact: Record<string, string> = {
    'grok-tui': 'grok', 'claude-cli': 'claude', 'opencode-cli': 'opencode', 'copilot-cli': 'copilot'
  }
  if (exact[p]) return exact[p]
  if (p.startsWith('grok')) return 'grok'
  if (p.startsWith('opencode')) return 'opencode'
  if (p.startsWith('copilot')) return 'copilot'
  if (p.startsWith('claude')) return 'claude'
  return 'claude'
}

/** True when an error means the session is dead and the user must sign in again. */
function isAuthError(msg: string): boolean {
  return /expired|reconnect|not connected|unauthenticated|\b401\b|\b419\b/i.test(msg)
}

export default function PixelOfficeView({ visible = true }: { visible?: boolean }): JSX.Element {
  const [connected, setConnected] = useState(false)
  // Seeded from officeStatus().base (which resolves to the configured Settings
  // base when no session is live) in the mount effect below — no hardcoded host.
  const [base, setBase] = useState('')
  const [basePlaceholder, setBasePlaceholder] = useState('https://…')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')           // login-form error
  const [listErr, setListErr] = useState('')    // agents-list / operate error (connected view)
  const [agents, setAgents] = useState<OfficeAgent[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadingAgents, setLoadingAgents] = useState(false)
  const [operatingId, setOperatingId] = useState('')       // single ▶ button spinner
  const [spawningOffice, setSpawningOffice] = useState('') // per-office ⚡ Spawn button spinner (officeSlug)
  const [stoppingOffice, setStoppingOffice] = useState('') // per-office ⏹ Stop button spinner (officeSlug)
  // Offices we have spawned as tracked loops this session — so a freshly-spawned
  // office shows ⏹ Stop immediately, before the 8s office-presence poll flips its
  // characters to online. Cleared on Stop office / logout.
  const [spawnedOffices, setSpawnedOffices] = useState<Set<string>>(new Set())
  // Per-character provider override (rid = officeSlug+id). '' = use agent's own.
  const [providerOverride, setProviderOverride] = useState<Record<string, string>>({})
  // Multi-pane model: one OpenTerm per operated (pty) or spawned (log) character.
  const [terms, setTerms] = useState<OpenTerm[]>([])
  const [activeTermId, setActiveTermId] = useState('')     // which tab is visible
  const [endedIds, setEndedIds] = useState<Set<string>>(new Set()) // pty terms whose provider exited

  // ── Read-only live log stream (reuses the SAME `agent:log` IPC the sidebar uses).
  // Buffer keyed by workspace path; log panes read it via getLog and re-render only
  // themselves on each tick, so a log storm never re-renders this whole view.
  const logsRef = useRef<Map<string, string>>(new Map())
  const logListeners = useRef<Set<() => void>>(new Set())
  const subscribeLog = useCallback((cb: () => void) => {
    logListeners.current.add(cb)
    return () => { logListeners.current.delete(cb) }
  }, [])
  const getLog = useCallback((path: string) => logsRef.current.get(path) || '', [])
  useEffect(() => {
    const off = window.api.onAgentLog(({ path, line }) => {
      const prev = logsRef.current.get(path) || ''
      let next = prev + line
      if (next.length > 20000) next = next.slice(next.length - 20000) // cap the buffer
      logsRef.current.set(path, next)
      logListeners.current.forEach((cb) => cb())
    })
    return () => { off?.() }
  }, [])
  // Instant-message (steer) composer for the operated office character.
  const [steerText, setSteerText] = useState('')
  const [steerBusy, setSteerBusy] = useState(false)
  const [steerMsg, setSteerMsg] = useState('')
  // "New character" (spawn an office agent from the app).
  const [offices, setOffices] = useState<{ slug: string; id: number; name: string }[]>([])
  const [newCharName, setNewCharName] = useState('')
  const [newCharOffice, setNewCharOffice] = useState<number | ''>('')
  const [creatingChar, setCreatingChar] = useState(false)
  const [showNewChar, setShowNewChar] = useState(false)  // create-character form collapsed by default
  const [createMsg, setCreateMsg] = useState('')
  const inFlight = useRef(false)
  // Mirror `terms` into a ref so the background poll can tell whether ANY live PTY
  // is running WITHOUT re-creating (and re-scheduling) itself on every open/close.
  const termsRef = useRef<OpenTerm[]>([])
  useEffect(() => { termsRef.current = terms }, [terms])

  // Fold the flat agent list into offices (agents already carry office/officeSlug —
  // pure client-side derive, no backend change) with a per-office online summary.
  const grouped = useMemo<OfficeGroup[]>(() => {
    const m = new Map<string, OfficeGroup>()
    for (const a of agents) {
      let g = m.get(a.officeSlug)
      if (!g) { g = { slug: a.officeSlug, name: a.office, agents: [], onlineCount: 0 }; m.set(a.officeSlug, g) }
      g.agents.push(a)
      if (a.online) g.onlineCount++
    }
    return [...m.values()]
  }, [agents])

  // Agent ids currently online — feeds the per-tab live badge in TerminalTabs.
  const onlineAgentIds = useMemo(() => new Set(agents.filter((a) => a.online).map((a) => a.id)), [agents])

  const EXPIRED = 'Your office session expired — please sign in again.'

  const loadAgents = useCallback(async () => {
    setLoadingAgents(true); setListErr('')
    try {
      setAgents((await window.api.officeAgents()) as OfficeAgent[])
      setLoaded(true)
      // Populate the office picker for "New character" (best-effort; the list
      // still works without it).
      try {
        const offs = (await window.api.officeOffices()) as { slug: string; id: number; name: string }[]
        setOffices(offs)
        setNewCharOffice((prev) => (prev === '' && offs[0] ? offs[0].id : prev))
      } catch { /* non-fatal */ }
    } catch (e: any) {
      const msg = e?.message || 'Failed to load agents'
      if (isAuthError(msg)) {
        // Try one silent recovery with the durable token before demanding a
        // password; only bounce to the login form (with a shown reason) if it
        // fails. Previously the reason went to listErr, which the login form
        // never renders — the user landed on a blank Connect screen.
        try {
          if (await window.api.officeAutoConnect()) {
            setAgents((await window.api.officeAgents()) as OfficeAgent[])
            setLoaded(true); setLoadingAgents(false); return
          }
        } catch { /* fall through to login */ }
        // Don't tear down a live operate/resume PTY (see pollAgents): it holds its
        // own office key. Show a soft hint instead of bouncing to the login form.
        if (termsRef.current.length) { setListErr('Office session needs reconnect — your running session is unaffected (use ↻ or ⏻ Disconnect).'); setLoadingAgents(false); return }
        setConnected(false); setLoaded(false); setErr(EXPIRED)
      } else {
        setListErr(msg)
      }
    }
    setLoadingAgents(false)
  }, [])

  // Silent background refresh so online dots stay fresh (esp. right after
  // Operate) without flashing the "Loading…" state or clobbering a shown error.
  const pollAgents = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      setAgents((await window.api.officeAgents()) as OfficeAgent[])
      setLoaded(true)
    } catch (e: any) {
      // A mid-session expiry (401) must NOT be swallowed — otherwise the view
      // keeps showing frozen green "online" dots for dead agents indefinitely and
      // never prompts a reconnect. Attempt one silent recovery with the durable
      // token; if that fails, bounce to the login form (the same branch loadAgents
      // uses) so stale online state stops being presented. Transient network
      // errors still fall through and keep the last-known list for the next tick.
      const msg = e?.message || ''
      if (isAuthError(msg)) {
        let recovered = false
        try { recovered = !!(await window.api.officeAutoConnect()) } catch { /* fall through */ }
        if (recovered) {
          try { setAgents((await window.api.officeAgents()) as OfficeAgent[]); setLoaded(true); return }
          catch { /* fall through to the bounce/guard below */ }
        }
        // A running operate/resume PTY authenticates via the office API key baked
        // into its own .mcp.json — independent of this browser cookie. A routine
        // list-refresh auth bounce must NEVER swap the view to the login form and
        // unmount (SIGKILL) that live session. Surface a soft reconnect hint and
        // leave the terminal running; the user can ↻/Reconnect deliberately.
        if (termsRef.current.length) { setListErr('Office session needs reconnect — your running session is unaffected (use ↻ or ⏻ Disconnect).'); return }
        setConnected(false); setLoaded(false); setErr(EXPIRED)
      }
    }
    finally { inFlight.current = false }
  }, [])

  // While connected AND on-screen, poll every 8s and on window focus; cleared on
  // disconnect or when the view is hidden. The view now stays mounted across tab
  // switches (so its live Operate PTY survives), so gating on `visible` stops a
  // hidden tab from polling in the background.
  useEffect(() => {
    if (!connected || !visible) return
    const id = setInterval(pollAgents, 8000)
    const onFocus = (): void => { void pollAgents() }
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus) }
  }, [connected, visible, pollAgents])

  useEffect(() => {
    (async () => {
      const cfg = (await window.api.getSettings()) as { officeBaseUrl?: string }
      if (cfg.officeBaseUrl) setBasePlaceholder(cfg.officeBaseUrl)
      const st = (await window.api.officeStatus()) as { connected: boolean; base: string; email?: string }
      if (st.base) setBase(st.base); if (st.email) setEmail(st.email)
      const ok = st.connected || (await window.api.officeAutoConnect())
      setConnected(!!ok)
      if (ok) loadAgents()
    })()
  }, [loadAgents])

  const connect = useCallback(async () => {
    setBusy(true); setErr('')
    const r = (await window.api.officeLogin(base, email, password)) as { ok?: boolean; error?: string }
    setBusy(false)
    if (r?.error) { setErr(r.error); return }
    setPassword(''); setConnected(true); loadAgents()
  }, [base, email, password, loadAgents])

  const disconnect = useCallback(async () => {
    await window.api.officeLogout()
    setConnected(false); setAgents([]); setLoaded(false)
    // Clearing panes only tears down the VIEW. PTY (operate) panes SIGKILL on
    // unmount; tracked LOOP (log) panes keep running in the background (they live in
    // AgentManager / the Agents tab) — logging out of the office does not stop them.
    setTerms([]); setActiveTermId(''); setEndedIds(new Set()); setListErr('')
    setSpawnedOffices(new Set())
  }, [])

  // Focus an existing tab, or append+focus a new one, and clear any ended flag.
  const openTerm = useCallback((t: OpenTerm) => {
    setTerms((prev) => prev.some((x) => x.id === t.id) ? prev : [...prev, t])
    setActiveTermId(t.id)
    setEndedIds((prev) => { const n = new Set(prev); n.delete(t.id); return n })
  }, [])

  // Operate a SINGLE character — deterministic per-agent id means re-operate just
  // re-focuses the existing tab instead of duplicating it.
  const operate = useCallback(async (a: OfficeAgent) => {
    const rid = a.officeSlug + a.id
    const id = `op-${a.officeSlug}-${a.id}`
    // If a live (non-ended) tab already exists for this agent, just focus it.
    if (terms.some((t) => t.id === id) && !endedIds.has(id)) { setActiveTermId(id); return }
    if (operatingId === rid) return // duplicate click guard for this same agent
    setListErr(''); setOperatingId(rid)
    try {
      const r = (await window.api.officeOperate(a.officeSlug, a.id, a.slug)) as { ok?: boolean; cwd?: string; mcpUrl?: string; error?: string }
      if (r?.error || !r?.cwd) {
        // Don't swallow a 401 as a generic list error — the session is dead, so
        // bounce to the login form with a reason instead of staying falsely
        // connected while every subsequent call also 401s.
        if (r?.error && isAuthError(r.error)) { setConnected(false); setLoaded(false); setErr(EXPIRED) }
        else setListErr(r?.error || 'Could not prepare the operate workspace')
        return
      }
      const prov = providerOverride[rid] || a.provider
      openTerm({ id, kind: 'pty', cwd: r.cwd, mcpUrl: r.mcpUrl, name: `${a.name} · ${a.office}`, agentId: a.id, command: providerToCommand(prov), provider: prov })
      // Reconcile the left-list online dot within one tick rather than waiting up
      // to 8s for the next poll (silent — no "Loading…" flash).
      void pollAgents()
    } finally { setOperatingId('') }
  }, [terms, endedIds, operatingId, openTerm, pollAgents, providerOverride])

  // Spawn the WHOLE office as TRACKED LOOPS: each character starts as an
  // AgentManager loop (headless, log-streamed — NOT a PTY) and auto-opens a
  // read-only live LOG pane. Refuses (BLOCK-IF-ANY-ONLINE) when any character is
  // already connected, naming who is online. Provider overrides are forwarded.
  const spawnOffice = useCallback(async (g: OfficeGroup) => {
    if (g.onlineCount > 0 || spawningOffice) return
    setListErr(''); setSpawningOffice(g.slug)
    try {
      const overrides: SpawnOverride[] = g.agents.map((a) => ({
        agentId: a.id, provider: providerOverride[a.officeSlug + a.id] || a.provider || ''
      }))
      const r = await officeSpawnOffice(g.slug, overrides)
      if ('error' in r) {
        // Main-process blocks all-or-nothing and hands back who is online.
        const who = r.online && r.online.length ? ` (online: ${r.online.join(', ')})` : ''
        if (isAuthError(r.error)) { setConnected(false); setLoaded(false); setErr(EXPIRED) }
        else setListErr(r.error + who)
        return
      }
      // Remember we spawned this office so it shows ⏹ Stop right away (before the
      // office-presence poll flips characters to online).
      setSpawnedOffices((prev) => new Set(prev).add(g.slug))
      let firstId = ''
      for (const s of r.agents) {
        const id = `log-${g.slug}-${s.agentId}`
        if (!firstId) firstId = id
        // Seed the buffer key so the pane renders immediately, then stream via IPC.
        if (!logsRef.current.has(s.path)) logsRef.current.set(s.path, '')
        openTerm({ id, kind: 'log', name: `${s.name} · ${g.name}`, agentId: s.agentId, path: s.path, provider: s.provider })
      }
      if (firstId) setActiveTermId(firstId) // focus the first spawned character
      void pollAgents()
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (isAuthError(msg)) { setConnected(false); setLoaded(false); setErr(EXPIRED) }
      else setListErr(msg)
    } finally { setSpawningOffice('') }
  }, [spawningOffice, openTerm, pollAgents, providerOverride])

  // Stop the WHOLE office: stops every tracked loop (and drops its scratch) via the
  // main process, then removes this office's read-only log panes from the view.
  const stopOffice = useCallback(async (g: OfficeGroup) => {
    if (stoppingOffice) return
    setListErr(''); setStoppingOffice(g.slug)
    try {
      const r = await officeStopOffice(g.slug)
      if (r?.error) {
        if (isAuthError(r.error)) { setConnected(false); setLoaded(false); setErr(EXPIRED) }
        else setListErr(r.error)
        return
      }
      setSpawnedOffices((prev) => { const n = new Set(prev); n.delete(g.slug); return n })
      // Drop this office's LOG panes (loops are gone); leave any operate PTY panes.
      const prefix = `log-${g.slug}-`
      setTerms((prev) => {
        const next = prev.filter((t) => !(t.kind === 'log' && t.id.startsWith(prefix)))
        setActiveTermId((cur) => (cur.startsWith(prefix) ? (next[next.length - 1]?.id ?? '') : cur))
        return next
      })
      void pollAgents()
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (isAuthError(msg)) { setConnected(false); setLoaded(false); setErr(EXPIRED) }
      else setListErr(msg)
    } finally { setStoppingOffice('') }
  }, [stoppingOffice, pollAgents])

  // Send an INSTANT message (steer) to the operated office character — live, not a
  // queued TODO task (that is the local-agent composer's job).
  const sendSteer = useCallback(async () => {
    const t = termsRef.current.find((x) => x.id === activeTermId)
    const text = steerText.trim()
    if (!t || !text || steerBusy) return
    setSteerBusy(true); setSteerMsg('')
    try {
      const r = (await window.api.officeSteer(t.agentId, text)) as { ok?: boolean; error?: string }
      if (r?.ok) { setSteerText(''); setSteerMsg('⚡ delivered') }
      else setSteerMsg(r?.error || 'Could not deliver — is the character online?')
    } catch (e) { setSteerMsg(String((e as Error)?.message ?? e)) }
    finally { setSteerBusy(false) }
  }, [steerText, steerBusy, activeTermId])

  // Spawn a new office character from the app (the in-app "+ Agent"), then refresh
  // the list so the user can Operate it right away.
  const createChar = useCallback(async () => {
    const name = newCharName.trim()
    if (!name || newCharOffice === '' || creatingChar) return
    setCreatingChar(true); setCreateMsg('')
    try {
      const r = (await window.api.officeCreateCharacter(Number(newCharOffice), name)) as { ok?: boolean; error?: string }
      if (r?.ok) { setNewCharName(''); setCreateMsg(`✓ created “${name}”`); void loadAgents() }
      else setCreateMsg(r?.error || 'Could not create the character')
    } catch (e) { setCreateMsg(String((e as Error)?.message ?? e)) }
    finally { setCreatingChar(false) }
  }, [newCharName, newCharOffice, creatingChar, loadAgents])

  // ── not connected: login form ──
  if (!connected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <form onSubmit={(e) => { e.preventDefault(); void connect() }} style={{ width: 340, background: '#111725', border: '1px solid var(--border)', borderRadius: 10, padding: 20 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>☁ Connect to your Pixel Office</h2>
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--muted,#8b949e)' }}>A Pixel Office is your team of remote agents. Sign in to list and operate them.</p>
          <label className="fld" htmlFor="office-base">Server URL</label>
          <input id="office-base" value={base} onChange={(e) => setBase(e.target.value)} placeholder={basePlaceholder} style={inp} />
          <label className="fld" htmlFor="office-email">Email</label>
          <input id="office-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={inp} />
          <label className="fld" htmlFor="office-password">Password</label>
          <input id="office-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={inp} />
          {err && <div role="alert" style={{ color: '#ff8b80', fontSize: 12, margin: '6px 0' }}>{err}</div>}
          <button className="primary" type="submit" style={{ width: '100%', marginTop: 10 }} disabled={busy || !email || !password || !base}>{busy ? 'Connecting…' : 'Connect'}</button>
          <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--muted,#8b949e)' }}>
            New here? <a href="#" onClick={(e) => { e.preventDefault(); if (base.trim()) void window.api.openExternal(base.trim()) }} style={{ color: 'var(--accent)' }}>Open the office</a> to create an account. Stores the durable login token locally (not your password).
          </p>
        </form>
      </div>
    )
  }

  // ── connected: agents (left) + operate terminal (right) ──
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ width: 320, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 13 }}>☁ Offices</strong>
          <span className="badge" title={`${grouped.length} office(s) · ${agents.length} character(s)`}>{grouped.length}·{agents.length}</span>
          <div style={{ flex: 1 }} />
          <button className="start" onClick={() => setShowNewChar((s) => !s)} aria-expanded={showNewChar} aria-controls="new-char-form" title="Create a new office character">＋ New</button>
          <button onClick={loadAgents} disabled={loadingAgents} title="Refresh office agents" aria-label="Refresh office agents">↻</button>
          <button className="danger" title="Disconnect from office" aria-label="Disconnect from office"
            onClick={() => { const ptys = terms.filter((t) => t.kind === 'pty').length; if (ptys && !window.confirm(`Disconnect will end your ${ptys} running Operate session(s) and take those characters offline. Tracked loops keep running. Continue?`)) return; disconnect() }}>⏻</button>
        </div>
        {/* Clarify the direction: this pane runs an OFFICE character locally — the
            reverse of the Agents tab's "Connect to office" (which pushes a local
            agent up into an office). */}
        <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--muted,#8b949e)', lineHeight: 1.4, borderBottom: '1px solid var(--border)' }}>
          Run one of your office characters as a live agent on this machine — the reverse of connecting a local agent up to an office.
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {/* Spawn a new office character from the app (goal: "spawn agents from
              the app") — creates the character server-side, then Operate it.
              Collapsed by default so the agent list is the primary content. */}
          {showNewChar && <form
            id="new-char-form"
            onSubmit={(e) => { e.preventDefault(); void createChar() }}
            style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}
          >
            <input
              value={newCharName}
              onChange={(e) => { setNewCharName(e.target.value); if (createMsg) setCreateMsg('') }}
              placeholder="New character name…"
              aria-label="New character name"
              maxLength={20}
              disabled={creatingChar}
              className="fld-input"
              style={{ flex: 1, minWidth: 110, background: '#0d1117', color: 'var(--fg,#e6edf3)', border: '1px solid var(--border,#30363d)', borderRadius: 6, padding: '6px 9px', fontSize: 12 }}
            />
            <select
              value={newCharOffice}
              onChange={(e) => setNewCharOffice(e.target.value ? Number(e.target.value) : '')}
              aria-label="Office for the new character"
              disabled={creatingChar || offices.length === 0}
              style={{ background: '#0d1117', color: 'var(--fg,#e6edf3)', border: '1px solid var(--border,#30363d)', borderRadius: 6, padding: '6px 8px', fontSize: 12 }}
            >
              {offices.length === 0 && <option value="">(no office)</option>}
              {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <button className="start" type="submit" disabled={creatingChar || !newCharName.trim() || newCharOffice === ''}>{creatingChar ? '…' : '＋ New character'}</button>
            {createMsg && <span style={{ flexBasis: '100%', fontSize: 11, color: createMsg.startsWith('✓') ? 'var(--green,#3fb950)' : '#f85149' }}>{createMsg}</span>}
          </form>}
          {listErr && (
            <div role="alert" style={{ margin: 10, padding: '8px 10px', background: '#3b0d0d', color: '#fecaca', fontSize: 12, borderRadius: 6, border: '1px solid #7f1d1d' }}>
              {listErr}
              <div style={{ marginTop: 6 }}>
                <button onClick={loadAgents}>↻ Retry</button>
                <button style={{ marginLeft: 6 }} onClick={disconnect}>Reconnect</button>
              </div>
            </div>
          )}
          {loadingAgents && <div className="empty" style={{ padding: 20, fontSize: 12 }}>Loading…</div>}
          {!loadingAgents && !listErr && loaded && agents.length === 0 && (
            <div className="empty" style={{ padding: 20, fontSize: 12 }}>No agents in your offices yet.</div>
          )}
          {/* Grouped BY OFFICE: office header (name + online summary + Spawn office)
              then its characters. Spawn office is BLOCK-IF-ANY-ONLINE. */}
          {grouped.map((g) => {
            // Running when any character is office-online OR we spawned loops this
            // session. BLOCK-IF-ANY-ONLINE: Spawn is enabled only when fully offline.
            const hasRunning = g.onlineCount > 0 || spawnedOffices.has(g.slug)
            const onlineNames = g.agents.filter((a) => a.online).map((a) => a.name)
            const spinning = spawningOffice === g.slug
            const stopping = stoppingOffice === g.slug
            return (
              <div key={g.slug}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#0d1117', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, zIndex: 1 }}>
                  <strong style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.name}</strong>
                  <span className="badge" style={{ background: g.onlineCount ? '#12351f' : '#21262d', color: g.onlineCount ? '#7ee2a0' : 'var(--muted,#8b949e)' }} title="online / total characters">{g.onlineCount}/{g.agents.length} online</span>
                  <div style={{ flex: 1 }} />
                  {hasRunning ? (
                    <button
                      className="danger"
                      onClick={() => stopOffice(g)}
                      disabled={stopping}
                      title="Stop every tracked loop in this office and drop its scratch workspace"
                    >{stopping ? 'stopping…' : '⏹ Stop office'}</button>
                  ) : (
                    <button
                      className="start"
                      onClick={() => spawnOffice(g)}
                      disabled={hasRunning || spinning}
                      title={hasRunning
                        ? `Blocked — already online: ${onlineNames.join(', ')}`
                        : 'Start every character in this office as a tracked loop (each auto-opens a read-only live log)'}
                    >{spinning ? 'spawning…' : '⚡ Spawn office'}</button>
                  )}
                </div>
                {g.agents.map((a) => {
                  const rid = a.officeSlug + a.id
                  const tid = `op-${a.officeSlug}-${a.id}`
                  const open = terms.some((t) => t.id === tid)
                  return (
                    <div key={rid} style={{ padding: '8px 12px 8px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="dot" style={{ background: a.online ? 'var(--green,#3fb950)' : '#484f58' }} title={a.online ? 'online' : 'offline'} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</div>
                        <select
                          value={providerOverride[rid] ?? ''}
                          onChange={(e) => setProviderOverride((p) => ({ ...p, [rid]: e.target.value }))}
                          aria-label={`Provider for ${a.name}`}
                          title="Provider override — used when spawning this character's loop or operating it (Default = its own provider)"
                          style={{ marginTop: 3, maxWidth: '100%', background: '#0d1117', color: 'var(--muted,#8b949e)', border: '1px solid var(--border,#30363d)', borderRadius: 5, padding: '2px 4px', fontSize: 11 }}
                        >
                          <option value="">Default{a.provider ? ` (${a.provider})` : ''}</option>
                          {PROVIDER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        {a.status && <span style={{ fontSize: 11, color: 'var(--muted,#8b949e)', marginLeft: 6 }}>{a.status}</span>}
                      </div>
                      <button className="start" onClick={() => operate(a)} disabled={operatingId === rid} title="Open an interactive terminal to watch/steer this character (uses the provider override)">{operatingId === rid ? 'operating…' : open ? '▸ Focus tab' : '▶ Connect & operate'}</button>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {terms.length === 0 && (
          <div className="empty" style={{ margin: 'auto', maxWidth: 440, textAlign: 'center', lineHeight: 1.6 }}>
            <div style={{ fontSize: 22 }}>⚡</div>
            <strong>Run your office characters here</strong><br />
            Hit <b>⚡ Spawn office</b> to start EVERY character as a tracked background
            loop (each auto-opens a read-only live log tab), or <b>▶ Connect &amp; operate</b>
            a single character in an interactive terminal to watch/steer it.
            <details style={{ marginTop: 12, fontSize: 11, color: 'var(--muted,#8b949e)', textAlign: 'left' }}>
              <summary style={{ cursor: 'pointer', textAlign: 'center' }}>What happens?</summary>
              <div style={{ marginTop: 6, lineHeight: 1.5 }}>
                Spawn starts each character as an AgentManager loop against a scratch
                workspace bound to its office-MCP — it comes online in the office and
                appears in the Agents tab, and keeps running in the background even if you
                close its log tab. Use <b>⏹ Stop office</b> to stop them. Spawning is
                blocked if any character is already online. Operate instead opens one
                interactive terminal (that ends when you close it).
              </div>
            </details>
          </div>
        )}
        {terms.length > 0 && (
          <>
            <TerminalTabs
              terms={terms}
              activeId={activeTermId}
              endedIds={endedIds}
              onlineAgentIds={onlineAgentIds}
              getLog={getLog}
              subscribeLog={subscribeLog}
              onSelect={setActiveTermId}
              onClose={(id) => {
                // Removing the term unmounts ONLY that pane -> ptyKill for its PTY.
                setTerms((prev) => {
                  const next = prev.filter((t) => t.id !== id)
                  setActiveTermId((cur) => (cur === id ? (next[next.length - 1]?.id ?? '') : cur))
                  return next
                })
                setEndedIds((prev) => { const n = new Set(prev); n.delete(id); return n })
              }}
              onExit={(id) => { setEndedIds((prev) => new Set(prev).add(id)); void pollAgents() }}
            />
            {/* Instant-message composer — steers the ACTIVE tab's character LIVE over
                its WS (POST /api/agents/{id}/steer), unlike the local-agent composer
                which only queues a TODO task. */}
            {(() => {
              const active = terms.find((t) => t.id === activeTermId)
              return (
                <form
                  onSubmit={(e) => { e.preventDefault(); void sendSteer() }}
                  style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--border)' }}
                >
                  <span title="Instant message — steers this character live (mid-turn if supported)" style={{ fontSize: 13 }}>⚡</span>
                  <input
                    value={steerText}
                    onChange={(e) => { setSteerText(e.target.value); if (steerMsg) setSteerMsg('') }}
                    placeholder={active ? `Instant-message ${active.name.split(' · ')[0]} now…  (Enter to send)` : 'Select a tab to message…'}
                    aria-label="Instant message to this office character"
                    disabled={steerBusy || !active}
                    className="fld-input"
                    style={{ flex: 1, background: '#0d1117', color: 'var(--fg,#e6edf3)', border: '1px solid var(--border,#30363d)', borderRadius: 6, padding: '7px 10px', fontSize: 13 }}
                  />
                  {steerMsg && <span style={{ fontSize: 11, color: steerMsg.startsWith('⚡') ? 'var(--green,#3fb950)' : '#f85149', whiteSpace: 'nowrap' }}>{steerMsg}</span>}
                  <button className="start" type="submit" disabled={steerBusy || !active || !steerText.trim()}>{steerBusy ? '…' : '⚡ Send'}</button>
                </form>
              )
            })()}
          </>
        )}
      </div>
    </div>
  )
}

const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', marginBottom: 8, padding: '7px 9px',
  background: '#1b2233', border: '1px solid #2a3350', borderRadius: 6, color: '#e6edf3', fontSize: 13
}
