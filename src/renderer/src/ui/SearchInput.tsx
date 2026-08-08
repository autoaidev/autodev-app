import React from 'react'
import { Icon } from './Icon'

/**
 * SearchInput — the search / command box (top-nav ⌘K bar and the rail filter).
 * Renders a real <input>; the search icon and optional keyboard hint sit inside
 * the bg-input pill. Pass `kbd="⌘K"` for the command-bar affordance.
 */
export interface SearchInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** keyboard hint shown at the right edge (e.g. "⌘K"). Omit to hide. */
  kbd?: string
  /** container width (default 210, the command-bar width) */
  width?: number | string
  /** wrapper className (input-level className still forwarded to <input>) */
  wrapClassName?: string
  wrapStyle?: React.CSSProperties
}

export function SearchInput({
  kbd,
  width = 'var(--w-commandbar)',
  wrapClassName,
  wrapStyle,
  className,
  style,
  placeholder = 'Search or run a command',
  ...rest
}: SearchInputProps): React.JSX.Element {
  return (
    <div
      className={wrapClassName}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width,
        padding: '5px 10px',
        borderRadius: 'var(--r-button)',
        background: 'var(--bg-input)',
        border: '1px solid var(--bd-field)',
        ...wrapStyle
      }}
    >
      <Icon name="search" size={12} color="var(--tx-dim)" />
      <input
        type="text"
        placeholder={placeholder}
        className={className}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--tx-1)',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--fs-meta)',
          ...style
        }}
        {...rest}
      />
      {kbd && (
        <span
          style={{
            marginLeft: 'auto',
            flex: 'none',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-tiny)',
            fontWeight: 400,
            color: 'var(--tx-ghost)'
          }}
        >
          {kbd}
        </span>
      )}
    </div>
  )
}

export default SearchInput
