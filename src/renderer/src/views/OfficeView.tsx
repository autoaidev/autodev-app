import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconButton, Icon } from '@renderer/ui'
import TerminalTabs, { OpenTerm } from '../TerminalTabs'
import { OfficeCard } from '../components/office/OfficeCard'
import { CharacterCard } from '../components/office/CharacterCard'
import { CharacterSettingsModal } from '../components/office/CharacterSettingsModal'
import { AddCharacterModal } from '../components/office/AddCharacterModal'
import { BulkModelModal, type BulkModelAdapter } from '../modals/BulkModelModal'
import { AgentStream } from '../components/office/AgentStream'
import { OfficeRoom } from '../components/office/OfficeRoom'
import { SignInForm } from '../components/office/SignInForm'
import { OfficeAgent, OfficeGroup, isAuthError } from '../components/office/officeTypes'
import * as officeService from '../services/officeService'
import * as termRegistry from '../services/termRegistry'
import { useAppActions } from '../services/appActions'
import { useAdvancedMode } from '../services/advancedMode'
import { useModelCatalog, modelLabel } from '@renderer/lib/providers'
import { providerFamily } from '@renderer/services/model'

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
const EMPTY_AGENTS: OfficeAgent[] = []

export function OfficeView({ visible = true }: { visible?: boolean } = {}): React.JSX.Element {
  // ── typed app-actions bus (stop-all subscription + open-agent dispatch) ──
  const actions = useAppActions()
  // Advanced gates the Team bulk toolbar (select-all + Set model…). Add agent,
  // per-character ⚙, Connect all / Stop all stay in Basic.
  const { advanced } = useAdvancedMode()
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

  // ── office sub-view: the per-character "Team" workspace vs the unified "Room" ──
  const [officeTab, setOfficeTab] = useState<'team' | 'room'>('team')

  // ── per-character SETTINGS editor (provider / model / name) ──
  const [settingsCharId, setSettingsCharId] = useState('')

  // ── bulk selection of characters (ids) + the two office-window management modals:
  //    a bulk Set-model over the selection, and a single-character Add. ──
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set())
  const [showBulkModel, setShowBulkModel] = useState(false)
  const [showAddChar, setShowAddChar] = useState(false)

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
  const [newOfficeDesc, setNewOfficeDesc] = useState('')
  const [genStarter, setGenStarter] = useState(false) // generate a starter team so the office isn't empty
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

  // Effective model as a friendly label for a character card (e.g. "Grok 4"), so a
  // set — or a just-applied bulk-set — model is confirmable in-app without reading
  // the DB. Empty when no model is set (the card omits the line). Mirrors AgentRail's
  // modelNameFor; the catalog is one shared, process-cached fetch.
  const { catalog } = useModelCatalog()
  const modelNameFor = useCallback(
    (a: OfficeAgent): string => (a.model ? modelLabel(catalog, providerFamily(a.provider), a.model) : ''),
    [catalog]
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

  // ── unified ROOM feed — EVERY character's conversation merged into one
  //    chronological, per-character-tagged stream (shares the same per-character
  //    poll as the focused stream above; polls only while the Room tab is shown). ──
  const roomAgents = selectedGroup?.agents ?? EMPTY_AGENTS
  const roomRefs = useMemo(() => roomAgents.map((a) => a.slug).filter(Boolean), [roomAgents])
  const room = officeService.useOfficeRoom(selectedGroup?.slug ?? '', roomRefs, {
    active: visible && officeTab === 'room'
  })

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

  // Reconnect a whole office in place — stop its loops, then connect-all again — so a
  // just-saved model (bulk Set-model) takes hold now. Office loops are office-scoped
  // (there is no per-character reconnect), so this is the honest "apply now" for the
  // bulk model follow-up: it relaunches the characters THIS app is running. Mirrors
  // spawnOffice's success wiring (log panes + spawned set) but bypasses its
  // online-guard since we've just stopped the office.
  const reconnectOffice = useCallback(async (g: OfficeGroup) => {
    setActionErr('')
    try {
      await window.api.officeStopOffice(g.slug)
      termRegistry.closeLogsForOffice(g.slug)
      const r = await window.api.officeSpawnOffice(g.slug, g.agents.map((a) => ({ agentId: a.id, provider: a.provider || '' })))
      if ('error' in r) {
        if (isAuthError(r.error)) handleAuthExpiry()
        else setActionErr(r.error)
        setSpawnedOffices((prev) => { const n = new Set(prev); n.delete(g.slug); return n })
        return
      }
      setSpawnedOffices((prev) => new Set(prev).add(g.slug))
      for (const s of r.agents) if (!logsRef.current.has(s.path)) logsRef.current.set(s.path, '')
      termRegistry.openLogs(
        g.slug,
        g.name,
        r.agents.map((s) => ({ agentId: s.agentId, name: s.name, path: s.path, provider: s.provider }))
      )
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (isAuthError(msg)) handleAuthExpiry()
      else setActionErr(msg)
    } finally {
      void officeService.refresh()
    }
  }, [handleAuthExpiry])

  // Live instant-message (steer) — NOT a queued TODO task. The service delivers it and
  // optimistically echoes our message into the shared conversation.
  const steer = useCallback(async (agentId: string, text: string) => {
    if (!agentId || !text) return
    setSteerToast('')
    const r = await officeService.steer(agentId, text)
    if ('ok' in r) setSteerToast('delivered')
    else setSteerToast(r.error || 'Could not deliver — is the character online?')
    setTimeout(() => setSteerToast(''), 4000)
  }, [])

  const createOffice = useCallback(async () => {
    const name = newOfficeName.trim()
    if (!name || creatingOffice) return
    setCreatingOffice(true)
    try {
      const desc = newOfficeDesc.trim()
      const r = (await window.api.officeCreateOffice(name, desc)) as { ok?: boolean; office?: { slug: string; id: number }; error?: string }
      if (r?.ok && r.office) {
        // Optionally seed a starter team so a fresh office isn't empty (reuses the
        // same office-backed AI generation Make-app uses). Best-effort: a failure
        // to generate still leaves the created office selected.
        let seeded = false
        // Seed from the description when given, else fall back to the office name
        // (the name alone is a fine prompt — e.g. "railroad research"), so the
        // starter-team option works even when the optional description is blank.
        const seed = desc || name
        if (genStarter && seed && typeof r.office.id === 'number') {
          try { await window.api.officeGenerateTeam(r.office.id, seed, 4); seeded = true } catch { /* keep the empty office */ }
        }
        setNewOfficeName(''); setNewOfficeDesc(''); setGenStarter(false); setShowNewOffice(false)
        // Refresh BEFORE selecting so the new office (empty offices now fold into the
        // rail) is already in the list — otherwise the keep-selection-valid effect
        // would bounce the selection back to grouped[0]. Then land on its Team tab so
        // the very next step ("Add agent") is right there, and confirm with a toast so
        // a silent success can't read as a failure and invite a duplicate create.
        await officeService.refresh()
        if (r.office.slug) { setSelectedSlug(r.office.slug); setOfficeTab('team') }
        actions.toast(seeded ? `Office “${name}” created with a starter team` : `Office “${name}” created — add its first agent`)
      } else setActionErr(r?.error || 'Could not create the office')
    } catch (e) { setActionErr(String((e as Error)?.message ?? e)) }
    finally { setCreatingOffice(false) }
  }, [newOfficeName, newOfficeDesc, genStarter, creatingOffice, actions])

  // Open a character in the Agents tab (2a): App brings the tab forward and
  // AgentsView resolves the office identity → local workspace and selects it.
  const openAgentTab = useCallback((a: OfficeAgent) => {
    actions.openAgent({ officeSlug: a.officeSlug, agentSlug: a.slug })
  }, [actions])

  const openBrowser = useCallback(() => {
    // Deep-link straight to the selected office's map (D2) instead of the server
    // root, so "Open in browser" / "Open map" lands on THIS office. Falls back to
    // the root only when there's no selected office to target.
    const root = office.base.trim()
    if (!root) return
    const slug = selectedGroup?.slug
    const url = slug ? `${root.replace(/\/+$/, '')}/office/${slug}` : root
    void window.api.openExternal(url)
  }, [office.base, selectedGroup])

  // ── bulk selection (character ids) — scoped to the SELECTED office (the team grid
  //    shows one office at a time), so a stale id can't leak across offices. ──
  const toggleBulk = useCallback((id: string) => {
    setBulkSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }, [])
  useEffect(() => { setBulkSelected(new Set()) }, [selectedSlug])
  // Drop ids that no longer exist in the selected office (deleted / office switched).
  const selectedIds = useMemo(() => {
    const live = new Set((selectedGroup?.agents ?? []).map((a) => a.id))
    return [...bulkSelected].filter((id) => live.has(id))
  }, [bulkSelected, selectedGroup])
  const allSelected = !!selectedGroup && selectedGroup.agents.length > 0 && selectedIds.length === selectedGroup.agents.length

  // The office backend for the shared BulkModelModal: persist each character's model
  // via the OFFICE path (updateCharacter → PATCH /api/agents/{id}), NOT `config set`.
  // Each character keeps its OWN provider (mixed-provider aware); the follow-up
  // reconnects the office so ONLINE characters pick up the new model now.
  const bulkAdapter = useMemo<BulkModelAdapter>(() => {
    const chosen = (selectedGroup?.agents ?? []).filter((a) => bulkSelected.has(a.id))
    return {
      unit: 'character',
      // Characters CAN switch engine — the office API stores the provider FAMILY, so
      // a conversion is a `updateCharacter({ provider: family, model })` (the same
      // write the per-character CharacterSettingsModal makes), identity preserved.
      canSetProvider: true,
      items: chosen.map((a) => ({ key: a.id, provider: a.provider || 'claude', active: !!a.online })),
      setModel: async (item, model, family) => {
        const r = await officeService.updateCharacter(item.key, family ? { provider: family, model } : { model })
        return 'ok' in r
      },
      applyNow: {
        subtitle: (n) => `${n} online character${n === 1 ? '' : 's'} · reconnect to apply now`,
        body: (n) =>
          `Model saved to the office. An online character keeps its current model until it reconnects — reconnect this office to relaunch the ${n} online character${n === 1 ? '' : 's'} on the new model now, or leave them to pick it up on their next connect.`,
        buttonLabel: (n) => `Reconnect ${n} online`,
        pendingLabel: 'Reconnecting…',
        toast: () => 'Reconnecting this office…',
        run: async () => { if (selectedGroup) await reconnectOffice(selectedGroup) }
      }
    }
  }, [selectedGroup, bulkSelected, reconnectOffice])

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
        basePlaceholder={office.baseUrlPlaceholder && office.baseUrlPlaceholder !== 'https://…' ? office.baseUrlPlaceholder : undefined}
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
            <form onSubmit={(e) => { e.preventDefault(); void createOffice() }} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              <input
                value={newOfficeName}
                onChange={(e) => setNewOfficeName(e.target.value)}
                placeholder="Office name…"
                aria-label="New office name"
                autoFocus
                disabled={creatingOffice}
                style={{
                  minWidth: 0, padding: '6px 9px', background: 'var(--bg-input)',
                  border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)', color: 'var(--tx-1)',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-meta)'
                }}
              />
              <textarea
                value={newOfficeDesc}
                onChange={(e) => setNewOfficeDesc(e.target.value)}
                placeholder="What is this office for? (optional — used to generate a starter team)"
                aria-label="New office description"
                rows={2}
                disabled={creatingOffice}
                style={{
                  minWidth: 0, padding: '6px 9px', background: 'var(--bg-input)', resize: 'vertical',
                  border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)', color: 'var(--tx-1)',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-meta)'
                }}
              />
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 'var(--fs-desc)', color: 'var(--tx-2)', cursor: creatingOffice ? 'default' : 'pointer' }}>
                <input type="checkbox" checked={genStarter} disabled={creatingOffice || !(newOfficeDesc.trim() || newOfficeName.trim())} onChange={(e) => setGenStarter(e.target.checked)} style={{ marginTop: 2 }} />
                <span>
                  Generate a starter team
                  <span style={{ display: 'block', color: 'var(--tx-dim)' }}>Otherwise the office starts empty. Uses your description, or the office name.</span>
                </span>
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <Button variant="primary" size="sm" type="submit" disabled={creatingOffice || !newOfficeName.trim()}>
                  {creatingOffice ? (genStarter ? 'Creating & generating…' : 'Creating…') : 'Create office'}
                </Button>
                <Button variant="secondary" size="sm" type="button" disabled={creatingOffice} onClick={() => { setShowNewOffice(false); setNewOfficeDesc(''); setGenStarter(false) }}>
                  Cancel
                </Button>
              </div>
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
              {/* Team | Room sub-view toggle — Room is the unified all-character stream */}
              <div role="tablist" aria-label="Office view" style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--bg-input)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-card)' }}>
                {(['team', 'room'] as const).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={officeTab === t}
                    onClick={() => setOfficeTab(t)}
                    style={{
                      padding: '4px 12px',
                      borderRadius: 'var(--r-input)',
                      border: 'none',
                      cursor: 'pointer',
                      background: officeTab === t ? 'var(--bg-panel)' : 'transparent',
                      color: officeTab === t ? 'var(--tx-hi)' : 'var(--tx-4)',
                      fontFamily: 'var(--font-sans)',
                      fontSize: 'var(--fs-meta)',
                      fontWeight: 600,
                      boxShadow: officeTab === t ? 'inset 0 0 0 1px var(--bd-panel-sel)' : undefined
                    }}
                  >
                    {t === 'team' ? 'Team' : 'Room'}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1 }} />
              {steerToast && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-desc)', color: steerToast === 'delivered' ? 'var(--st-running)' : 'var(--st-error)', whiteSpace: 'nowrap' }}>
                  {steerToast === 'delivered' && <Icon name="bolt" size={11} />}{steerToast}
                </span>
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

            {/* team management toolbar — bulk-select + the two single-office actions
                (Add one character, Set model across the selection). A Team-view concern. */}
            <div
              style={{
                display: officeTab === 'team' ? 'flex' : 'none',
                alignItems: 'center',
                gap: 10,
                padding: '10px 18px 0',
                flexWrap: 'wrap'
              }}
            >
              {/* Bulk-select + Set model… is an Advanced power tool; Basic keeps the
                  toolbar to "Add agent" (per-character ⚙ handles a single character). */}
              {advanced && (
                <>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--fs-meta)', color: 'var(--tx-3)', cursor: selectedGroup.agents.length ? 'pointer' : 'default', userSelect: 'none' }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      disabled={selectedGroup.agents.length === 0}
                      ref={(el) => { if (el) el.indeterminate = selectedIds.length > 0 && !allSelected }}
                      onChange={(e) => setBulkSelected(e.target.checked ? new Set(selectedGroup.agents.map((a) => a.id)) : new Set())}
                      aria-label="Select all characters"
                      style={{ cursor: 'pointer', margin: 0 }}
                    />
                    {selectedIds.length > 0 ? `${selectedIds.length} selected` : 'Select'}
                  </label>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={selectedIds.length === 0}
                    onClick={() => setShowBulkModel(true)}
                    title={selectedIds.length === 0 ? 'Select characters to set a model' : 'Set the model across the selected characters'}
                  >
                    Set model…
                  </Button>
                  {selectedIds.length > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => setBulkSelected(new Set())}>Clear</Button>
                  )}
                </>
              )}
              <div style={{ flex: 1 }} />
              <Button variant="primary" size="sm" onClick={() => setShowAddChar(true)} title={`Add one character to ${selectedGroup.name}`}>
                <Icon name="plus" size={11} /> Add agent
              </Button>
            </div>

            {/* character grid — a Team-view concern (hidden in the Room stream) */}
            <div
              style={{
                display: officeTab === 'team' ? 'grid' : 'none',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 16,
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
                  onSettings={() => { setFocusedId(a.id); setSettingsCharId(a.id) }}
                  modelLabel={modelNameFor(a)}
                  selectable={advanced}
                  checked={bulkSelected.has(a.id)}
                  onToggleSelect={() => toggleBulk(a.id)}
                />
              ))}
              {/* create-character tile — opens the single-character Add modal (name +
                  engine/model + face), distinct from the "Generate team" wizard. */}
              <NewCharacterTile officeName={selectedGroup.name} onClick={() => setShowAddChar(true)} />
            </div>

            {/* lower area: TEAM (focused stream / live terminals) or the unified ROOM.
                The Team container is kept MOUNTED (display-toggled) so switching to the
                Room tab never unmounts — and SIGKILLs — a live Operate PTY. */}
            <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
              <div style={{ display: officeTab === 'team' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
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
                    advanced={advanced}
                  />
                ) : (
                  <div style={{ margin: 'auto', color: 'var(--tx-4)', fontSize: 'var(--fs-meta)' }}>No character selected.</div>
                ))}
              </div>

              {officeTab === 'room' && (
                <OfficeRoom
                  officeName={selectedGroup.name}
                  agents={selectedGroup.agents}
                  entries={room.entries}
                  loading={room.loading}
                  onSend={(agentId, t) => steer(agentId, t)}
                />
              )}
            </div>
          </>
        )}
      </div>

      {/* Per-character SETTINGS editor — provider / model / name, saved through the
          office API (officeService.updateCharacter). Resolved from the live list so
          it always edits the current character (survives polls). */}
      <CharacterSettingsModal
        // Resolve from the flat store list OR the selected office's roster (both
        // include OFFLINE and just-added optimistic characters) so the ⚙ gear opens
        // a functional editor regardless of the character's connection state — an
        // offline character's model must stay viewable/editable.
        agent={
          office.agents.find((a) => a.id === settingsCharId) ??
          selectedGroup?.agents.find((a) => a.id === settingsCharId) ??
          null
        }
        open={!!settingsCharId}
        onClose={() => setSettingsCharId('')}
      />

      {/* Bulk Set-model across the selected characters — persisted via the OFFICE path
          (updateCharacter), mixed-provider aware, with a reconnect-office follow-up. */}
      <BulkModelModal
        open={showBulkModel}
        adapter={bulkAdapter}
        onClose={() => setShowBulkModel(false)}
        onApplied={() => { setShowBulkModel(false); setBulkSelected(new Set()) }}
      />

      {/* Add ONE character to the selected office (distinct from Generate team). */}
      {selectedGroup && (
        <AddCharacterModal
          open={showAddChar}
          officeSlug={selectedGroup.slug}
          officeName={selectedGroup.name}
          existingCount={selectedGroup.agents.length}
          onClose={() => setShowAddChar(false)}
          onCreated={({ id }) => { setFocusedId(id); void officeService.refresh() }}
        />
      )}
    </div>
  )
}

