import React from 'react'

/**
 * Toolbar — the bulk-select action band that appears above the agent list when
 * rows are checked. Renders the accent check-chip + mono selection count on the
 * left and right-aligns its children (a cluster of IconButtons).
 */
export interface ToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** number of selected rows shown in the accent chip */
  count: number
  /** action cluster, right-aligned (typically IconButtons) */
  children?: React.ReactNode
}

export function Toolbar({
  count,
  className,
  style,
  children,
  ...rest
}: ToolbarProps): React.JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label={`${count} selected`}
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 11px',
        background: 'var(--bg-sel-header)',
        borderBottom: '1px solid var(--bd-panel-sel)',
        ...style
      }}
      {...rest}
    >
      <span
        aria-hidden
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
          width: 14,
          height: 14,
          borderRadius: 'var(--r-checkbox)',
          background: 'var(--accent)',
          color: 'var(--tx-onaccent)',
          fontSize: 'var(--fs-micro)',
          fontWeight: 700
        }}
      >
        ✓
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-desc)',
          fontWeight: 600,
          color: 'var(--accent-ink)',
          whiteSpace: 'nowrap'
        }}
      >
        {count}
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>{children}</div>
    </div>
  )
}

export default Toolbar
