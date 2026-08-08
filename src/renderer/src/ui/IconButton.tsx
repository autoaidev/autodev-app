import React from 'react'
import { Icon, IconName } from './Icon'

/**
 * IconButton — the square 24×24 toolbar button (bulk-select bar, header
 * clusters). Pass either an `icon` name or arbitrary `children` (e.g. the
 * solid stop square). `active` gives it the accent-soft pressed look.
 * An accessible label is required via `label` (title + aria-label).
 */
export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string
  icon?: IconName
  /** px size of the button box (default 24) */
  size?: number
  /** px size of the inner icon (default 11) */
  iconSize?: number
  /** convenience colour for the glyph */
  iconColor?: string
  active?: boolean
  children?: React.ReactNode
}

export function IconButton({
  label,
  icon,
  size = 24,
  iconSize = 11,
  iconColor,
  active = false,
  className,
  style,
  type,
  children,
  ...rest
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      type={type ?? 'button'}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        width: size,
        height: size,
        borderRadius: 'var(--r-chip)',
        background: active ? 'var(--bg-accent-soft)' : 'var(--bg-input)',
        border: `1px solid ${active ? 'var(--bd-accent)' : 'var(--bd-icon-btn)'}`,
        color: iconColor ?? 'var(--tx-2)',
        cursor: 'pointer',
        transition: 'background .12s ease, border-color .12s ease',
        ...style
      }}
      {...rest}
    >
      {children ?? (icon && <Icon name={icon} size={iconSize} color={iconColor} />)}
    </button>
  )
}

export default IconButton