/** The steer input under an active Operate terminal (its own local text state). */
function TermSteer({ disabled, name, onSend }: { disabled: boolean; name: string; onSend: (t: string) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <>
      <span title="Live instant-message (steer)" style={{ display: 'inline-flex', color: 'var(--role-violet)' }}><Icon name="bolt" size={13} /></span>
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
          flex: 1, minWidth: 0, background: 'var(--bg-input)', border: '1px solid var(--bd-1)',
          borderRadius: 'var(--r-card)', padding: '7px 11px', color: 'var(--tx-1)',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)'
        }}
      />
      <Button variant="primary" size="sm" disabled={disabled || !text.trim()} onClick={() => { const t = text.trim(); if (t) { onSend(t); setText('') } }}>
        <Icon name="bolt" size={12} /> Send
      </Button>
    </>
  )
}

/**
 * Create-character dashed tile — a launcher for the single-character Add modal
 * (name + engine/model + face). The rich create flow lives in AddCharacterModal;
 * this is just the in-grid affordance that opens it (there's also an "Add agent"
 * button in the team toolbar). Distinct from the "Generate team" wizard.
 */
function NewCharacterTile({ officeName, onClick }: { officeName: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Add a character to ${officeName}`}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 6, padding: '10px 11px', borderRadius: 'var(--r-card)', background: 'var(--bg-2)',
        border: '1px dashed var(--bd-idle-box)', color: 'var(--tx-4)', minHeight: 78, cursor: 'pointer'
      }}
    >
      <Icon name="plus" size={14} />
      <span style={{ fontSize: 'var(--fs-desc)' }}>New character</span>
    </button>
  )
}

export default OfficeView
