import React from 'react'
import { Icon } from './Icon'

/**
 * Modal / Dialog — the scrim + centered card used for Spawn-team, agent Setup
 * and the MCP editor. radius11, bd-strong border, shadow-modal. Header carries
 * a title + optional mono/sans subtitle and a right slot (e.g. a Recheck
 * button); the ✕ close affordance is built in. Closes on Escape and scrim click.
 *
 * For the chrome-less compositions (2g) pass `overlay={false}` to drop the
 * scrim and render just the dialog card.
 */
// Shared open-modal stack so a single Escape only closes the TOP-MOST modal.
// Every open Modal registers a window keydown listener; without this guard a
// nested modal (e.g. the MCP editor opened from within the agent Setup dialog)
// and its parent would BOTH receive the Escape and both call onClose, collapsing
// the whole stack in one keypress. Each open modal pushes an identity token here
// and only acts on Escape when it is the last (top-most) token.
const modalStack: symbol[] = []

export interface ModalProps {
  open: boolean
  onClose?: () => void
  title?: React.ReactNode
  subtitle?: React.ReactNode
  /** monospace subtitle (paths, "applies on next task") */
  subtitleMono?: boolean
  /** right-aligned header slot (buttons); the ✕ is appended after it */
  headerRight?: React.ReactNode
  footer?: React.ReactNode
  /** dialog width in px (default 492) */
  width?: number
  /** show the ✕ button (default true) */
  closeButton?: boolean
  /** render the darkening scrim behind the dialog (default true) */
  overlay?: boolean
  className?: string
  style?: React.CSSProperties
  children?: React.ReactNode
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  subtitleMono = false,
  headerRight,
  footer,
  width = 492,
  closeButton = true,
  overlay = true,
  className,
  style,
  children
}: ModalProps): React.JSX.Element | null {
  // Stable identity for this modal instance in the shared open-modal stack.
  const idRef = React.useRef<symbol | null>(null)
  if (idRef.current === null) idRef.current = Symbol('modal')

  React.useEffect(() => {
    if (!open || !onClose) return
    const id = idRef.current!
    modalStack.push(id)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Only the top-most open modal handles Escape; stop other Modal listeners
      // (all bound to window) from also firing so the parent doesn't close too.
      if (modalStack[modalStack.length - 1] !== id) return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const i = modalStack.lastIndexOf(id)
      if (i !== -1) modalStack.splice(i, 1)
    }
  }, [open, onClose])

  if (!open) return null

  const dialog = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : undefined}
      className={className}
      onClick={(e) => e.stopPropagation()}
      style={{
        width,
        maxWidth: '100%',
        // Never taller than the viewport (minus the overlay's 24px padding each
        // side); the body below scrolls while header/footer stay pinned, so a tall
        // generate/config dialog can't clip its header or ✕.
        maxHeight: 'calc(100vh - 48px)',
        background: 'var(--bg-panel)',
        border: '1px solid var(--bd-strong)',
        borderRadius: 'var(--r-modal)',
        boxShadow: 'var(--shadow-modal)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        ...style
      }}
    >
      {(title || headerRight || closeButton) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '15px 18px 13px',
            borderBottom: '1px solid var(--bd-card)',
            flexShrink: 0
          }}
        >
          <div style={{ minWidth: 0 }}>
            {title && (
              <div
                style={{
                  fontSize: 'var(--fs-modal-title)',
                  fontWeight: 700,
                  color: 'var(--tx-hi)',
                  letterSpacing: 'var(--ls-tight)'
                }}
              >
                {title}
              </div>
            )}
            {subtitle && (
              <div
                style={{
                  marginTop: 4,
                  fontFamily: subtitleMono ? 'var(--font-mono)' : 'var(--font-sans)',
                  fontSize: subtitleMono ? 'var(--fs-section)' : 'var(--fs-meta)',
                  color: subtitleMono ? 'var(--tx-dim)' : 'var(--tx-5)',
                  lineHeight: 1.5
                }}
              >
                {subtitle}
              </div>
            )}
          </div>
          {(headerRight || closeButton) && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7 }}>
              {headerRight}
              {closeButton && (
                <button
                  type="button"
                  aria-label="Close"
                  onClick={onClose}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 4,
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--tx-dim)',
                    cursor: 'pointer'
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ padding: '15px 18px', overflow: 'auto', flex: 1, minHeight: 0 }}>{children}</div>

      {footer && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 18px',
            borderTop: '1px solid var(--bd-card)',
            flexShrink: 0
          }}
        >
          {footer}
        </div>
      )}
    </div>
  )

  if (!overlay) return dialog

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        // Above the floating chrome (CliBanner + Toast sit at z-index 1000) so an
        // open dialog is never covered by a banner/toast. Stacking: Modal > Toast/Banner > chrome.
        zIndex: 2000,
        background: 'var(--scrim)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24
      }}
    >
      {dialog}
    </div>
  )
}

export default Modal
