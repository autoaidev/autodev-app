import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button, ProviderChip } from '@renderer/ui'
import { ModelSelect } from '@renderer/components/ModelSelect'
import { PROVIDER_FAMILIES, providerAccent, type ProviderFamily } from '@renderer/services/identity'
import { useDefaultModels, defaultModelFor } from '@renderer/lib/providers'
import * as officeService from '@renderer/services/officeService'
import { useAppActions } from '@renderer/services/appActions'

/**
 * AddCharacterModal — create ONE office character from the office manage window.
 *
 * This is the SINGLE-character add, deliberately distinct from the "Generate a
 * starter team" wizard (which AI-authors a whole roster from a description). Here
 * the user names one character, picks its engine + model, and (optionally) a face,
 * and it's created in the selected office.
 *
 * It reuses the same vocabulary as CharacterSettingsModal — identity's
 * PROVIDER_FAMILIES / providerAccent + ProviderChip (the brand hues the avatar ring
 * and card badge use) and the shared ModelSelect. The model seeds from the
 * per-vendor default-model preference (Settings → wave 2) so a house model is
 * inherited without picking it every time.
 *
 * Create path (no server round-trip is duplicated):
 *   1. officeCreateCharacter(officeId, name, { avatarIndex, color, emoji })  → id/slug
 *   2. updateCharacter(id, { provider, model })  → PATCH the chosen engine/model in
 * The numeric officeId isn't carried on the folded OfficeGroup, so we resolve it on
 * demand from officeOffices() by slug (mirrors the old inline create tile).
 *
 * A second mode — "Generate team" — AI-authors N complementary teammates in one
 * shot via officeGenerateTeam(officeId, prompt, count). The pixel-office
 * /api/agents/generate endpoint already seeds the LLM with the office's existing
 * roster names ("Do NOT reuse these existing names …"), so duplicate roles are
 * avoided SERVER-SIDE from the officeId alone; we keep a client-side dedupe check
 * purely to surface a note if the model repeats a name anyway.
 */

/** A small, distinct default palette (hex, office `color` shape) + emoji faces. */
const COLORS = ['#00d4ff', '#7c5cff', '#ff8a5c', '#31c48d', '#f6c445', '#ff6b9d', '#4dabf7', '#b197fc']
const EMOJIS = ['🤖', '🦊', '🐙', '🦉', '🐝', '🐬', '🦁', '🐸', '🦄', '👾', '🧠', '⚡']

const label: React.CSSProperties = {
  display: 'block', fontSize: 'var(--fs-section)', fontWeight: 600, letterSpacing: 'var(--ls-section)',
  textTransform: 'uppercase', color: 'var(--tx-dim)', marginBottom: 6
}
const inputStyle: React.CSSProperties = {
  width: '100%', background: 'var(--bg-input)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)',
  color: 'var(--tx-1)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)', padding: '7px 9px', outline: 'none'
}

export interface AddCharacterModalProps {
  open: boolean
  officeSlug: string
  officeName: string
  /** Current character count in the office — rotates the default face/hue so a fresh
   *  character isn't identical to the last one. */
  existingCount: number
  /** The office's existing character names — used ONLY for a client-side dedupe
   *  note after a team generation (server-side avoidance is the primary guard). */
  existingNames?: string[]
  onClose: () => void
  onCreated: (agent: { id: string; slug: string }) => void
  /** Called after a successful team generation so the office can refresh its roster. */
  onTeamGenerated?: (count: number) => void
}

