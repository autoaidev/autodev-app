import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconButton, Icon } from '@renderer/ui'
import TerminalTabs, { OpenTerm } from '../TerminalTabs'
import { OfficeCard } from '../components/office/OfficeCard'
import { CharacterCard } from '../components/office/CharacterCard'
import { AgentStream } from '../components/office/AgentStream'
import { OfficeRoom } from '../components/office/OfficeRoom'
import { SignInForm } from '../components/office/SignInForm'
import { OfficeAgent, OfficeGroup, isAuthError } from '../components/office/officeTypes'
import * as officeService from '../services/officeService'
import * as termRegistry from '../services/termRegistry'
import { useAppActions } from '../services/appActions'

/**
 * OfficeView — SCREEN 2c. One stream at a time (not 3 scrolling columns).
 *
 * Office rail (282) + office detail (character grid + focused-agent stream +
 * shared office room). Stage-S3 of the services refactor: this view now CONSUMES
 * services/officeService (connection + office list + per-character conversation)
 * and services/termRegistry (Operate/log PTY lifecycle) instead of owning that
 * state locally. The connection probe, the 8s office-list poll, the normalize /
 * empty-poll / auth-expiry keep-alive guards, and the shared conversation poll all
 * live in officeService now; the open-terminal list (terms/activeId/endedIds), the
 * per-office bucketing, the reap-after-3-absent reconcile, and `stopAll` live in
 * termRegistry (which OWNS term ids so the PTYs survive this view's unmount).
 *
 * What stays here (view concerns): the login form + connect/reconnect UX, office &
 * character SELECTION, the spawn/stop office API calls (their term panes are opened/
 * closed via the registry), the local read-only log-text buffer (not in this stage's
 * scope), and rendering <TerminalTabs> — one per term-owning office, ALL kept mounted
 * and display-toggled by selection (a mounted pty pane === a live PTY; unmounting one
 * SIGKILLs it, so switching offices must never unmount another office's panes).
 */
