import React from 'react'

/**
 * Button — text button in four variants matching the mockup:
 *   cta       — the ONE hero action per view: accent→accent-2 gradient fill, top
 *               inset highlight + soft blue shadow (Start / Start-all-idle).
 *   primary   — accent-filled, ink text, 700 weight (New agent, Spawn & run)
 *   secondary — bg-input + border, tx-2, 600 weight (Stop, Restart, Cancel)
 *   ghost     — transparent, tx-2 (menu-adjacent / inline)
 * `danger` recolours to the error status (destructive confirm actions).
 *
 * De-monotony rule: reserve `cta` for the single primary action on a screen and
 * demote everything else to secondary/ghost, so each view has one obvious focal
 * action. Saturated accent gradient is spent here (and on the LIVE indicator) only.
 */
export type ButtonVariant = 'cta' | 'primary' | 'secondary' | 'ghost'
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
  const isDisabled = !!rest.disabled
  // A disabled primary must read as a clearly INERT, greyed, non-filled control —
  // never a translucent accent (which muddies #4a9eff@50% into a "steel blue" that
  // looks like a second active CTA AND fails label-contrast on its dark ink). So we
  // give disabled-primary its own greyed skin at full opacity, and reserve the
  // opacity-dim only for the non-filled variants where it reads correctly as muted.
  // The gradient CTA, like primary, gets a greyed inert skin when disabled rather
  // than a translucent gradient (which would read as a dimmed-but-live CTA).
  const primaryDisabled = (variant === 'primary' || variant === 'cta') && isDisabled

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
    // A disabled button must LOOK disabled everywhere (R12): muted + not-allowed, so
    // a primary CTA can't render as a fully-saturated, clickable-looking blue while
    // it's actually inert (the Office-vs-Make-app Connect-button mismatch).
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    opacity: isDisabled && !primaryDisabled ? 0.5 : 1,
    whiteSpace: 'nowrap',
    transition: 'background .12s ease, border-color .12s ease, opacity .12s ease'
  }

  let skin: React.CSSProperties
  if (variant === 'cta') {
    skin = primaryDisabled
      ? {
          background: 'var(--bg-input)',
          border: '1px solid var(--bd-1)',
          color: 'var(--tx-5)',
          fontWeight: 700
        }
      : {
          // accent→accent-2 gradient fill with a top inset highlight + soft blue
          // drop shadow (the ONE hero action per view).
          background: danger ? 'var(--st-error)' : 'var(--grad-cta)',
          border: '1px solid transparent',
          color: 'var(--tx-onaccent)',
          fontWeight: 700,
          boxShadow: danger ? undefined : 'var(--depth-cta)'
        }
  } else if (variant === 'primary') {
    skin = primaryDisabled
      ? {
          // greyed / non-filled — visibly disabled, not a second blue
          background: 'var(--bg-input)',
          border: '1px solid var(--bd-1)',
          color: 'var(--tx-5)',
          fontWeight: 700
        }
      : {
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