export function AddCharacterModal({
  open,
  officeSlug,
  officeName,
  existingCount,
  existingNames = [],
  onClose,
  onCreated,
  onTeamGenerated
}: AddCharacterModalProps): React.JSX.Element {
  const { defaults } = useDefaultModels()
  const actions = useAppActions()

  // Two modes in one modal: "one" adds a single hand-configured character; "team"
  // AI-authors a whole complementary roster (no duplicate roles vs the office).
  const [mode, setMode] = useState<'one' | 'team'>('one')
  const [name, setName] = useState('')
  const [family, setFamily] = useState<ProviderFamily>('claude')
  const [model, setModel] = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [emoji, setEmoji] = useState(EMOJIS[0])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  // Generate-team inputs.
  const [teamPrompt, setTeamPrompt] = useState('')
  const [teamCount, setTeamCount] = useState(3)
  // Track whether the user hand-edited the model, so a family switch can re-seed the
  // default without clobbering a deliberate choice.
  const [modelTouched, setModelTouched] = useState(false)

  // Seed a fresh, distinct-looking character ONCE per open (rotate face/hue by count)
  // and seed the model from the house default for the initial family. Guarded by a
  // ref so the office's 8s roster poll — which re-supplies `existingCount`/`defaults`
  // while the modal is open — can't reset a half-typed character.
  const seeded = useRef(false)
  useEffect(() => {
    if (!open) { seeded.current = false; return }
    if (seeded.current) return
    seeded.current = true
    setMode('one')
    setName('')
    setFamily('claude')
    setColor(COLORS[existingCount % COLORS.length])
    setEmoji(EMOJIS[existingCount % EMOJIS.length])
    setModel(defaultModelFor(defaults, 'claude'))
    setModelTouched(false)
    setTeamPrompt('')
    setTeamCount(3)
    setBusy(false)
    setStatus('')
  }, [open, existingCount, defaults])

  // On a provider switch, re-seed the model from that vendor's house default unless
  // the user already typed one (a grok id must never carry into a claude character).
  const onFamily = (fam: ProviderFamily): void => {
    setFamily(fam)
    if (!modelTouched) setModel(defaultModelFor(defaults, fam))
  }

  const avatarIndex = useMemo(() => existingCount % 7, [existingCount])

  const create = async (): Promise<void> => {
    const nm = name.trim()
    if (!nm || busy) return
    setBusy(true)
    setStatus('')
    try {
      const list = (await window.api.officeOffices()) as Array<{ slug: string; id: number }>
      const off = Array.isArray(list) ? list.find((o) => o.slug === officeSlug) : undefined
      if (!off) {
        setStatus('Could not resolve this office to add a character.')
        return
      }
      const created = (await window.api.officeCreateCharacter(off.id, nm, { avatarIndex, color, emoji })) as {
        ok?: boolean
        id?: string
        slug?: string
        error?: string
      }
      if (created?.error || !created?.id) {
        setStatus(created?.error || 'Could not create the character.')
        return
      }
      // Persist the chosen engine + model on the new row (createCharacter sets neither).
      // grok runs two ways — default a NEW grok character to the persistent ACP runner
      // (grok-acp) rather than the bare family (which would operate as TUI); every other
      // family stores its bare family (the runner, where it has one, is chosen later).
      const providerId = family === 'grok' ? 'grok-acp' : family
      const r = await officeService.updateCharacter(created.id, { provider: providerId, model })
      if ('error' in r) {
        // The character exists — only the engine write failed; surface it but still
        // hand the row back so the roster shows it.
        setStatus(r.error)
      }
      // Optimistically insert the new character's card NOW so it appears immediately
      // (in its offline/pending state) instead of ~5s later on the next WS round-trip
      // — a silent delay reads as failure and invites double-submits. The store
      // reconciles this placeholder to the real row on the next poll (matched by id).
      officeService.insertOptimisticCharacter({
        office: officeName,
        officeSlug,
        id: created.id,
        name: nm,
        slug: String(created.slug ?? ''),
        online: false,
        status: 'just added',
        provider: providerId,
        model,
        avatarIndex,
        color,
        emoji
      })
      onCreated({ id: created.id, slug: String(created.slug ?? '') })
      onClose()
    } catch (e) {
      setStatus(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  // GENERATE TEAM — AI-author N complementary teammates in one shot. Server-side
  // avoidance (the endpoint seeds the LLM with the office roster) keeps roles
  // distinct; we additionally dedupe client-side to surface a note if the model
  // repeats an existing name anyway.
  const generateTeam = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setStatus('')
    try {
      const list = (await window.api.officeOffices()) as Array<{ slug: string; id: number }>
      const off = Array.isArray(list) ? list.find((o) => o.slug === officeSlug) : undefined
      if (!off) {
        setStatus('Could not resolve this office to generate a team.')
        return
      }
      const count = Math.max(1, Math.min(12, teamCount || 1))
      const r = (await window.api.officeGenerateTeam(off.id, teamPrompt.trim(), count)) as {
        ok?: boolean
        agents?: Array<{ id?: string; slug?: string; name?: string; role?: string }>
        error?: string
      }
      if (r?.error || !r?.ok) {
        setStatus(r?.error || 'Could not generate the team.')
        return
      }
      const created = Array.isArray(r.agents) ? r.agents : []
      // Client-side dedupe check (safety net over the server's avoid-list): count how
      // many generated names collide with the existing roster, case-insensitively.
      const existing = new Set(existingNames.map((n) => n.trim().toLowerCase()).filter(Boolean))
      const dupes = created.filter((a) => existing.has(String(a?.name ?? '').trim().toLowerCase())).length
      onTeamGenerated?.(created.length)
      void officeService.refresh()
      const note = dupes > 0 ? ` (${dupes} matched an existing role)` : ''
      actions.toast(`Generated ${created.length} character${created.length === 1 ? '' : 's'}${note}`)
      onClose()
    } catch (e) {
      setStatus(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const accent = providerAccent(family)

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={468}
      title={<>Add a character <span style={{ color: 'var(--tx-5)', fontWeight: 400 }}>· {officeName}</span></>}
      subtitle={mode === 'one' ? 'one new character — pick its engine and face' : 'AI-author a complementary team — no duplicate roles'}
      subtitleMono
      footer={
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {status && <span style={{ fontSize: 'var(--fs-meta)', color: status.startsWith('Saved') ? 'var(--st-running)' : 'var(--st-error)' }}>{status}</span>}
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          {mode === 'one' ? (
            <Button variant="primary" onClick={() => void create()} disabled={busy || !name.trim()}>
              {busy ? 'Adding…' : 'Add character'}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void generateTeam()} disabled={busy}>
              {busy ? 'Generating…' : 'Generate team'}
            </Button>
          )}
        </div>
      }
    >
      {/* MODE TOGGLE — "Add one" hand-configures a single character; "Generate team"
          AI-authors a whole complementary roster. */}
      <div role="tablist" aria-label="Add mode" style={{ display: 'flex', gap: 6, padding: 3, marginBottom: 16, background: 'var(--bg-input)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-card)' }}>
        {([['one', 'Add one'], ['team', 'Generate team']] as const).map(([m, lbl]) => {
          const on = mode === m
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => { if (!busy) { setMode(m); setStatus('') } }}
              disabled={busy}
              style={{
                flex: 1, padding: '7px 10px', borderRadius: 'calc(var(--r-card) - 2px)', cursor: busy ? 'default' : 'pointer',
                background: on ? 'var(--bg-panel)' : 'transparent',
                border: `1px solid ${on ? 'var(--accent)' : 'transparent'}`,
                color: on ? 'var(--tx-1)' : 'var(--tx-4)',
                fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)', fontWeight: 600, outline: 'none'
              }}
            >
              {lbl}
            </button>
          )
        })}
      </div>

      {mode === 'one' && (<>
      {/* NAME + FACE — the face preview sits beside the name so the identity reads at a glance. */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16 }}>
        <div
          aria-hidden
          style={{
            width: 40, height: 40, flex: 'none', borderRadius: 'var(--r-card)',
            background: color, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, boxShadow: `0 0 0 2px ${accent.ring}`
          }}
        >
          {emoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={label}>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 20))}
            placeholder="Character name…"
            aria-label="New character name"
            autoFocus
            maxLength={20}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { e.preventDefault(); void create() } }}
            style={inputStyle}
          />
        </div>
      </div>

      {/* PROVIDER — the four families, recoloring to the brand accent when picked. */}
      <div style={{ marginBottom: 12 }}>
        <span style={label}>Provider</span>
        <div role="radiogroup" aria-label="Provider" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {PROVIDER_FAMILIES.map((fam) => {
            const acc = providerAccent(fam)
            const on = family === fam
            return (
              <button
                key={fam}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onFamily(fam)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                  padding: '10px 6px', borderRadius: 'var(--r-card)', cursor: 'pointer',
                  background: on ? acc.tint : 'var(--bg-input)',
                  border: `1px solid ${on ? acc.fg : 'var(--bd-1)'}`,
                  boxShadow: on ? `inset 0 0 0 1px ${acc.ring}` : undefined,
                  color: on ? acc.ink : 'var(--tx-3)',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-meta)', fontWeight: 600, outline: 'none'
                }}
              >
                <ProviderChip provider={fam} compact />
              </button>
            )
          })}
        </div>
      </div>

      {/* MODEL */}
      <div style={{ marginBottom: 16 }}>
        <span style={label}>Model</span>
        <ModelSelect vendor={family} value={model} onChange={(v) => { setModel(v); setModelTouched(true) }} />
        <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginTop: 6 }}>
          Leave as Provider default to use the engine&rsquo;s own model.
        </div>
      </div>

      {/* APPEARANCE — optional; sensible distinct defaults are pre-filled. */}
      <div style={{ marginBottom: 4 }}>
        <span style={label}>Face</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              aria-label={`Face ${e}`}
              aria-pressed={emoji === e}
              onClick={() => setEmoji(e)}
              style={{
                width: 30, height: 30, borderRadius: 'var(--r-input)', cursor: 'pointer', fontSize: 16,
                background: emoji === e ? 'var(--bg-panel)' : 'var(--bg-input)',
                border: `1px solid ${emoji === e ? 'var(--accent)' : 'var(--bd-1)'}`
              }}
            >
              {e}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
              style={{
                width: 24, height: 24, borderRadius: '50%', cursor: 'pointer', background: c,
                border: color === c ? '2px solid var(--tx-hi)' : '2px solid transparent',
                boxShadow: color === c ? '0 0 0 1px var(--bd-1)' : undefined
              }}
            />
          ))}
        </div>
      </div>
      </>)}

      {mode === 'team' && (
        <div>
          {/* DESCRIPTION — what the team should do. Optional; the office name seeds a
              default server-side when left blank. */}
          <div style={{ marginBottom: 16 }}>
            <span style={label}>What should this team do?</span>
            <textarea
              value={teamPrompt}
              onChange={(e) => setTeamPrompt(e.target.value.slice(0, 600))}
              placeholder="e.g. ship and support a mobile game — design, engineering, QA, community…"
              aria-label="Team description"
              rows={3}
              maxLength={600}
              style={{ ...inputStyle, resize: 'vertical', minHeight: 66, fontFamily: 'var(--font-sans)' }}
            />
            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginTop: 6 }}>
              New roles avoid your {existingNames.length} existing character{existingNames.length === 1 ? '' : 's'} — no duplicate roles.
            </div>
          </div>

          {/* COUNT — how many teammates to author (1–12). */}
          <div style={{ marginBottom: 4 }}>
            <span style={label}>How many teammates?</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="number"
                min={1}
                max={12}
                value={teamCount}
                onChange={(e) => setTeamCount(Math.max(1, Math.min(12, Number(e.target.value) || 1)))}
                aria-label="Number of teammates to generate"
                style={{ ...inputStyle, width: 90 }}
              />
              <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)' }}>complementary AI workers</span>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

export default AddCharacterModal
