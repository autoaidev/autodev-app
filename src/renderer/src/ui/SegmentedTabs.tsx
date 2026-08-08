import React from 'react'

/**
 * SegmentedTabs — two related switchers in one primitive:
 *   variant="underline"  — the agent sub-tab bar (Activity | Chat | Terminal),
 *                          active tab carries the accent underline (2a/2f).
 *   variant="segmented"  — the boxed control (Interactive | Headless | SDK) used
 *                          in the Setup modal (2e); segments split the width.
 * The `right` slot (underline variant) holds trailing controls like the Follow
 * toggle + Raw log link.
 */
export interface SegTab {
  id: string
  label: React.ReactNode
}

export interface SegmentedTabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  tabs: SegTab[]
  value: string
  onChange?: (id: string) => void
  variant?: 'underline' | 'segmented'
  /** trailing content, right-aligned (underline variant only) */
  right?: React.ReactNode
}

export function SegmentedTabs({
  tabs,
  value,
  onChange,
  variant = 'underline',
  right,
  className,
  style,
  ...rest
}: SegmentedTabsProps): React.JSX.Element {
  if (variant === 'segmented') {
    return (
      <div
        role="tablist"
        className={className}
        style={{ display: 'flex', gap: 6, ...style }}
        {...rest}
      >
        {tabs.map((t) => {
          const active = t.id === value
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange?.(t.id)}
              style={{
                flex: 1,
                textAlign: 'center',
                padding: '7px 0',
                borderRadius: 'var(--r-button)',
                background: active ? 'var(--bg-accent-soft)' : 'var(--bg-input)',
                border: `1px solid ${active ? 'var(--bd-accent)' : 'var(--bd-1)'}`,
                color: active ? 'var(--accent-ink)' : 'var(--tx-3)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-meta)',
                fontWeight: active ? 600 : 400,
                cursor: 'pointer'
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div
      role="tablist"
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        height: 'var(--h-subtab)',
        ...style
      }}
      {...rest}
    >
      {tabs.map((t) => {
        const active = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange?.(t.id)}
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              padding: 0,
              background: 'transparent',
              border: 'none',
              color: active ? 'var(--tx-hi)' : 'var(--tx-4)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-body)',
              fontWeight: active ? 600 : 400,
              boxShadow: active ? 'inset 0 -2px 0 var(--accent)' : undefined,
              cursor: 'pointer'
            }}
          >
            {t.label}
          </button>
        )
      })}
      {right && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>{right}</div>}
    </div>
  )
}

export default SegmentedTabs
