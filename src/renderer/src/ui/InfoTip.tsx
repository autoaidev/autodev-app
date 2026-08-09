import React from 'react'
import { Icon } from './Icon'

/**
 * InfoTip — the reusable inline help affordance. A small "?" (or an inherited
 * child) that reveals a token-styled popover with a short explanation for a
 * domain term or control. Use it next to any label a first-time user hits
 * without context (office / character / steer / MCP / interactive-vs-headless …)
 * instead of burying the definition in dense inline prose.
 *
 * Interaction / accessibility:
 *   • The trigger is a real <button> — keyboard-focusable, with an aria-label
 *     ("Help: <label>") so screen readers announce what it explains.
 *   • The popover opens on hover AND on focus/click (so keyboard + touch users
 *     get it too), and closes on Escape, blur, or an outside click.
 *   • The popover has role="tooltip" and is wired to the trigger via
 *     aria-describedby; it never traps focus (it's non-modal help).
 *
 * Purely presentational — no app context, no side effects — so it can sit in any
 * primitive, modal, or view. Colours come only from theme.css tokens.
 */
export interface InfoTipProps {
  /** Short label naming what this explains — used for the aria-label + optional heading. */
  label: string
  /** The help body. Keep it to a sentence or two. */
  children: React.ReactNode
  /** Show the `label` as a bold heading above the body inside the popover. */
  showHeading?: boolean
  /** px size of the "?" glyph (default 12). */
  size?: number
  /** Popover width in px (default 240). */
  width?: number
  /** Preferred side; auto-flips near the right edge. */
  side?: 'right' | 'left'
  /** Replace the default "?" trigger with custom trigger content. */
  trigger?: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

let uid = 0

export function InfoTip({
  label,
  children,
  showHeading = true,
  size = 12,
  width = 240,
  side = 'right',
  trigger,
  className,
  style
}: InfoTipProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const wrapRef = React.useRef<HTMLSpanElement>(null)
  const idRef = React.useRef<string>('')
  if (!idRef.current) idRef.current = `infotip-${++uid}`

  // Close on Escape or an outside click while open.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <span
      ref={wrapRef}
      className={className}
      style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle', ...style }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        aria-describedby={open ? idRef.current : undefined}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={
          trigger
            ? { all: 'unset', cursor: 'help', display: 'inline-flex', alignItems: 'center' }
            : {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: size + 6,
                height: size + 6,
                padding: 0,
                borderRadius: 'var(--r-pill)',
                background: 'transparent',
                border: 'none',
                color: open ? 'var(--accent)' : 'var(--tx-dim)',
                cursor: 'help',
                transition: 'color .12s ease'
              }
        }
      >
        {trigger ?? <Icon name="help" size={size} />}
      </button>

      {open && (
        <span
          id={idRef.current}
          role="tooltip"
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: '50%',
            transform: 'translateY(-50%)',
            [side === 'right' ? 'left' : 'right']: 'calc(100% + 8px)',
            width,
            maxWidth: '80vw',
            zIndex: 2200,
            background: 'var(--bg-elev)',
            border: '1px solid var(--bd-strong)',
            borderRadius: 'var(--r-card)',
            boxShadow: 'var(--shadow-menu)',
            padding: '10px 12px',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-desc)',
            lineHeight: 1.55,
            color: 'var(--tx-2)',
            textAlign: 'left',
            whiteSpace: 'normal',
            cursor: 'default'
          }}
        >
          {showHeading && (
            <span
              style={{
                display: 'block',
                marginBottom: 4,
                fontSize: 'var(--fs-section)',
                fontWeight: 700,
                letterSpacing: 'var(--ls-section)',
                textTransform: 'uppercase',
                color: 'var(--tx-hi)'
              }}
            >
              {label}
            </span>
          )}
          {children}
        </span>
      )}
    </span>
  )
}

export default InfoTip
