import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconButton, Icon } from '@renderer/ui'
import TerminalTabs, { OpenTerm } from '../TerminalTabs'
import { OfficeCard } from '../components/office/OfficeCard'
import { CharacterCard } from '../components/office/CharacterCard'
import { AgentStream } from '../components/office/AgentStream'
import { OfficeRoom } from '../components/office/OfficeRoom'
import {
  OfficeAgent,
  OfficeGroup,
  ChatMessage,
  isAuthError,
  providerToCommand
} from '../components/office/officeTypes'

/**
 * OfficeView — SCREEN 2c. One stream at a time (not 3 scrolling columns).
 *
 * Office rail (282) + office detail (character grid + focused-agent stream +
 * shared office room). A restyle/reflow of PixelOfficeView's logic onto the v2
 * layout — same real office API (officeAgents / officeSpawnOffice / officeStopOffice /
 * officeOperate / officeSteer / officeMessages). Spawn + operate are preserved:
 * operating a character opens a live TerminalTabs pane in the stream area (its PTY
 * stays mounted per the keep-alive rule); spawning starts tracked loops (log panes).
 */
export function OfficeView({ visible = true }: { visible?: boolean } = {}): React.JSX.Element {
  // ── connection / login ──
  const [connected, setConnected] = useState(false)
  const [base, setBase] = useState('')
  const [basePlaceholder, setBasePlaceholder] = useState('https://…')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // ── office data ──
  const [agents, setAgents] = useState<OfficeAgent[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadingAgents, setLoadingAgents] = useState(false)
  const [listErr, setListErr] = useState('')

  // ── selection ──
  const [selectedSlug, setSelectedSlug] = useState('')
  const [focusedId, setFocusedId] = useState('')

  // ── spawn / operate ──
  const [operatingId, setOperatingId] = useState('')
  const [spawningOffice, setSpawningOffice] = useState('')
  const [stoppingOffice, setStoppingOffice] = useState('')
  const [spawnedOffices, setSpawnedOffices] = useState<Set<string>>(new Set())
  const [terms, setTerms] = useState<OpenTerm[]>([])
  const [activeTermId, setActiveTermId] = useState('')
  const [endedIds, setEndedIds] = useState<Set<string>>(new Set())

  // ── new office (inline) ──
  const [showNewOffice, setShowNewOffice] = useState(false)
  const [newOfficeName, setNewOfficeName] = useState('')
  const [creatingOffice, setCreatingOffice] = useState(false)

  // ── live conversation for the focused character ──
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [steerToast, setSteerToast] = useState('')

  const EXPIRED = 'Your office session expired — please sign in again.'

  // ── read-only live log stream (reuses the SAME agent:log IPC the sidebar uses) ──
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
      if (next.length > 20000) next = next.slice(next.length - 20000)
      logsRef.current.set(path, next)
      logListeners.current.forEach((cb) => cb())
    })
    return () => { off?.() }
  }, [])

  const inFlight = useRef(false)
  const msgInFlight = useRef(false)
  const termsRef = useRef<OpenTerm[]>([])
  useEffect(() => { termsRef.current = terms }, [terms])

  // Auth expired mid-action. NEVER swap to the login form while live Operate PTYs
  // are mounted — the login return unmounts <TerminalTabs> and SIGKILLs them.
  // Mirror the poll-path guard: surface a soft reconnect notice instead.
  const handleAuthExpiry = useCallback((): void => {
    if (termsRef.current.length) { setListErr('Office session needs reconnect — your running session is unaffected.'); return }
    setConnected(false); setLoaded(false); setErr(EXPIRED)
  }, [])

  // Fold the flat agent list into offices (client-side derive, no backend change).
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

  const onlineAgentIds = useMemo(() => new Set(agents.filter((a) => a.online).map((a) => a.id)), [agents])

  const selectedGroup = useMemo(
    () => grouped.find((g) => g.slug === selectedSlug) ?? grouped[0],
    [grouped, selectedSlug]
  )
  const focusedChar = useMemo(
    () => selectedGroup?.agents.find((a) => a.id === focusedId) ?? selectedGroup?.agents[0],
    [selectedGroup, focusedId]
  )

  // Keep selection valid as the list changes.
  useEffect(() => {
    if (grouped.length && !grouped.some((g) => g.slug === selectedSlug)) setSelectedSlug(grouped[0].slug)
  }, [grouped, selectedSlug])
  useEffect(() => {
    if (selectedGroup && !selectedGroup.agents.some((a) => a.id === focusedId)) {
      setFocusedId(selectedGroup.agents[0]?.id ?? '')
    }
  }, [selectedGroup, focusedId])

  // ── load / poll office agents ──
  const loadAgents = useCallback(async () => {
    setLoadingAgents(true); setListErr('')
    try {
      setAgents((await window.api.officeAgents()) as OfficeAgent[])
      setLoaded(true)
    } catch (e) {
      const msg = (e as Error)?.message || 'Failed to load agents'
      if (isAuthError(msg)) {
        try {
          if (await window.api.officeAutoConnect()) {
            setAgents((await window.api.officeAgents()) as OfficeAgent[])
            setLoaded(true); setLoadingAgents(false); return
          }
        } catch { /* fall through to login */ }
        if (termsRef.current.length) { setListErr('Office session needs reconnect — your running session is unaffected.'); setLoadingAgents(false); return }
        setConnected(false); setLoaded(false); setErr(EXPIRED)
      } else {
        setListErr(msg)
      }
    }
    setLoadingAgents(false)
  }, [])

  const pollAgents = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      setAgents((await window.api.officeAgents()) as OfficeAgent[])
      setLoaded(true)
    } catch (e) {
      const msg = (e as Error)?.message || ''
      if (isAuthError(msg)) {
        let recovered = false
        try { recovered = !!(await window.api.officeAutoConnect()) } catch { /* fall through */ }
        if (recovered) {
          try { setAgents((await window.api.officeAgents()) as OfficeAgent[]); setLoaded(true); return }
          catch { /* fall through */ }
        }
        if (termsRef.current.length) { setListErr('Office session needs reconnect — your running session is unaffected.'); return }
        setConnected(false); setLoaded(false); setErr(EXPIRED)
      }
    } finally { inFlight.current = false }
  }, [])

  useEffect(() => {
    if (!connected || !visible) return
    const id = setInterval(pollAgents, 8000)
    const onFocus = (): void => { void pollAgents() }
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus) }
  }, [connected, visible, pollAgents])

  // ── mount: resolve base + auto-connect ──
  useEffect(() => {
    (async () => {
      const cfg = (await window.api.getSettings()) as { officeBaseUrl?: string }
      if (cfg.officeBaseUrl) setBasePlaceholder(cfg.officeBaseUrl)
      const st = (await window.api.officeStatus()) as { connected: boolean; base: string; email?: string }
      if (st.base) setBase(st.base)
      if (st.email) setEmail(st.email)
      const ok = st.connected || (await window.api.officeAutoConnect())
      setConnected(!!ok)
      if (ok) loadAgents()
    })()
  }, [loadAgents])

  // ── poll the focused character's live conversation ──
  const loadMessages = useCallback(async (slug: string, ref: string) => {
    if (msgInFlight.current) return
    msgInFlight.current = true
    try {
      const r = (await window.api.officeMessages(slug, ref)) as { ok?: boolean; messages?: ChatMessage[]; error?: string }
      if (r?.messages) setMessages(r.messages)
    } catch { /* non-fatal — keep the last-known transcript */ }
    finally { msgInFlight.current = false }
  }, [])

  // Depend on STABLE primitives (slug/ref), not the useMemo object identities —
  // otherwise this re-ran every 8s poll (new selectedGroup/focusedChar objects)
  // and setMessages([]) flashed the transcript empty. Now it only re-runs (and
  // only clears) when the selected office or focused character actually changes.
  const focusedRef = focusedChar?.slug ?? focusedChar?.id
  useEffect(() => {
    setMessages([])
    if (!connected || !visible || !selectedGroup || !focusedChar) return
    const slug = selectedGroup.slug
    const ref = focusedChar.slug
    void loadMessages(slug, ref)
    const id = setInterval(() => void loadMessages(slug, ref), 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, visible, selectedGroup?.slug, focusedRef, loadMessages])

  // ── connect / disconnect ──
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
    setTerms([]); setActiveTermId(''); setEndedIds(new Set()); setListErr('')
    setSpawnedOffices(new Set())
  }, [])

  // Close ONLY interactive Operate PTY panes (SIGKILL on unmount) — leave tracked loops.
  const closeOperatePtys = useCallback(() => {
    setTerms((prev) => {
      const removed = prev.filter((t) => t.kind === 'pty').map((t) => t.id)
      if (!removed.length) return prev
      const next = prev.filter((t) => t.kind !== 'pty')
      setActiveTermId((cur) => (removed.includes(cur) ? (next[0]?.id ?? '') : cur))
      return next
    })
  }, [])
  useEffect(() => {
    const h = (): void => closeOperatePtys()
    window.addEventListener('office:stop-all', h)
    return () => window.removeEventListener('office:stop-all', h)
  }, [closeOperatePtys])

  const openTerm = useCallback((t: OpenTerm) => {
    setTerms((prev) => (prev.some((x) => x.id === t.id) ? prev : [...prev, t]))
    setActiveTermId(t.id)
    setEndedIds((prev) => { const n = new Set(prev); n.delete(t.id); return n })
  }, [])

  // Operate a SINGLE character in an interactive terminal (preserves the feature).
  const operate = useCallback(async (a: OfficeAgent) => {
    const rid = a.officeSlug + a.id
    const baseId = `op-${a.officeSlug}-${a.id}`
    // A live (non-ended) pane for this character may carry a generation suffix.
    const existing = terms.find((t) => t.id === baseId || t.id.startsWith(`${baseId}#`))
    if (existing && !endedIds.has(existing.id)) { setActiveTermId(existing.id); return }
    if (operatingId === rid) return
    setListErr(''); setOperatingId(rid)
    try {
      const r = (await window.api.officeOperate(a.officeSlug, a.id, a.slug)) as { ok?: boolean; cwd?: string; mcpUrl?: string; error?: string }
      if (r?.error || !r?.cwd) {
        if (r?.error && isAuthError(r.error)) handleAuthExpiry()
        else setListErr(r?.error || 'Could not prepare the operate workspace')
        return
      }
      // Re-operating an ENDED character: drop the stale (dead-PTY) term and mint a
      // generation-suffixed id so React unmounts the old TerminalPane and mounts a
      // FRESH one that spawns a new PTY — reusing the stale id never remounts.
      if (existing) {
        setTerms((prev) => prev.filter((t) => t.id !== existing.id))
        setEndedIds((prev) => { const n = new Set(prev); n.delete(existing.id); return n })
      }
      const id = existing ? `${baseId}#${Date.now()}` : baseId
      openTerm({ id, kind: 'pty', cwd: r.cwd, mcpUrl: r.mcpUrl, name: `${a.name} · ${a.office}`, agentId: a.id, command: providerToCommand(a.provider), provider: a.provider })
      void pollAgents()
    } finally { setOperatingId('') }
  }, [terms, endedIds, operatingId, openTerm, pollAgents, handleAuthExpiry])

  // Spawn the WHOLE office as tracked loops (block-if-any-online); auto-open log panes.
  const spawnOffice = useCallback(async (g: OfficeGroup) => {
    if (g.onlineCount > 0 || spawningOffice) return
    setListErr(''); setSpawningOffice(g.slug)
    try {
      const r = await window.api.officeSpawnOffice(g.slug, g.agents.map((a) => ({ agentId: a.id, provider: a.provider || '' })))
      if ('error' in r) {
        const online = (r as { online?: string[] }).online
        const who = online && online.length ? ` (online: ${online.join(', ')})` : ''
        if (isAuthError(r.error)) handleAuthExpiry()
        else setListErr(r.error + who)
        return
      }
      setSpawnedOffices((prev) => new Set(prev).add(g.slug))
      let firstId = ''
      for (const s of r.agents) {
        const id = `log-${g.slug}-${s.agentId}`
        if (!firstId) firstId = id
        if (!logsRef.current.has(s.path)) logsRef.current.set(s.path, '')
        openTerm({ id, kind: 'log', name: `${s.name} · ${g.name}`, agentId: s.agentId, path: s.path, provider: s.provider })
      }
      if (firstId) setActiveTermId(firstId)
      void pollAgents()
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (isAuthError(msg)) handleAuthExpiry()
      else setListErr(msg)
    } finally { setSpawningOffice('') }
  }, [spawningOffice, openTerm, pollAgents, handleAuthExpiry])

  const stopOffice = useCallback(async (g: OfficeGroup) => {
    if (stoppingOffice) return
    setListErr(''); setStoppingOffice(g.slug)
    try {
      const r = await window.api.officeStopOffice(g.slug)
      if ('error' in r) {
        if (isAuthError(r.error)) handleAuthExpiry()
        else setListErr(r.error)
        return
      }
      setSpawnedOffices((prev) => { const n = new Set(prev); n.delete(g.slug); return n })
      const prefix = `log-${g.slug}-`
      setTerms((prev) => {
        const next = prev.filter((t) => !(t.kind === 'log' && t.id.startsWith(prefix)))
        setActiveTermId((cur) => (cur.startsWith(prefix) ? (next[next.length - 1]?.id ?? '') : cur))
        return next
      })
      void pollAgents()
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (isAuthError(msg)) handleAuthExpiry()
      else setListErr(msg)
    } finally { setStoppingOffice('') }
  }, [stoppingOffice, pollAgents, handleAuthExpiry])

  // Live instant-message (steer) — NOT a queued TODO task.
  const steer = useCallback(async (agentId: string, text: string) => {
    if (!agentId || !text) return
    setSteerToast('')
    try {
      const r = (await window.api.officeSteer(agentId, text)) as { ok?: boolean; error?: string }
      if (r?.ok) {
        setSteerToast('⚡ delivered')
        // reflect our own message immediately (optimistic) until the next poll
        setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: 'user', author: 'you', text, at: Date.now() }])
      } else setSteerToast(r?.error || 'Could not deliver — is the character online?')
    } catch (e) { setSteerToast(String((e as Error)?.message ?? e)) }
    setTimeout(() => setSteerToast(''), 4000)
  }, [])

  const createOffice = useCallback(async () => {
    const name = newOfficeName.trim()
    if (!name || creatingOffice) return
    setCreatingOffice(true)
    try {
      const r = (await window.api.officeCreateOffice(name, '')) as { ok?: boolean; office?: { slug: string }; error?: string }
      if (r?.ok) {
        setNewOfficeName(''); setShowNewOffice(false)
        if (r.office?.slug) setSelectedSlug(r.office.slug)
        void loadAgents()
      } else setListErr(r?.error || 'Could not create the office')
    } catch (e) { setListErr(String((e as Error)?.message ?? e)) }
    finally { setCreatingOffice(false) }
  }, [newOfficeName, creatingOffice, loadAgents])

  // Open a character in the Agents tab (2a). No routing prop on this screen —
  // dispatch an app event Stage-3 integration wires. TODO(redesign): pass a real
  // onOpenAgent handler from App when integrating.
  const openAgentTab = useCallback((a: OfficeAgent) => {
    window.dispatchEvent(new CustomEvent('autodev:open-agent', { detail: { officeSlug: a.officeSlug, agentSlug: a.slug } }))
  }, [])

  const openBrowser = useCallback(() => {
    // No per-office deep-link is exposed; open the office root.
    // TODO(redesign): expose a per-office URL for a precise "Open in browser".
    if (base.trim()) void window.api.openExternal(base.trim())
  }, [base])

  // ── not connected: login ──
  if (!connected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: 'var(--bg-0)', fontFamily: 'var(--font-sans)' }}>
        <form
          onSubmit={(e) => { e.preventDefault(); void connect() }}
          style={{ width: 360, background: 'var(--bg-panel)', border: '1px solid var(--bd-strong)', borderRadius: 'var(--r-modal)', padding: 22, boxShadow: 'var(--shadow-modal)' }}
        >
          <h2 style={{ margin: '0 0 4px', fontSize: 'var(--fs-panel-title)', fontWeight: 700, color: 'var(--tx-hi)' }}>Connect to your Pixel Office</h2>
          <p style={{ margin: '0 0 16px', fontSize: 'var(--fs-meta)', color: 'var(--tx-4)', lineHeight: 1.5 }}>
            A Pixel Office is your team of remote agents. Sign in to list and operate them.
          </p>
          {(['Server URL', 'Email', 'Password'] as const).map((label) => {
            const isPw = label === 'Password'
            const isEmail = label === 'Email'
            const value = label === 'Server URL' ? base : isEmail ? email : password
            const set = label === 'Server URL' ? setBase : isEmail ? setEmail : setPassword
            return (
              <label key={label} style={{ display: 'block', marginBottom: 10 }}>
                <span style={{ display: 'block', fontSize: 'var(--fs-desc)', color: 'var(--tx-4)', marginBottom: 5 }}>{label}</span>
                <input
                  type={isPw ? 'password' : isEmail ? 'email' : 'text'}
                  autoComplete={isPw ? 'current-password' : isEmail ? 'username' : undefined}
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  placeholder={label === 'Server URL' ? basePlaceholder : isEmail ? 'you@example.com' : undefined}
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '8px 11px',
                    background: 'var(--bg-input)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)',
                    color: 'var(--tx-1)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)'
                  }}
                />
              </label>
            )
          })}
          {err && <div role="alert" style={{ color: 'var(--st-error-bright)', fontSize: 'var(--fs-meta)', margin: '6px 0' }}>{err}</div>}
          <Button variant="primary" type="submit" block disabled={busy || !email || !password || !base} style={{ marginTop: 8 }}>
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </form>
      </div>
    )
  }

  // ── connected: rail + detail ──
  const running = selectedGroup ? selectedGroup.onlineCount > 0 || spawnedOffices.has(selectedGroup.slug) : false
  const total = selectedGroup?.agents.length ?? 0
  const online = selectedGroup?.onlineCount ?? 0
  const operating = terms.length > 0
  const activeTerm = terms.find((t) => t.id === activeTermId)

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, background: 'var(--bg-0)', fontFamily: 'var(--font-sans)' }}>
      {/* ── office rail ── */}
      <div
        style={{
          width: 'var(--w-office-rail)',
          flex: 'none',
          borderRight: '1px solid var(--bd-2)',
          background: 'var(--bg-sidebar)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0
        }}
      >
        <div style={{ padding: '15px 15px 12px', borderBottom: '1px solid var(--bd-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, fontSize: 'var(--fs-panel-title)', fontWeight: 700, color: 'var(--tx-hi)' }}>Offices</div>
            <Button variant="primary" size="sm" onClick={() => setShowNewOffice((s) => !s)} title="Create a new office">
              <Icon name="plus" size={11} /> New office
            </Button>
            <IconButton label="Refresh offices" onClick={loadAgents} disabled={loadingAgents}>
              <Icon name="refresh" size={13} />
            </IconButton>
          </div>
          <div style={{ marginTop: 6, fontSize: 'var(--fs-desc)', color: 'var(--tx-5)' }}>
            {grouped.length} office{grouped.length === 1 ? '' : 's'} · {agents.length} character{agents.length === 1 ? '' : 's'}
          </div>
          {showNewOffice && (
            <form onSubmit={(e) => { e.preventDefault(); void createOffice() }} style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <input
                value={newOfficeName}
                onChange={(e) => setNewOfficeName(e.target.value)}
                placeholder="Office name…"
                aria-label="New office name"
                autoFocus
                style={{
                  flex: 1, minWidth: 0, padding: '6px 9px', background: 'var(--bg-input)',
                  border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)', color: 'var(--tx-1)',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-meta)'
                }}
              />
              <Button variant="secondary" size="sm" type="submit" disabled={creatingOffice || !newOfficeName.trim()}>
                {creatingOffice ? '…' : 'Create'}
              </Button>
            </form>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
          {listErr && (
            <div role="alert" style={{ padding: '9px 11px', background: 'var(--st-error-wash)', border: '1px solid var(--st-error-bd)', borderRadius: 'var(--r-card)', color: 'var(--st-error-bright)', fontSize: 'var(--fs-meta)' }}>
              {listErr}
              <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                <Button variant="secondary" size="sm" onClick={loadAgents}>Retry</Button>
                <Button variant="secondary" size="sm" danger onClick={disconnect}>Reconnect</Button>
              </div>
            </div>
          )}
          {loadingAgents && !loaded && <div style={{ padding: 16, fontSize: 'var(--fs-meta)', color: 'var(--tx-4)' }}>Loading…</div>}
          {loaded && grouped.length === 0 && !listErr && (
            <div style={{ padding: 16, fontSize: 'var(--fs-meta)', color: 'var(--tx-4)' }}>No offices yet. Create one to get started.</div>
          )}
          {grouped.map((g) => (
            <OfficeCard
              key={g.slug}
              group={g}
              selected={g.slug === selectedGroup?.slug}
              running={g.onlineCount > 0 || spawnedOffices.has(g.slug)}
              busy={spawningOffice === g.slug ? 'spawning' : stoppingOffice === g.slug ? 'stopping' : ''}
              onSelect={() => setSelectedSlug(g.slug)}
              onSpawn={() => spawnOffice(g)}
              onStop={() => stopOffice(g)}
              onOpenBrowser={openBrowser}
            />
          ))}
        </div>
      </div>

      {/* ── office detail ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
        {!selectedGroup ? (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--tx-4)', fontSize: 'var(--fs-meta)' }}>
            Select an office to view its characters.
          </div>
        ) : (
          <>
            {/* header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderBottom: '1px solid var(--bd-2)' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 'var(--fs-panel-title)', fontWeight: 700, color: 'var(--tx-hi)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {selectedGroup.name}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)', marginTop: 2 }}>
                  {total} character{total === 1 ? '' : 's'} · {online} connected
                </div>
              </div>
              <div style={{ flex: 1 }} />
              {steerToast && (
                <span style={{ fontSize: 'var(--fs-desc)', color: steerToast.startsWith('⚡') ? 'var(--st-running)' : 'var(--st-error)', whiteSpace: 'nowrap' }}>{steerToast}</span>
              )}
              {running ? (
                <Button variant="secondary" size="sm" danger disabled={stoppingOffice === selectedGroup.slug} onClick={() => stopOffice(selectedGroup)}>
                  {stoppingOffice === selectedGroup.slug ? 'Stopping…' : 'Stop all'}
                </Button>
              ) : (
                <Button variant="secondary" size="sm" disabled={spawningOffice === selectedGroup.slug || online > 0} onClick={() => spawnOffice(selectedGroup)}>
                  {spawningOffice === selectedGroup.slug ? 'Connecting…' : 'Connect all'}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={openBrowser}>
                <Icon name="external" size={11} /> Open in browser
              </Button>
            </div>

            {/* character grid */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 10,
                padding: '12px 18px',
                borderBottom: '1px solid var(--bd-2)',
                maxHeight: 260,
                overflow: 'auto'
              }}
            >
              {selectedGroup.agents.map((a) => (
                <CharacterCard
                  key={a.id}
                  agent={a}
                  selected={a.id === focusedChar?.id}
                  busy={operatingId === a.officeSlug + a.id}
                  onSelect={() => setFocusedId(a.id)}
                  onOperate={() => operate(a)}
                />
              ))}
              {/* create-character tile (preserves the in-app "new character" affordance) */}
              <NewCharacterTile officeName={selectedGroup.name} />
            </div>

            {/* lower split: focused stream (or live terminal) + office room */}
            <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, borderRight: '1px solid var(--bd-2)' }}>
                {operating ? (
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
                        setTerms((prev) => {
                          const next = prev.filter((t) => t.id !== id)
                          setActiveTermId((cur) => (cur === id ? (next[next.length - 1]?.id ?? '') : cur))
                          return next
                        })
                        setEndedIds((prev) => { const n = new Set(prev); n.delete(id); return n })
                      }}
                      onExit={(id) => { setEndedIds((prev) => new Set(prev).add(id)); void pollAgents() }}
                    />
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '9px 14px', borderTop: '1px solid var(--bd-2)' }}>
                      <TermSteer disabled={!activeTerm} onSend={(t) => { if (activeTerm) void steer(activeTerm.agentId, t) }} name={activeTerm?.name.split(' · ')[0] ?? ''} />
                    </div>
                  </>
                ) : focusedChar ? (
                  <AgentStream
                    agent={focusedChar}
                    messages={messages.filter((m) => m.role === 'assistant' || m.role === 'system')}
                    disabled={!focusedChar.online}
                    onSend={(t) => steer(focusedChar.id, t)}
                    onOpenAgent={() => openAgentTab(focusedChar)}
                  />
                ) : (
                  <div style={{ margin: 'auto', color: 'var(--tx-4)', fontSize: 'var(--fs-meta)' }}>No character selected.</div>
                )}
              </div>

              <OfficeRoom
                officeName={selectedGroup.name}
                messages={messages.filter((m) => m.role === 'user' || m.role === 'a2a' || m.role === 'assistant')}
                targetName={focusedChar?.name ?? ''}
                disabled={!focusedChar}
                onSend={(t) => focusedChar && steer(focusedChar.id, t)}
                note={focusedChar && !focusedChar.online ? 'Character is offline — messages queue as a live steer once it connects.' : undefined}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** The steer input under an active Operate terminal (its own local text state). */
