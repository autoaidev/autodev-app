import React from 'react'

/**
 * JsonCodeBlock — a line-numbered, syntax-tinted, editable view of raw .mcp.json.
 *
 * The mockup shows a read-first code block with a gutter and per-line syntax
 * colours (keys/strings/booleans/punctuation via the --syn-* tokens) and can
 * cross-highlight one offending line (red gutter + left rail + wash) to match a
 * failing server. To keep the block genuinely *editable* for "advanced edits"
 * we overlay a transparent-text <textarea> on top of the tinted render so the
 * caret and selection are real while the colours track the text underneath.
 */
export interface JsonCodeBlockProps {
  value: string
  onChange: (next: string) => void
  /** 1-based line number to cross-highlight (the failing server's line) */
  highlightLine?: number
  /** footer-left message (e.g. "line 3 · runner not resolvable") */
  problem?: string
  spellCheck?: boolean
  /** read-only view — no caret edits, onChange never fires (advanced raw display). */
  readOnly?: boolean
}

/** tokenise ONE json line into coloured spans using the --syn-* tokens. */
function tint(line: string, key: number): React.ReactNode {
  const nodes: React.ReactNode[] = []
  // matches: "…":(key)  |  "…"(string)  |  true/false/null  |  numbers  |  punctuation
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)|([{}[\],:])/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) nodes.push(line.slice(last, m.index))
    if (m[1] !== undefined) {
      // a quoted token; if followed by ':' it is a key
      nodes.push(
        <span key={i++} style={{ color: m[2] ? 'var(--syn-key)' : 'var(--syn-str)' }}>
          {m[1]}
        </span>
      )
      if (m[2]) nodes.push(<span key={i++} style={{ color: 'var(--syn-punct)' }}>{m[2]}</span>)
    } else if (m[3] !== undefined) {
      nodes.push(<span key={i++} style={{ color: 'var(--syn-bool)' }}>{m[3]}</span>)
    } else if (m[4] !== undefined) {
      nodes.push(<span key={i++} style={{ color: 'var(--syn-bool)' }}>{m[4]}</span>)
    } else if (m[5] !== undefined) {
      nodes.push(<span key={i++} style={{ color: 'var(--syn-punct)' }}>{m[5]}</span>)
    }
    last = m.index + m[0].length
  }
  if (last < line.length) nodes.push(line.slice(last))
  return (
    <React.Fragment key={key}>
      {nodes.length ? nodes : '​'}
      {'\n'}
    </React.Fragment>
  )
}

const CELL_LH = 18
const codeFont: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-mono-code)',
  lineHeight: `${CELL_LH}px`,
  tabSize: 2,
  whiteSpace: 'pre',
  margin: 0
}

export function JsonCodeBlock({
  value,
  onChange,
  highlightLine,
  problem,
  spellCheck = false,
  readOnly = false
}: JsonCodeBlockProps): React.JSX.Element {
  const lines = value.split('\n')
  const taRef = React.useRef<HTMLTextAreaElement>(null)
  const gutterRef = React.useRef<HTMLDivElement>(null)
  const renderRef = React.useRef<HTMLPreElement>(null)
  // The error-highlight band is a sibling of the scrolled <pre>, so it must be
  // offset by the textarea's scrollTop or it desyncs from its line on scroll.
  const [scrollTop, setScrollTop] = React.useState(0)

  // keep the tinted layer + gutter scroll-locked to the textarea
  const syncScroll = React.useCallback((): void => {
    const ta = taRef.current
    if (!ta) return
    if (renderRef.current) {
      renderRef.current.scrollTop = ta.scrollTop
      renderRef.current.scrollLeft = ta.scrollLeft
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop
    setScrollTop(ta.scrollTop)
  }, [])

  return (
    <div
      style={{
        background: 'var(--bg-0)',
        border: '1px solid var(--bd-card)',
        borderRadius: 'var(--r-card)',
        overflow: 'hidden'
      }}
    >
      <div style={{ position: 'relative', display: 'flex', height: 220 }}>
        {/* gutter */}
        <div
          ref={gutterRef}
          aria-hidden
          style={{
            flex: 'none',
            overflow: 'hidden',
            padding: '10px 0',
            background: 'var(--bg-app)',
            borderRight: '1px solid var(--bd-2)',
            userSelect: 'none'
          }}
        >
          {lines.map((_, i) => {
            const n = i + 1
            const hit = n === highlightLine
            return (
              <div
                key={n}
                style={{
                  ...codeFont,
                  padding: '0 10px 0 12px',
                  textAlign: 'right',
                  minWidth: 34,
                  color: hit ? 'var(--st-error)' : 'var(--tx-gutter)',
                  background: hit ? 'var(--st-error-wash)' : 'transparent',
                  fontWeight: hit ? 700 : 400
                }}
              >
                {n}
              </div>
            )
          })}
        </div>

        {/* code area: tinted render under a transparent-text textarea */}
        <div style={{ position: 'relative', flex: 1, minWidth: 0, overflow: 'hidden' }}>
          {/* highlight band for the offending line — tracks the textarea scroll and
              hides when the line scrolls out of the 220px viewport. */}
          {highlightLine && highlightLine >= 1 && highlightLine <= lines.length && (() => {
            const bandTop = 10 + (highlightLine - 1) * CELL_LH - scrollTop
            if (bandTop + CELL_LH <= 10 || bandTop >= 220) return null // off-viewport
            return (
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: bandTop,
                  height: CELL_LH,
                  background: 'var(--st-error-wash)',
                  boxShadow: 'inset 2px 0 0 var(--st-error)',
                  pointerEvents: 'none'
                }}
              />
            )
          })()}
          <pre
            ref={renderRef}
            aria-hidden
            style={{
              ...codeFont,
              position: 'absolute',
              inset: 0,
              padding: '10px 12px',
              overflow: 'hidden',
              color: 'var(--tx-2)',
              pointerEvents: 'none'
            }}
          >
            {lines.map((ln, i) => tint(ln, i))}
          </pre>
          <textarea
            ref={taRef}
            data-json-editor
            value={value}
            spellCheck={spellCheck}
            readOnly={readOnly}
            onChange={(e) => { if (!readOnly) onChange(e.target.value) }}
            onScroll={syncScroll}
            wrap="off"
            style={{
              ...codeFont,
              position: 'absolute',
              inset: 0,
              padding: '10px 12px',
              width: '100%',
              height: '100%',
              resize: 'none',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'transparent',
              caretColor: 'var(--accent)',
              overflow: 'auto'
            }}
          />
        </div>
      </div>

      {/* footer strip */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 12px',
          borderTop: '1px solid var(--bd-2)',
          background: 'var(--bg-panel-alt)'
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: '10.5px',
            color: problem ? 'var(--st-error)' : 'var(--tx-dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {problem || ''}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--tx-gutter)' }}>
          json · {lines.length} lines
        </span>
      </div>
    </div>
  )
}

export default JsonCodeBlock
