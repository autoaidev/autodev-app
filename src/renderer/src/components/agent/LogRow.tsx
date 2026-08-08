import React from 'react'

/**
 * LogRow — one parsed line of the ActivityStream (2a).
 *
 * The raw provider stream is parsed upstream (ActivityStream) into rows whose
 * timestamp is stripped to a fixed left gutter, whose body is severity-coloured,
 * and whose repeated MCP lines are folded into a single summary row. This
 * component renders exactly one such row and owns the expand/collapse state of a
 * folded MCP group.
 *
 *   [ timestamp mono 10px · gutter 42 ][ severity glyph 14 ][ body flex ]
 *
 * Severity glyphs (from the spec): ⚙ gear = info (tx-dim), ! = error (st-error),
 * ✉ mail = inbound message (role-violet), and the folded MCP summary tag.
 */
export type LogSeverity = 'info' | 'error' | 'mail' | 'mcp'

const GLYPH: Record<LogSeverity, string> = {
  info: '⚙',
  error: '!',
  mail: '✉',
  mcp: '⚙'
}

const GLYPH_COLOR: Record<LogSeverity, string> = {
  info: 'var(--tx-dim)',
  error: 'var(--st-error)',
  mail: 'var(--role-violet)',
  mcp: 'var(--tx-dim)'
}

const BODY_COLOR: Record<LogSeverity, string> = {
  info: 'var(--tx-2)',
  error: 'var(--st-error-bright)',
  mail: 'var(--tx-2)',
  mcp: 'var(--tx-4)'
}

export interface LogRowProps {
  /** already-stripped timestamp (e.g. "11:29"); omit for no gutter time */
  ts?: string
  severity: LogSeverity
  /** the human body text of the line */
  body: string
  /**
   * When set (>0) this row is a folded MCP summary: it renders a
   * "N MCP calls ▾" tag that expands the collapsed raw lines inline.
   */
  foldCount?: number
  /** the collapsed raw lines revealed when the fold tag is expanded */
  foldedLines?: string[]
}

export function LogRow({ ts, severity, body, foldCount, foldedLines }: LogRowProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const folded = foldCount != null && foldCount > 0

  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', alignItems: 'flex-start' }}>
      <span
        style={{
          flex: 'none',
          width: 42,
          textAlign: 'right',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-section)',
          color: 'var(--tx-gutter)',
          lineHeight: '17px',
          userSelect: 'none'
        }}
      >
        {ts ?? ''}
      </span>
      <span
        aria-hidden
        style={{
          flex: 'none',
          width: 14,
          textAlign: 'center',
          color: GLYPH_COLOR[severity],
          fontSize: severity === 'error' ? 'var(--fs-body)' : 'var(--fs-desc)',
          fontWeight: severity === 'error' ? 700 : 400,
          lineHeight: '17px'
        }}
      >
        {GLYPH[severity]}
      </span>

      <div style={{ flex: 1, minWidth: 0, lineHeight: '17px' }}>
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-body)',
            color: BODY_COLOR[severity],
            wordBreak: 'break-word'
          }}
        >
          {body}
        </span>

        {folded && (
          <>
            {' '}
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                verticalAlign: 'baseline',
                padding: '1px 6px',
                borderRadius: 'var(--r-tiny)',
                background: 'var(--bg-input)',
                border: '1px solid var(--bd-1)',
                color: 'var(--tx-ghost)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-section)',
                cursor: 'pointer'
              }}
            >
              {foldCount} MCP {foldCount === 1 ? 'call' : 'calls'} {open ? '▴' : '▾'}
            </button>
            {open && foldedLines && foldedLines.length > 0 && (
              <div
                style={{
                  marginTop: 6,
                  padding: '6px 9px',
                  borderRadius: 'var(--r-chip)',
                  background: 'var(--bg-panel-alt)',
                  border: '1px solid var(--bd-2)'
                }}
              >
                {foldedLines.map((l, i) => (
                  <div
                    key={i}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-mono-code)',
                      color: 'var(--tx-dim)',
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word'
                    }}
                  >
                    {l}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default LogRow
