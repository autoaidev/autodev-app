import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal, Button, ProviderChip } from '@renderer/ui'
import { OfficeAgent } from './officeTypes'
import { PROVIDER_FAMILIES, providerAccent, providerFamilyOf, type ProviderFamily } from '@renderer/services/identity'
import { MODEL_KEY, modelSuggestionsFor } from '@renderer/lib/providers'
import * as officeService from '@renderer/services/officeService'

/**
 * CharacterSettingsModal — the SETTINGS editor for ONE office character (2c).
 *
 * Reached from a character card's ⚙ affordance. Unlike AgentConfigModal (which
 * edits a LOCAL workspace via `autodev config set`), an office character has no
 * local path: its provider/model/name live in the pixel-office DB, so this saves
 * through the office API (officeService.updateCharacter → PATCH /api/agents/{id}).
 * That single server-side write is the source of truth the card badge reads on the
 * next poll AND the value spawn/operate launch the loop with — so changing the
 * engine keeps the character's identity (id/slug/key) intact (provider-portable).
 *
 * We deliberately reuse the shared vocabulary: identity's PROVIDER_FAMILIES /
 * providerAccent (the same brand hues the avatar ring + ProviderChip use, so the
 * editor's selection recolors exactly like the card badge will) and providers.ts'
 * MODEL_KEY / MODEL_SUGGESTIONS (the model-hint datalist). Editable: provider
 * FAMILY (the office character's provider is a family, not a `-tui/-cli` variant —
 * the variant is chosen at operate time), model, and display name.
 */

const label: React.CSSProperties = {
  display: 'block', fontSize: 'var(--fs-section)', fontWeight: 600, letterSpacing: 'var(--ls-section)',
  textTransform: 'uppercase', color: 'var(--tx-dim)', marginBottom: 6
}
const inputStyle: React.CSSProperties = {
  width: '100%', background: 'var(--bg-input)', border: '1px solid var(--bd-1)', borderRadius: 'var(--r-input)',
  color: 'var(--tx-1)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-body)', padding: '7px 9px', outline: 'none'
}

export interface CharacterSettingsModalProps {
  agent: OfficeAgent | null
  open: boolean
  onClose: () => void
}

export function CharacterSettingsModal({ agent, open, onClose }: CharacterSettingsModalProps): React.JSX.Element {
  const [family, setFamily] = useState<ProviderFamily>('claude')
  const [model, setModel] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  // Seed from the live character on open. providerFamilyOf coerces a `-tui/-cli`
  // id OR a bare family down to the family the selector edits.
  useEffect(() => {
    if (!open || !agent) return
    setStatus('')
    const fam = providerFamilyOf(agent.provider)
    setFamily(fam === 'unknown' ? 'claude' : fam)
    setModel(agent.model ?? '')
    setName(agent.name ?? '')
  }, [open, agent])

  const modelKey = MODEL_KEY[family] ?? 'claudeModel'
  const suggestions = useMemo(() => modelSuggestionsFor(family), [family])
  const listId = 'char-model-suggest'

  const save = useCallback(async (): Promise<void> => {
    if (!agent) return
    setBusy(true); setStatus('')
    const patch: { provider?: string; model?: string; name?: string } = { provider: family, model }
    const trimmed = name.trim()
    if (trimmed && trimmed !== agent.name) patch.name = trimmed
    const r = await officeService.updateCharacter(agent.id, patch)
    setBusy(false)
    if ('error' in r) { setStatus(r.error); return }
    setStatus(agent.online
      ? 'Saved — reconnect this character to run on the new engine.'
      : 'Saved.')
  }, [agent, family, model, name])

  const agentName = name || agent?.name || 'Character'

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={468}
      title={<>{agentName} <span style={{ color: 'var(--tx-5)', fontWeight: 400 }}>· settings</span></>}
      subtitle="provider changes apply on the next connect"
      subtitleMono
      footer={
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {status && <span style={{ fontSize: 'var(--fs-meta)', color: status.startsWith('Saved') ? 'var(--st-running)' : 'var(--st-error)' }}>{status}</span>}
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !agent}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      }
    >
      {/* DISPLAY NAME */}
      <div style={{ marginBottom: 16 }}>
        <span style={label}>Display name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={agent?.name || 'Character name'}
          aria-label="Character display name"
          style={inputStyle}
        />
      </div>

      {/* PROVIDER — the four families, each recoloring to its brand accent when picked.
          The selected chip mirrors exactly how the card badge/avatar ring will look. */}
      <div style={{ marginBottom: 6 }}>
        <span style={label}>Provider</span>
        <div role="radiogroup" aria-label="Provider" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {PROVIDER_FAMILIES.map((fam) => {
            const accent = providerAccent(fam)
            const on = family === fam
            return (
              <button
                key={fam}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setFamily(fam)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                  padding: '10px 6px', borderRadius: 'var(--r-card)', cursor: 'pointer',
                  background: on ? accent.tint : 'var(--bg-input)',
                  border: `1px solid ${on ? accent.fg : 'var(--bd-1)'}`,
                  boxShadow: on ? `inset 0 0 0 1px ${accent.ring}` : undefined,
                  color: on ? accent.ink : 'var(--tx-3)',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-meta)', fontWeight: 600,
                  outline: 'none'
                }}
              >
                <ProviderChip provider={fam} compact />
              </button>
            )
          })}
        </div>
      </div>
      <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginBottom: 16 }}>
        The character keeps its name and identity — only the engine changes.
      </div>

      {/* MODEL */}
      <div style={{ marginBottom: 4 }}>
        <span style={label}>Model ({modelKey})</span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="(provider default)"
          aria-label="Model"
          list={suggestions.length ? listId : undefined}
          style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-meta)' }}
        />
        {suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.map((m) => <option key={m} value={m} />)}
          </datalist>
        )}
      </div>
      <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)' }}>
        Leave empty for the provider's default model.
      </div>
    </Modal>
  )
}

export default CharacterSettingsModal
