import React from 'react'

/**
 * Button — text button in three variants matching the mockup:
 *   primary   — accent-filled, ink text, 700 weight (New agent, Spawn & run)
 *   secondary — bg-input + border, tx-2, 600 weight (Stop, Restart, Cancel)
 *   ghost     — transparent, tx-2 (menu-adjacent / inline)
 * `danger` recolours to the error status (destructive confirm actions).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  danger?: boolean
  /** stretch to fill the parent (rail footer primary) */
  block?: boolean
  children: React.ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  danger = false,
  block = false,
  className,
  style,
  children,
  type,
  ...rest
}: ButtonProps): React.JSX.Element {
  const pad = size === 'sm' ? '5px 11px' : '6px 12px'
  const fs = size === 'sm' ? 'var(--fs-desc)' : 'var(--fs-meta)'

  const base: React.CSSProperties = {
    display: block ? 'flex' : 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    width: block ? '100%' : undefined,
    padding: pad,
    borderRadius: 'var(--r-button)',
    fontFamily: 'var(--font-sans)',
    fontSize: fs,
    lineHeight: 1.2,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'background .12s ease, border-color .12s ease'
  }

  let skin: React.CSSProperties
  if (variant === 'primary') {
    skin = {
      background: danger ? 'var(--st-error)' : 'var(--accent)',
      border: '1px solid transparent',
      color: 'var(--tx-onaccent)',
      fontWeight: 700
    }
  } else if (variant === 'ghost') {
    skin = {
      background: 'transparent',
      border: '1px solid transparent',
      color: danger ? 'var(--st-error)' : 'var(--tx-2)',
      fontWeight: 600
    }
  } else {
    skin = {
      background: 'var(--bg-input)',
      border: '1px solid var(--bd-1)',
      color: danger ? 'var(--st-error)' : 'var(--tx-2)',
      fontWeight: 600
    }
  }

  return (
    <button
      type={type ?? 'button'}
      className={className}
      style={{ ...base, ...skin, ...style }}
      {...rest}
    >
      {children}
    </button>
  )
}

export default Button
