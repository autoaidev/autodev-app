import React from 'react'
import { LogRow, LogSeverity } from './LogRow'

/**
 * ActivityStream — the parsed Activity tab body (2a).
 *
 * Takes the RAW provider log buffer (streamed through window.api.onAgentLog and
 * buffered by AgentsView) and turns it into a readable timeline instead of echoing
 * ANSI: timestamps are stripped to a gutter (LogRow), severity is colour-coded,
 * runs of repeated MCP lines fold into a single "N MCP calls ▾" summary, and
 * "TASK n OF m" markers become centered dividers.
 *
 * It self-subscribes to the log stream (same pattern as the old Output pane) so a
 * new line re-renders ONLY this pane — never the parent view, which keeps the
 * composer/search inputs from dropping keystrokes.
 */

interface DividerItem {
  kind: 'divider'
  id: string
  label: string
}
interface RowItem {
  kind: 'row'
  id: string
  ts?: string
  severity: LogSeverity
  body: string
  foldCount?: number
  foldedLines?: string[]
}
type StreamItem = DividerItem | RowItem

const ANSI = /\x1b\[[0-9;]*m/g
const TS_HMS = /^\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+/
const TS_ISO = /^\s*\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2}(?::\d{2})?)\S*\s+/
const DIVIDER = /task\s+(\d+)\s*(?:of|\/)\s*(\d+)/i
const RE_MAIL = /task from|message from|received (?:a )?task|inbound|from project-manager|✉/i
const RE_ERROR = /\berror\b|\bfailed\b|\bfailing\b|not started|cannot\b|unable to|timed out|timeout|✗|exit code [1-9]/i
const RE_MCP = /\bmcp\b|mcp-operate|tool call|tool\.call/i

function stripTs(line: string): { ts?: string; rest: string } {
  let m = line.match(TS_HMS)
  if (m) return { ts: m[1].slice(0, 5), rest: line.slice(m[0].length) }
  m = line.match(TS_ISO)
  if (m) return { ts: m[1].slice(0, 5), rest: line.slice(m[0].length) }
  return { rest: line }
}

function severityOf(text: string): LogSeverity {
  if (RE_MAIL.test(text)) return 'mail'
  if (RE_ERROR.test(text)) return 'error'
  if (RE_MCP.test(text)) return 'mcp'
  return 'info'
}

/** Parse the raw buffer into dividers + rows, folding consecutive MCP lines. */
export function parseLog(raw: string): StreamItem[] {
  const lines = raw
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0)

  const items: StreamItem[] = []
  let mcpBuf: { ts?: string; body: string }[] = []
  let n = 0

  const flushMcp = (): void => {
    if (mcpBuf.length === 0) return
    if (mcpBuf.length === 1) {
      const only = mcpBuf[0]
      items.push({ kind: 'row', id: `r${n++}`, ts: only.ts, severity: 'mcp', body: only.body })
    } else {
      items.push({
        kind: 'row',
        id: `f${n++}`,
        ts: mcpBuf[0].ts,
        severity: 'mcp',
        body: 'MCP servers applied',
        foldCount: mcpBuf.length,
        foldedLines: mcpBuf.map((m) => m.body)
      })
    }
    mcpBuf = []
  }

  for (const raw0 of lines) {
    const { ts, rest } = stripTs(raw0)
    const body = rest.trim()
    const dm = body.match(DIVIDER)
    if (dm) {
      flushMcp()
      items.push({ kind: 'divider', id: `d${n++}`, label: `TASK ${dm[1]} OF ${dm[2]}` })
      continue
    }
    const sev = severityOf(body)
    if (sev === 'mcp') {
      mcpBuf.push({ ts, body })
      continue
    }
    flushMcp()
    items.push({ kind: 'row', id: `r${n++}`, ts, severity: sev, body })
  }
  flushMcp()
  return items
}

function TaskDivider({ label }: { label: string }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0 8px' }}>
      <div style={{ flex: 1, height: 1, background: 'var(--bd-2)' }} />
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-tiny)',
          letterSpacing: 'var(--ls-state)',
          color: 'var(--tx-ghost)',
          whiteSpace: 'nowrap'
        }}
      >
        {label}
      </span>
      <div style={{ flex: 1, height: 1, background: 'var(--bd-2)' }} />
    </div>
  )
}

export interface ActivityStreamProps {
  /** reads the latest raw log buffer for the selected agent */
  getText: () => string
  /** subscribe to the shared log stream; returns an unsubscribe fn */
  subscribe: (cb: () => void) => () => void
  /** auto-scroll to the newest line when true (the Follow toggle) */
  follow: boolean
  /** show the unparsed raw buffer instead of the parsed rows (Raw log link) */
  raw?: boolean
}

export function ActivityStream({ getText, subscribe, follow, raw = false }: ActivityStreamProps): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  const [, force] = React.useState(0)
  React.useEffect(() => subscribe(() => force((t) => t + 1)), [subscribe])

  const text = getText()
  const items = React.useMemo(() => (raw ? [] : parseLog(text)), [text, raw])

  // Follow: stick to the bottom on new output only while Follow is on.
  React.useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text, follow, raw])

  const empty = text.trim().length === 0

  return (
    <div
      ref={ref}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        padding: '12px 18px',
        fontSize: 'var(--fs-body)'
      }}
    >
      {empty ? (
        <div style={{ color: 'var(--tx-5)', fontSize: 'var(--fs-meta)', padding: '18px 0' }}>
          No activity yet. Start the agent to stream its loop here.
        </div>
      ) : raw ? (
        <pre
          style={{
            margin: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-mono-code)',
            color: 'var(--tx-3)',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {text}
        </pre>
      ) : (
        items.map((it) =>
          it.kind === 'divider' ? (
            <TaskDivider key={it.id} label={it.label} />
          ) : (
            <LogRow
              key={it.id}
              ts={it.ts}
              severity={it.severity}
              body={it.body}
              foldCount={it.foldCount}
              foldedLines={it.foldedLines}
            />
          )
        )
      )}
    </div>
  )
}

export default ActivityStream
