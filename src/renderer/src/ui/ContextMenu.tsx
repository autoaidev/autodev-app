import React from 'react'
import { Icon, IconName } from './Icon'

/**
 * ContextMenu — the floating right-click agent menu (2a). Items carry an
 * optional icon, a right-aligned mono keyboard hint, and a `danger` flag; a
 * `{ separator: true }` entry draws the divider. Positioning is the caller's
 * job (pass absolute left/top via `style`); pass `onClose` to render a
 * click-away backdrop that dismisses the menu.
 */
export interface ContextMenuItem {
  label: string
  icon?: IconName
  /** glyph colour override (e.g. accent for the highlighted item) */
  iconColor?: string
  /** right-aligned mono shortcut hint, e.g. "⌘⏎" */
  kbd?: string
  danger?: boolean
  disabled?: boolean
  /** highlighted (accent-soft) row — the primary action */
  active?: boolean
  onClick?: () => void
}

export type ContextMenuEntry = ContextMenuItem | { separator: true }

export interface ContextMenuProps extends React.HTMLAttributes<HTMLDivElement> {
  items: ContextMenuEntry[]
  /** optional uppercase mono header (e.g. the agent id) */
  header?: string
  /** click-away handler; when set a transparent backdrop is rendered */
  onClose?: () => void
}

function isSeparator(e: ContextMenuEntry): e is { separator: true } {
  return (e as { separator?: boolean }).separator === true
}

export function ContextMenu({
  items,
  header,
  onClose,
  className,
  style,
  ...rest
}: ContextMenuProps): React.JSX.Element {
  const menu = (
    <div
      role="menu"
      className={className}
      style={{
        zIndex: 5,
        minWidth: 216,
        background: 'var(--bg-elev)',
        border: '1px solid var(--bd-strong)',
        borderRadius: 'var(--r-screen)',
        boxShadow: 'var(--shadow-menu)',
        padding: 5,
        fontSize: 'var(--fs-meta)',
        ...style
      }}
      {...rest}
    >
      {header && (
        <div
          style={{
            padding: '5px 9px 6px',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-micro)',
            color: 'var(--tx-ghost)',
            letterSpacing: 'var(--ls-state)'
          }}
        >
          {header}
        </div>
      )}
      {items.map((entry, i) => {
        if (isSeparator(entry)) {
          return (
            <div
              key={`sep-${i}`}
              role="separator"
              style={{ height: 1, background: 'var(--bd-card)', margin: '5px 4px' }}
            />
          )
        }
        const it = entry
        return (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return
              it.onClick?.()
              onClose?.()
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              width: '100%',
              textAlign: 'left',
              padding: '6px 9px',
              borderRadius: 'var(--r-chip)',
              border: 'none',
              background: it.active ? 'var(--bg-accent-soft)' : 'transparent',
              color: it.danger
                ? 'var(--st-error)'
                : it.active
                  ? 'var(--tx-hi)'
                  : 'var(--tx-2)',
              opacity: it.disabled ? 0.45 : 1,
              cursor: it.disabled ? 'default' : 'pointer',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-meta)'
            }}
          >
            {it.icon && (
              <Icon
                name={it.icon}
                size={12}
                color={it.iconColor ?? (it.danger ? 'var(--st-error)' : 'var(--tx-4)')}
              />
            )}
            <span style={{ flex: 1, minWidth: 0 }}>{it.label}</span>
            {it.kbd && (
              <span
                style={{
                  marginLeft: 'auto',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-tiny)',
                  color: it.active ? 'var(--accent-ink)' : 'var(--tx-dim)'
                }}
              >
                {it.kbd}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )

  if (!onClose) return menu

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 4 }}
      />
      {menu}
    </>
  )
}

export default ContextMenu