export function OfficeView({ visible = true }: { visible?: boolean } = {}): React.JSX.Element {
  // ── typed app-actions bus (stop-all subscription + open-agent dispatch) ──
  const actions = useAppActions()
  // ── connection + office list + conversations (owned by officeService) ──
  const office = officeService.useOffice()
  // ── open Operate/log terminals (owned by termRegistry) ──
  const { terms: allTerms, activeId, endedIds, notice } = termRegistry.useTerms()

  // ── login form (local editable fields; seeded from the resolved connection) ──
  const [base, setBase] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // ── selection ──
  const [selectedSlug, setSelectedSlug] = useState('')
  const [focusedId, setFocusedId] = useState('')

  // ── spawn / operate (progress + action-level errors) ──
  const [operatingId, setOperatingId] = useState('')
  const [spawningOffice, setSpawningOffice] = useState('')
  const [stoppingOffice, setStoppingOffice] = useState('')
  const [spawnedOffices, setSpawnedOffices] = useState<Set<string>>(new Set())
  // Errors surfaced by an explicit action (operate/spawn/stop/create). The list/auth
  // keep-alive notices come from officeService (`listError`) and the reap notice from
  // termRegistry (`notice`); all three share the rail's error box.
  const [actionErr, setActionErr] = useState('')

  // ── new office (inline) ──
  const [showNewOffice, setShowNewOffice] = useState(false)
  const [newOfficeName, setNewOfficeName] = useState('')
  const [creatingOffice, setCreatingOffice] = useState(false)

  const [steerToast, setSteerToast] = useState('')

  // ── read-only live log stream (local buffer — reuses the SAME agent:log IPC the
  //    sidebar uses). NOT part of this stage's service migration; kept view-local so
  //    the log panes keep their exact behavior. ──
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

  // Prune log buffers whose tracked loop is gone (office stopped / log pane closed) so
  // the Map can't grow unbounded across spawn/stop cycles. Diff against the live set
  // (live log-term paths from the registry), never a size gate. Re-run on registry-term
  // change AND on every list change: onAgentLog can append to a path that no longer owns
  // a term, and that buffer would otherwise linger until `terms` next changed.
  useEffect(() => {
    const live = new Set(allTerms.filter((t) => t.kind === 'log' && t.path).map((t) => t.path as string))
    for (const p of logsRef.current.keys()) if (!live.has(p)) logsRef.current.delete(p)
  }, [allTerms, office.agents])

  // Mirror the office tab's foreground state into the service so it pauses/resumes the
  // shared office-list poll (it only ticks while connected AND visible).
  useEffect(() => { officeService.setVisible(visible) }, [visible])

  // Seed the login form's Server URL / Email from the resolved connection ONCE (so a
  // known-but-not-connected session pre-fills the form). Never clobbers user typing.
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current) return
    if (office.base || office.email) {
      if (office.base) setBase(office.base)
      if (office.email) setEmail(office.email)
      seededRef.current = true
    }
  }, [office.base, office.email])

  const grouped = office.offices
  const onlineAgentIds = useMemo(
    () => new Set(office.agents.filter((a) => a.online).map((a) => a.id)),
    [office.agents]
  )

  // Remember every office slug we've ever seen so a term whose office transiently drops
  // out of a poll still resolves to its OWN bucket below (via termRegistry.listForOffice)
  // and keeps its stable `term-<slug>` React key — otherwise its <TerminalTabs> would
  // unmount and SIGKILL a live PTY. Mirrors the pre-refactor seenSlugsRef exactly; the
  // registry owns term ids but does not expose an owning-slug enumeration, so this small
  // accumulator remains a view concern (see notes).
  const seenSlugsRef = useRef<Set<string>>(new Set())
  useEffect(() => { for (const g of grouped) seenSlugsRef.current.add(g.slug) }, [grouped])

  // Offices that currently own at least one open term — each rendered as its own kept-
  // mounted <TerminalTabs> (display-toggled by selection). Includes offices momentarily
  // absent from the poll (via seenSlugsRef) so their live PTY panes are never unmounted.
  const termOffices = useMemo(() => {
    const known = new Set<string>(seenSlugsRef.current)
    for (const g of grouped) known.add(g.slug)
    return [...known].filter((s) => termRegistry.listForOffice(s).length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTerms, grouped])

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

  // ── live conversation for the focused character (shared poll, owned by the service).
  //    Keyed on STABLE primitives (slug/ref) so it doesn't re-key every 8s poll; paused
  //    (active:false) while the tab is hidden, keeping the last transcript. ──
  const conv = officeService.useOfficeMessages(
    selectedGroup?.slug ?? '',
    focusedChar?.slug ?? '',
    { active: visible }
  )
  const messages = conv.messages

  // An auth error hit by an explicit action (operate/spawn/stop). Route it through the
  // service's list refresh so the SAME keep-alive-aware guard applies: an immediate
  // officeAgents() will re-hit the auth error and officeService resolves it (soft
  // reconnect notice while live terms exist; otherwise drop to the login form).
  const handleAuthExpiry = useCallback((): void => { void officeService.refresh() }, [])

  // ── connect ──
  const connect = useCallback(async () => {
    const r = await officeService.connect(base, email, password)
    if (!('error' in r)) setPassword('')
  }, [base, email, password])

  // Rail error-box actions. Retry re-fetches the list; Reconnect re-auths in place when
  // live terminals exist (keeping them running) and only drops to login otherwise — both
  // clear the transient notices first.
  const onRetry = useCallback((): void => {
    setActionErr(''); termRegistry.clearNotice(); void officeService.refresh()
  }, [])
  const onReconnect = useCallback((): void => {
    setActionErr(''); termRegistry.clearNotice(); void officeService.reconnect()
  }, [])

  // "Stop all" broadcast (FleetView → appActions.stopAll): kill every Operate PTY via
  // the registry (log terms/tracked loops untouched). The registry owns the kill now, so
  // this works whether or not any pane is mounted.
  useEffect(() => {
    return actions.subscribeStopAll(() => termRegistry.stopAll())
  }, [actions])

  // Operate a SINGLE character in an interactive terminal. The registry prepares the
  // workspace, focuses an existing live pane, or re-mints an ended one (owning the PTY
  // id + activeId); we just surface errors and refresh the list.
  const operate = useCallback(async (a: OfficeAgent) => {
    const rid = a.officeSlug + a.id
    if (operatingId === rid) return
    setActionErr(''); setOperatingId(rid)
    try {
      const r = await termRegistry.operate(a.officeSlug, a)
      if ('error' in r) {
        if (isAuthError(r.error)) handleAuthExpiry()
        else setActionErr(r.error)
        return
      }
      void officeService.refresh()
    } finally { setOperatingId('') }
  }, [operatingId, handleAuthExpiry])

  // Spawn the WHOLE office as tracked loops (block-if-any-online); the registry opens
  // read-only log panes for the returned loops.
  const spawnOffice = useCallback(async (g: OfficeGroup) => {
    if (g.onlineCount > 0 || spawningOffice) return
    setActionErr(''); setSpawningOffice(g.slug)
    try {
      const r = await window.api.officeSpawnOffice(g.slug, g.agents.map((a) => ({ agentId: a.id, provider: a.provider || '' })))
      if ('error' in r) {
        const online = (r as { online?: string[] }).online
        const who = online && online.length ? ` (online: ${online.join(', ')})` : ''
        if (isAuthError(r.error)) handleAuthExpiry()
        else setActionErr(r.error + who)
        return
      }
      setSpawnedOffices((prev) => new Set(prev).add(g.slug))
      // Seed the local log buffer for each new loop path (registry.openLogs registers the
      // panes but does not touch the text buffer).
      for (const s of r.agents) if (!logsRef.current.has(s.path)) logsRef.current.set(s.path, '')
      termRegistry.openLogs(
        g.slug,
        g.name,
        r.agents.map((s) => ({ agentId: s.agentId, name: s.name, path: s.path, provider: s.provider }))
      )
      void officeService.refresh()
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (isAuthError(msg)) handleAuthExpiry()
      else setActionErr(msg)
    } finally { setSpawningOffice('') }
  }, [spawningOffice, handleAuthExpiry])

  const stopOffice = useCallback(async (g: OfficeGroup) => {
    if (stoppingOffice) return
    setActionErr(''); setStoppingOffice(g.slug)
    try {
      const r = await window.api.officeStopOffice(g.slug)
      if ('error' in r) {
        if (isAuthError(r.error)) handleAuthExpiry()
        else setActionErr(r.error)
        return
      }
      setSpawnedOffices((prev) => { const n = new Set(prev); n.delete(g.slug); return n })
      termRegistry.closeLogsForOffice(g.slug)
      void officeService.refresh()
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (isAuthError(msg)) handleAuthExpiry()
      else setActionErr(msg)
    } finally { setStoppingOffice('') }
  }, [stoppingOffice, handleAuthExpiry])

  // Live instant-message (steer) — NOT a queued TODO task. The service delivers it and
  // optimistically echoes our message into the shared conversation.
  const steer = useCallback(async (agentId: string, text: string) => {
    if (!agentId || !text) return
    setSteerToast('')
    const r = await officeService.steer(agentId, text)
    if ('ok' in r) setSteerToast('⚡ delivered')
    else setSteerToast(r.error || 'Could not deliver — is the character online?')
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
        void officeService.refresh()
      } else setActionErr(r?.error || 'Could not create the office')
    } catch (e) { setActionErr(String((e as Error)?.message ?? e)) }
    finally { setCreatingOffice(false) }
  }, [newOfficeName, creatingOffice])

  // Open a character in the Agents tab (2a): App brings the tab forward and
  // AgentsView resolves the office identity → local workspace and selects it.
  const openAgentTab = useCallback((a: OfficeAgent) => {
    actions.openAgent({ officeSlug: a.officeSlug, agentSlug: a.slug })
  }, [actions])

  const openBrowser = useCallback(() => {
    // No per-office deep-link is exposed; open the office root.
    // TODO(redesign): expose a per-office URL for a precise "Open in browser".
    if (office.base.trim()) void window.api.openExternal(office.base.trim())
  }, [office.base])

  // The rail's error box aggregates the action error, the service's soft keep-alive
  // notice, and the registry's reap notice.
  const boxErr = actionErr || office.listError || notice

  // ── not connected: login (shared credential form — R11/R12) ──
  if (!office.connected) {
    return (
      <SignInForm
        title="Connect to a Pixel Office"
        description="A Pixel Office is an optional shared team server — a room of remote agents you and your teammates can watch and steer together. Sign in to list and operate them. You can also run local agents on this machine without one."
        base={base}
        email={email}
        password={password}
        onBase={setBase}
        onEmail={setEmail}
        onPassword={setPassword}
        onSubmit={() => void connect()}
        loading={office.loading}
        error={office.authError}
        basePlaceholder={office.baseUrlPlaceholder}
        footer={
          <p style={{ margin: 0, fontSize: 'var(--fs-desc)', color: 'var(--tx-4)' }}>
            New here?{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                if (base.trim()) void window.api.openExternal(base.trim())
              }}
              style={{ color: 'var(--accent)' }}
            >
              Open the office
            </a>{' '}
            to create an account.
          </p>
        }
      />
    )
  }

  // ── connected: rail + detail ──
  const running = selectedGroup ? selectedGroup.onlineCount > 0 || spawnedOffices.has(selectedGroup.slug) : false
  const total = selectedGroup?.agents.length ?? 0
  const online = selectedGroup?.onlineCount ?? 0
  // Scope the operate pane to the SELECTED office (registry buckets by owning slug).
  const officeTerms = selectedGroup ? termRegistry.listForOffice(selectedGroup.slug) : []
  const operating = officeTerms.length > 0

  // Shared pane handlers — the registry owns term ids/lifecycle, so these are office-agnostic.
  const onTermExit = (id: string): void => { termRegistry.markEnded(id); void officeService.refresh() }

  // One TerminalTabs per office that has terms. ALL stay mounted (a mounted pty pane
  // === a live PTY); non-selected offices' panes are hidden with display:none so
  // switching offices never SIGKILLs a running shell. Terms whose office is momentarily
  // absent from the list keep their own hidden `term-<slug>` bucket for the same reason.
  const renderTermPane = (ots: OpenTerm[], isVisible: boolean, key: string): React.JSX.Element => {
    const oActiveId = ots.some((t) => t.id === activeId) ? activeId : (ots[0]?.id ?? '')
    const oActive = ots.find((t) => t.id === oActiveId)
    return (
      <div key={key} style={{ display: isVisible ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
        <TerminalTabs
          terms={ots}
          activeId={oActiveId}
          endedIds={endedIds as Set<string>}
          onlineAgentIds={onlineAgentIds}
          getLog={getLog}
          subscribeLog={subscribeLog}
          onSelect={termRegistry.setActiveTerm}
          onClose={termRegistry.close}
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
            <IconButton label="Refresh offices" onClick={() => void officeService.refresh()} disabled={office.loading}>
              <Icon name="refresh" size={13} />
            </IconButton>
          </div>
          <div style={{ marginTop: 6, fontSize: 'var(--fs-desc)', color: 'var(--tx-5)' }}>
            {grouped.length} office{grouped.length === 1 ? '' : 's'} · {office.agents.length} character{office.agents.length === 1 ? '' : 's'}
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
          {boxErr && (
            <div role="alert" style={{ padding: '9px 11px', background: 'var(--st-error-wash)', border: '1px solid var(--st-error-bd)', borderRadius: 'var(--r-card)', color: 'var(--st-error-bright)', fontSize: 'var(--fs-meta)' }}>
              {boxErr}
              <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                <Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button>
                <Button variant="secondary" size="sm" danger onClick={onReconnect}>Reconnect</Button>
              </div>
            </div>
          )}
          {office.loading && !office.loaded && <div style={{ padding: 16, fontSize: 'var(--fs-meta)', color: 'var(--tx-4)' }}>Loading…</div>}
          {office.loaded && grouped.length === 0 && !boxErr && (
            <div
              style={{
                padding: '16px 14px',
                background: 'var(--bg-input)',
                border: '1px solid var(--bd-card)',
                borderRadius: 'var(--r-card)',
                textAlign: 'center'
              }}
            >
              <div style={{ fontSize: 'var(--fs-meta)', fontWeight: 600, color: 'var(--tx-hi)' }}>No offices yet</div>
              <div style={{ margin: '5px 0 12px', fontSize: 'var(--fs-desc)', color: 'var(--tx-dim)', lineHeight: 1.5 }}>
                An office is a shared room your agents join as characters — they can see and message each other.
              </div>
              <Button variant="primary" size="sm" block onClick={() => setShowNewOffice(true)}>
                <Icon name="plus" size={11} /> Create your first office
              </Button>
            </div>
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
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-4)', marginTop: 2 }}>
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
                <Button variant="primary" size="sm" disabled={spawningOffice === selectedGroup.slug || online > 0} onClick={() => spawnOffice(selectedGroup)}>
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
                {termOffices.map((slug) => renderTermPane(termRegistry.listForOffice(slug), slug === selectedGroup.slug, `term-${slug}`))}
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
