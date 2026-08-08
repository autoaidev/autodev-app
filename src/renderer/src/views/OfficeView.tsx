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

  // Prune log buffers whose tracked loop is gone (office stopped / log pane closed)
  // so the Map can't grow unbounded across spawn/stop cycles. Mirror AgentsView:
  // always diff against the live set (live log-term paths), never a size gate.
  useEffect(() => {
    const live = new Set(terms.filter((t) => t.kind === 'log' && t.path).map((t) => t.path as string))
    for (const p of logsRef.current.keys()) if (!live.has(p)) logsRef.current.delete(p)
  }, [terms])

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

  // Remember every office slug we've ever seen. A term whose office transiently drops
  // out of a poll must still resolve to its OWN slug bucket (below) — otherwise it would
  // fall into a shared bucket, changing the pane's React key, remounting <TerminalTabs>
  // and SIGKILLing a live PTY. A slug is recorded while its office is in `grouped`, so
  // by the time that office churns out it is already known.
  const seenSlugsRef = useRef<Set<string>>(new Set())
  useEffect(() => { for (const g of grouped) seenSlugsRef.current.add(g.slug) }, [grouped])

  // Bucket open terms by their owning office. Term ids embed the office slug
  // (`op-<slug>-<id>` / `log-<slug>-<id>`) so the operate pane can be scoped to the
  // SELECTED office — otherwise a global `operating` shows office A's terminals (and
  // steers A's character) while you're viewing office B. Match against known slugs
  // (current `grouped` PLUS every slug ever seen), longest-first so an `acme` bucket
  // never swallows an `acme-2` term. Bucketing by the term's OWN slug — even when its
  // office is momentarily absent from the list — keeps its stable `term-<slug>` React
  // key across polls so a live PTY is never remounted/killed.
  const termsByOffice = useMemo(() => {
    const known = new Set<string>(seenSlugsRef.current)
    for (const g of grouped) known.add(g.slug)
    const slugs = [...known].sort((a, b) => b.length - a.length)
    const byOffice = new Map<string, OpenTerm[]>()
    for (const t of terms) {
      const slug = slugs.find((s) => t.id.startsWith(`op-${s}-`) || t.id.startsWith(`log-${s}-`)) ?? '__unbucketed__'
      const arr = byOffice.get(slug) ?? []; arr.push(t); byOffice.set(slug, arr)
    }
    return byOffice
  }, [terms, grouped])

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

  // Apply a freshly fetched agent list. A transient empty 200 (character/office
  // deleted server-side, or a momentary blip) would collapse grouped→[]→
  // selectedGroup=undefined→the placeholder branch, which unmounts <TerminalTabs>
  // and SIGKILLs every live Operate PTY. Never tear down running terminals on an
  // empty poll: keep the last-known list and surface a soft notice. Empty is only
  // honored when no Operate terminals are live.
  const applyAgents = useCallback((next: OfficeAgent[]): void => {
    if (next.length === 0 && termsRef.current.length) {
      setListErr('Office list came back empty — keeping your running session.')
      return
    }
    setListErr('')
    setAgents(next)
  }, [])

  // ── load / poll office agents ──
  const loadAgents = useCallback(async () => {
    setLoadingAgents(true); setListErr('')
    try {
      applyAgents((await window.api.officeAgents()) as OfficeAgent[])
      setLoaded(true)
    } catch (e) {
      const msg = (e as Error)?.message || 'Failed to load agents'
      if (isAuthError(msg)) {
        try {
          if (await window.api.officeAutoConnect()) {
            applyAgents((await window.api.officeAgents()) as OfficeAgent[])
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
  }, [applyAgents])

  const pollAgents = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      applyAgents((await window.api.officeAgents()) as OfficeAgent[])
      setLoaded(true)
    } catch (e) {
      const msg = (e as Error)?.message || ''
      if (isAuthError(msg)) {
        let recovered = false
        try { recovered = !!(await window.api.officeAutoConnect()) } catch { /* fall through */ }
        if (recovered) {
          try { applyAgents((await window.api.officeAgents()) as OfficeAgent[]); setLoaded(true); return }
          catch { /* fall through */ }
        }
        if (termsRef.current.length) { setListErr('Office session needs reconnect — your running session is unaffected.'); return }
        setConnected(false); setLoaded(false); setErr(EXPIRED)
      }
    } finally { inFlight.current = false }
  }, [applyAgents])

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

  // Soft reconnect (the inline error-box button). NEVER tear down live Operate PTYs:
  // if terminals are mounted, re-auth in place (mirror the poll-path auto-connect
  // recovery) and keep them running. Only a full user-initiated Disconnect (which
  // calls disconnect() directly) may clear terms.
  const reconnect = useCallback(async () => {
    if (termsRef.current.length) {
      setListErr('')
      try { await window.api.officeAutoConnect() } catch { /* loadAgents surfaces auth state */ }
      void loadAgents()
      return
    }
    void disconnect()
  }, [disconnect, loadAgents])

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
  // Scope the operate pane to the SELECTED office (not the global term list).
  const officeTerms = selectedGroup ? (termsByOffice.get(selectedGroup.slug) ?? []) : []
  const operating = officeTerms.length > 0
  // Offices with live terms — all mounted, only the selected one shown.
  const termOffices = [...termsByOffice.keys()]

  // Shared pane handlers (term ids are globally unique, so these stay office-agnostic).
  const onTermClose = (id: string): void => {
    setTerms((prev) => {
      const next = prev.filter((t) => t.id !== id)
      setActiveTermId((cur) => (cur === id ? (next[next.length - 1]?.id ?? '') : cur))
      return next
    })
    setEndedIds((prev) => { const n = new Set(prev); n.delete(id); return n })
  }
  const onTermExit = (id: string): void => { setEndedIds((prev) => new Set(prev).add(id)); void pollAgents() }

  // One TerminalTabs per office that has terms. ALL stay mounted (a mounted pty pane
  // === a live PTY); the non-selected offices' panes are hidden with display:none so
  // switching offices never SIGKILLs a running shell. Terms whose office is momentarily
  // absent from the list keep their own hidden `term-<slug>` bucket for the same reason.
  const renderTermPane = (ots: OpenTerm[], visible: boolean, key: string): React.JSX.Element => {
    const oActiveId = ots.some((t) => t.id === activeTermId) ? activeTermId : (ots[0]?.id ?? '')
    const oActive = ots.find((t) => t.id === oActiveId)
    return (
      <div key={key} style={{ display: visible ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
        <TerminalTabs
          terms={ots}
          activeId={oActiveId}
          endedIds={endedIds}
          onlineAgentIds={onlineAgentIds}
          getLog={getLog}
          subscribeLog={subscribeLog}
          onSelect={setActiveTermId}
          onClose={onTermClose}
          onExit={onTermExit}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '9px 14px', borderTop: '1px solid var(--bd-2)' }}>
          <TermSteer disabled={!oActive} onSend={(t) => { if (oActive) void steer(oActive.agentId, t) }} name={oActive?.name.split(' · ')[0] ?? ''} />
        </div>
      </div>
    )
  }

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
                <Button variant="secondary" size="sm" danger onClick={reconnect}>Reconnect</Button>
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
                {/* Keep every office's terminals mounted; show only the selected office's.
                    Each bucket carries a stable `term-<slug>` key (offices that churned
                    out of the poll keep their own bucket) so switching/polling never
                    remounts — and SIGKILLs — a live PTY. */}
                {termOffices.map((slug) => renderTermPane(termsByOffice.get(slug) ?? [], slug === selectedGroup.slug, `term-${slug}`))}
                {/* Selected office has no live terminals → show its focused stream instead. */}
                {!operating && (focusedChar ? (
                  <AgentStream
                    agent={focusedChar}
                    messages={messages.filter((m) => m.role === 'assistant' || m.role === 'system')}
                    disabled={!focusedChar.online}
                    onSend={(t) => steer(focusedChar.id, t)}
                    onOpenAgent={() => openAgentTab(focusedChar)}
                  />
                ) : (
                  <div style={{ margin: 'auto', color: 'var(--tx-4)', fontSize: 'var(--fs-meta)' }}>No character selected.</div>
                ))}
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
