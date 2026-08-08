import React, { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

/**
 * CommandPalette — the ⌘K / Ctrl-K overlay. A single global affordance that works
 * from ANY screen: type to filter, ↑/↓ to move, Enter to run, Escape to close.
 * Replaces the old "⌘K just jumps to Agents" shortcut with a real command surface
 * (nav destinations + primary actions). Fully token-styled; traps focus in the
 * input, closes on Escape / backdrop click, and restores focus to the previously
 * focused element on close.
 */
export interface Command {
  id: string
  label: string
  /** right-aligned muted hint (e.g. section / shortcut) */
  hint?: string
  /** keywords that also match the filter (not shown) */
  keywords?: string
  run: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  commands: Command[]
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  const q = query.trim().toLowerCase()
  const filtered = q
    ? commands.filter(
        (c) => c.label.toLowerCase().includes(q) || (c.keywords ?? '').toLowerCase().includes(q)
      )
    : commands

  // On open: remember what was focused, seed focus into the input, reset state.
  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    setQuery('')
    setActive(0)
    // focus after paint so the input exists
    const id = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(id)
      restoreRef.current?.focus?.()
    }
  }, [open])

  // Keep the highlighted row in range as the filter narrows.
  useEffect(() => {
    if (active > filtered.length - 1) setActive(Math.max(0, filtered.length - 1))
  }, [filtered.length, active])

  if (!open) return null

  const runAt = (i: number): void => {
    const cmd = filtered[i]
    if (!cmd) return
    onClose()
    cmd.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runAt(active)
    }
  }

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
        background: 'var(--scrim)'
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          width: 'min(560px, 92vw)',
          background: 'var(--bg-elev)',
          border: '1px solid var(--bd-strong)',
          borderRadius: 'var(--r-modal)',
          boxShadow: 'var(--shadow-modal)',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '11px 14px',
            borderBottom: '1px solid var(--bd-nav)'
          }}
        >
          <Icon name="search" size={14} color="var(--tx-dim)" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or run a command"
            aria-label="Search or run a command"
            style={{
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--tx-1)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-session-title)'
            }}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-tiny)',
              color: 'var(--tx-ghost)'
            }}
          >
            esc
          </span>
        </div>

        <div style={{ maxHeight: '46vh', overflowY: 'auto', padding: 6 }}>
          {filtered.length === 0 && (
            <div
              style={{
                padding: '18px 12px',
                textAlign: 'center',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-meta)',
                color: 'var(--tx-dim)'
              }}
            >
              No matching commands
            </div>
          )}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => runAt(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                width: '100%',
                textAlign: 'left',
                padding: '9px 11px',
                borderRadius: 'var(--r-button)',
                border: 'none',
                cursor: 'pointer',
                background: i === active ? 'var(--bg-selected)' : 'transparent',
                color: i === active ? 'var(--tx-hi)' : 'var(--tx-2)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-body)'
              }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.label}
              </span>
              {c.hint && (
                <span
                  style={{
                    flex: 'none',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-tiny)',
                    color: 'var(--tx-dim)'
                  }}
                >
                  {c.hint}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default CommandPalette
