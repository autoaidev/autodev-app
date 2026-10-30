import React, { useCallback, useEffect, useState } from 'react'
import { Modal, Button, ProviderChip, Icon } from '@renderer/ui'
import { OfficeAgent } from './officeTypes'
import { PROVIDER_FAMILIES, providerAccent, providerFamilyOf, type ProviderFamily } from '@renderer/services/identity'
import { ModelSelect } from '@renderer/components/ModelSelect'
import { McpEditorModal } from '@renderer/modals/McpEditorModal'
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
 * MODEL_KEY + the live model catalog (via ModelSelect). Editable: provider
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
  // grok runs two ways: the per-turn TUI (grok --continue) or the persistent ACP
  // session (grok-acp). The office stores the family for the other engines, but the
  // grok RUNNER is a real behavioural choice, so it's a stored variant here. ACP is
  // the default runner (persistent session) — only an explicit grok-tui opts out.
  const [grokAcp, setGrokAcp] = useState(true)
  const [model, setModel] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  // Per-character MCP editor (item 4): resolves the character's OWN Operate/loop
  // scratch workspace, then reuses the shared McpEditorModal scoped to that dir so
  // add/enable/disable/remove land in the SAME .mcp.json the loop/operate launch uses.
  const [mcpPath, setMcpPath] = useState<string | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpErr, setMcpErr] = useState('')

  // Seed from the live character on open. providerFamilyOf coerces a `-tui/-cli`
  // id OR a bare family down to the family the selector edits.
  useEffect(() => {
    if (!open || !agent) return
    setStatus('')
    const fam = providerFamilyOf(agent.provider)
    setFamily(fam === 'unknown' ? 'claude' : fam)
    // Seed the runner from the stored provider: an explicit grok-tui stays TUI; a
    // stored grok-acp stays ACP; a bare `grok` family (runner not pinned) or any
    // unset value defaults to ACP — the persistent session is now the default runner.
    setGrokAcp(String(agent.provider ?? '').toLowerCase() !== 'grok-tui')
    setModel(agent.model ?? '')
    setName(agent.name ?? '')
  }, [open, agent])

  const save = useCallback(async (): Promise<void> => {
    if (!agent) return
    setBusy(true); setStatus('')
    // grok family + ACP runner → the concrete `grok-acp` id (routes to the persistent
    // ACP loop); every other case stores the family (variant chosen at operate time).
    const providerId = family === 'grok' && grokAcp ? 'grok-acp' : family
    const patch: { provider?: string; model?: string; name?: string } = { provider: providerId, model }
    const trimmed = name.trim()
    if (trimmed && trimmed !== agent.name) patch.name = trimmed
    const r = await officeService.updateCharacter(agent.id, patch)
    setBusy(false)
    if ('error' in r) { setStatus(r.error); return }
    setStatus(agent.online
      ? 'Saved — reconnect this character to run on the new engine.'
      : 'Saved.')
  }, [agent, family, grokAcp, model, name])

  const openMcp = useCallback(async (): Promise<void> => {
    if (!agent) return
    setMcpBusy(true); setMcpErr('')
    try {
      const r = await window.api.officeEnsureWorkspace(agent.officeSlug, agent.id, agent.slug, family)
      if ('cwd' in r && r.cwd) setMcpPath(r.cwd)
      else setMcpErr(('error' in r && r.error) || 'Could not prepare this character’s workspace.')
    } catch (e) {
      setMcpErr(e instanceof Error ? e.message : 'Could not prepare this character’s workspace.')
    } finally {
      setMcpBusy(false)
    }
  }, [agent, family])

  const agentName = name || agent?.name || 'Character'
  const grokRunnerShown = family === 'grok'
  const grokAccent = providerAccent('grok')

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
                onClick={() => {
                  if (fam === family) return
                  setFamily(fam)
                  // Model ids are per-provider — a model chosen for the OLD family is
                  // invalid for the new one and, if sent, persists garbage the loop
                  // can't launch. Reset to the provider default on an engine switch
                  // (mirrors BulkModelModal). The user re-picks from the new family's list.
                  setModel('')
                }}
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
      <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginBottom: grokRunnerShown ? 12 : 16 }}>
        The character keeps its name and identity — only the engine changes.
      </div>

      {/* GROK RUNNER — grok runs two ways; this is a real behavioural choice, not a
          cosmetic one, so it's exposed (and stored as the concrete grok-acp id). */}
      {grokRunnerShown && (
        <div style={{ marginBottom: 16 }}>
          <span style={label}>Grok runner</span>
          <div role="radiogroup" aria-label="Grok runner" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {([['acp', 'ACP (persistent)', 'one long-lived ACP session across turns'], ['tui', 'TUI', 'grok --continue, a fresh turn each time']] as const).map(([val, title, hint]) => {
              const on = (val === 'acp') === grokAcp
              return (
                <button
                  key={val}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setGrokAcp(val === 'acp')}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
                    padding: '8px 10px', borderRadius: 'var(--r-card)', cursor: 'pointer', textAlign: 'left',
                    background: on ? grokAccent.tint : 'var(--bg-input)',
                    border: `1px solid ${on ? grokAccent.fg : 'var(--bd-1)'}`,
                    boxShadow: on ? `inset 0 0 0 1px ${grokAccent.ring}` : undefined,
                    color: on ? grokAccent.ink : 'var(--tx-3)', outline: 'none'
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-meta)', fontWeight: 600 }}>{title}</span>
                  <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)' }}>{hint}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* MODEL */}
      <div style={{ marginBottom: 4 }}>
        <span style={label}>Model</span>
        <ModelSelect vendor={family} value={model} onChange={setModel} />
      </div>
      <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginBottom: 18 }}>
        Leave empty for the provider's default model.
      </div>

      {/* MCP SERVERS (item 4) — view + add/remove/enable-disable the MCP servers for
          THIS character's workspace. Opens the shared McpEditorModal (built-in
          Memory/Playwright/Sequential-Thinking/Computer-Use stay always-on) scoped
          to the character's Operate/loop scratch dir. */}
      <div style={{ borderTop: '1px solid var(--bd-2)', paddingTop: 14 }}>
        <span style={label}>MCP servers</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button variant="secondary" onClick={() => void openMcp()} disabled={mcpBusy || !agent}>
            <Icon name="gear" size={12} /> {mcpBusy ? 'Preparing…' : 'Manage MCP servers…'}
          </Button>
          {mcpErr && <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--st-error)' }}>{mcpErr}</span>}
        </div>
        <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', marginTop: 6 }}>
          Tools this character can call — scoped to its own workspace; applies on its next task.
        </div>
      </div>

      {/* Reused per-agent MCP editor, scoped to the resolved workspace path. */}
      {mcpPath && (
        <McpEditorModal
          agentPath={mcpPath}
          open={!!mcpPath}
          onClose={() => setMcpPath(null)}
          officeSlug={agent?.officeSlug}
          agentId={agent?.id}
        />
      )}
    </Modal>
  )
}

export default CharacterSettingsModal