function TermSteer({ disabled, name, onSend }: { disabled: boolean; name: string; onSend: (t: string) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <>
      <span title="Live instant-message (steer)" style={{ color: 'var(--role-violet)', fontSize: 13 }}>⚡</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
        placeholder={disabled ? 'Select a tab…' : `Instant-message ${name} now…`}
        aria-label="Instant message to this office character"
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); const t = text.trim(); if (t) { onSend(t); setText('') } }
        }}
        style={{
          flex: 1, minWidth: 0, background: 'var(--bg-panel)', border: '1px solid var(--bd-1)',
          borderRadius: 'var(--r-card)', padding: '7px 11px', color: 'var(--tx-1)',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)'
        }}
      />
      <Button variant="primary" size="sm" disabled={disabled || !text.trim()} onClick={() => { const t = text.trim(); if (t) { onSend(t); setText('') } }}>
        ⚡ Send
      </Button>
    </>
  )
}

/** Create-character dashed tile — reuses officeCreateCharacter (preserves the feature). */
function NewCharacterTile({ officeName }: { officeName: string }): React.JSX.Element {
  // Kept lightweight: the tile is informational + a hint, since creating a
  // character needs the numeric officeId which the folded list doesn't carry.
  // TODO(redesign): thread officeId through OfficeGroup to enable inline create.
  return (
    <div
      title={`Add a character to ${officeName} from the office web app`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '10px 11px',
        borderRadius: 'var(--r-card)',
        background: 'var(--bg-2)',
        border: '1px dashed var(--bd-idle-box)',
        color: 'var(--tx-4)',
        minHeight: 78
      }}
    >
      <Icon name="plus" size={14} />
      <span style={{ fontSize: 'var(--fs-desc)' }}>New character</span>
    </div>
  )
}

export default OfficeView
