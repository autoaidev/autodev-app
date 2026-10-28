import React, { useEffect, useRef, useState } from 'react'
import { Modal, Button } from '@renderer/ui'
import { OfficeAgent } from './officeTypes'
import * as officeService from '@renderer/services/officeService'

/**
 * CharacterActionModals — the small in-app Rename / Delete dialogs opened from a
 * character card's ⋯ ("More actions") menu in the office Team view. Mirrors the
 * feature shipped in the sibling pixel-office Vue app, translated to React.
 *
 * Both are real in-app <Modal>s (NOT window.confirm/prompt — the sandboxed
 * Electron renderer no-ops those to false) and are keyboard-accessible: Escape
 * closes (Modal owns that), Enter confirms, and the primary control is focused on
 * open with a visible focus ring.
 *
 * Persistence goes through the office API, owner/office-scoped server-side:
 *   • Rename → officeService.updateCharacter(id, { name })  → PATCH /api/agents/{id}
 *   • Delete → officeService.deleteCharacter(slug, id)      → DELETE /api/agents/{id}
 * updateCharacter / deleteCharacter both patch the shared office store optimistically
 * on success (the 8s presence poll reconciles); we additionally refetch so the new
 * name / removal shows across the grid and detail without the poll delay.
 */

const MAX_NAME = 50

const label: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--fs-section)',
  fontWeight: 600,
  letterSpacing: 'var(--ls-section)',
  textTransform: 'uppercase',
  color: 'var(--tx-dim)',
  marginBottom: 6
}

/* ───────────────────────────────────────────────────────────── Rename ───── */

export interface RenameCharacterModalProps {
  agent: OfficeAgent | null
  open: boolean
  onClose: () => void
  /** Called after a successful rename (the new, trimmed name). */
  onRenamed?: (name: string) => void
}

export function RenameCharacterModal({
  agent,
  open,
  onClose,
  onRenamed
}: RenameCharacterModalProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Seed the field with the current name each time the dialog opens; focus +
  // select it so a rename is a single keystroke away.
  useEffect(() => {
    if (!open || !agent) return
    setName(agent.name ?? '')
    setError('')
    setBusy(false)
    // Focus after the Modal has mounted its content.
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(t)
  }, [open, agent])

  const trimmed = name.trim()
  // Validation shown AT the control: non-empty and ≤ MAX_NAME chars.
  const validationError = !trimmed ? 'Name can’t be empty.' : trimmed.length > MAX_NAME ? `Name must be ${MAX_NAME} characters or fewer.` : ''
  const canSave = !!agent && !busy && !validationError && trimmed !== agent.name

  const save = async (): Promise<void> => {
    if (!agent || busy) return
    if (validationError) { setError(validationError); return }
    if (trimmed === agent.name) { onClose(); return }
    setBusy(true)
    setError('')
    const r = await officeService.updateCharacter(agent.id, { name: trimmed })
    if ('error' in r) {
      // updateCharacter only patches the store on success, so there's nothing to
      // revert — surface the error and keep the dialog open.
      setBusy(false)
      setError(r.error || 'Could not rename the character.')
      return
    }
    // Force a refetch so the new name shows across the grid/detail immediately
    // (the optimistic patch already updated the card; this reconciles the rest).
    void officeService.refresh()
    setBusy(false)
    onRenamed?.(trimmed)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={420}
      title={<>Rename character</>}
      subtitle={agent ? `currently “${agent.name}”` : undefined}
      subtitleMono
      footer={
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
            {busy ? 'Saving…' : 'Rename'}
          </Button>
        </div>
      }
    >
      <div>
        <span style={label}>Name</span>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => { setName(e.target.value); if (error) setError('') }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (canSave) void save() }
          }}
          maxLength={MAX_NAME + 1}
          placeholder="Character name…"
          aria-label="Character name"
          aria-invalid={!!(error || (name && validationError))}
          style={{
            width: '100%',
            background: 'var(--bg-input)',
            border: `1px solid ${(error || (name && validationError)) ? 'var(--st-error)' : 'var(--bd-1)'}`,
            borderRadius: 'var(--r-input)',
            color: 'var(--tx-1)',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-body)',
            padding: '7px 9px',
            outline: 'none'
          }}
        />
        {/* Error shown at the control: an explicit save failure, or the live
            length/empty validation once the user has typed. */}
        {(error || (name && validationError)) && (
          <div role="alert" style={{ marginTop: 6, fontSize: 'var(--fs-meta)', color: 'var(--st-error)' }}>
            {error || validationError}
          </div>
        )}
        <div style={{ marginTop: 6, fontSize: 'var(--fs-meta)', color: 'var(--tx-5)' }}>
          Up to {MAX_NAME} characters. The character keeps its identity and history — only its display name changes.
        </div>
      </div>
    </Modal>
  )
}

/* ───────────────────────────────────────────────────────────── Delete ───── */

export interface DeleteCharacterModalProps {
  agent: OfficeAgent | null
  open: boolean
  onClose: () => void
  /** Called after a successful delete (the removed character's id). */
  onDeleted?: (id: string) => void
}

export function DeleteCharacterModal({
  agent,
  open,
  onClose,
  onDeleted
}: DeleteCharacterModalProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setBusy(false)
    setError('')
  }, [open])

  const del = async (): Promise<void> => {
    if (!agent || busy) return
    setBusy(true)
    setError('')
    const r = await officeService.deleteCharacter(agent.officeSlug, agent.id)
    if ('error' in r) {
      setBusy(false)
      setError(r.error || 'Could not delete the character.')
      return
    }
    // deleteCharacter already dropped it from the store; refetch reconciles the rest.
    void officeService.refresh()
    const id = agent.id
    setBusy(false)
    onDeleted?.(id)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={420}
      title={<>Delete character</>}
      footer={
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          {/* autoFocus: the destructive confirm is focused on open so Enter/Space
              activates it with a visible focus ring; Escape (Modal) cancels. */}
          <Button
            variant="primary"
            danger
            autoFocus
            onClick={() => void del()}
            disabled={busy || !agent}
          >
            {busy ? 'Deleting…' : 'Delete character'}
          </Button>
        </div>
      }
    >
      <div
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!busy) void del() } }}
      >
        <p style={{ margin: 0, fontSize: 'var(--fs-body)', color: 'var(--tx-2)', lineHeight: 1.55 }}>
          Delete <strong style={{ color: 'var(--tx-hi)' }}>{agent?.name ?? 'this character'}</strong> from this office?
        </p>
        <p style={{ margin: '10px 0 0', fontSize: 'var(--fs-meta)', color: 'var(--tx-5)', lineHeight: 1.55 }}>
          This permanently removes the character and its conversation from the office. This cannot be undone.
        </p>
        {error && (
          <div role="alert" style={{ marginTop: 12, fontSize: 'var(--fs-meta)', color: 'var(--st-error)' }}>
            {error}
          </div>
        )}
      </div>
    </Modal>
  )
}
