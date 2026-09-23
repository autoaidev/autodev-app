import React from 'react'
import { Button, Icon } from '@renderer/ui'
import { LogRow, LogSeverity } from './LogRow'
import { useAgentLog } from '@renderer/services/logBuffer'
import { describeExit } from '@renderer/services/model'
import { useCliStatus } from '@renderer/services/cliStatus'
import { useAdvancedMode } from '@renderer/services/advancedMode'
import { stripAnsi } from '@renderer/lib/ansi'

/**
 * ActivityStream — the parsed Activity tab body (2a).
 *
 * Takes the RAW provider log buffer (streamed through window.api.onAgentLog and
 * buffered by AgentsView) and turns it into a readable timeline instead of echoing
 * ANSI: timestamps are stripped to a gutter (LogRow), severity is colour-coded,
 * runs of repeated MCP lines fold into a single "N MCP calls ▾" summary, and
 * "TASK n OF m" markers become centered dividers.
 *
 * It reads the shared, path-scoped logBuffer service (useAgentLog) so a new line
 * re-renders ONLY this pane — never the parent view, which keeps the composer/
 * search inputs from dropping keystrokes.
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

// A leading clock-time: optional "[", the time, an optional 12-hour AM/PM suffix,
// an optional closing "]", then whitespace. Matching the AM/PM + "]" here is what
// stops the "PM]" channel-prefix artifact from leaking into every body line (R2).
const TS_HMS = /^\s*\[?\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:[AaPp][Mm])?\s*\]?\s+/
const TS_ISO = /^\s*\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2}(?::\d{2})?)\S*\s+/
const DIVIDER = /task\s+(\d+)\s*(?:of|\/)\s*(\d+)/i
const RE_MAIL = /task from|message from|received (?:a )?task|inbound|from project-manager|✉/i
const RE_ERROR = /\berror\b|\bfailed\b|\bfailing\b|not started|cannot\b|unable to|timed out|timeout|✗|exit code [1-9]/i
const RE_MCP = /\bmcp\b|mcp-operate|tool call|tool\.call/i
// A raw loop-exit line — "[loop exited code=130]", "loop exited with code 130",
// "exited with code 0". Translated to plain language (R8) so the code number is
// never the primary explanation.
const RE_EXIT = /(?:loop\s+)?exit(?:ed|s)?\b[^0-9]*code[ =]+(\d+)/i
// Optional-config warnings that don't block the run — downgraded from alarm to
// muted info (R9) so they don't read like a fatal failure.
const RE_BENIGN = /task poller not started|no [\w-]+ entry in \.mcp\.json|optional mcp|not configured/i
const RE_EMAIL_POLLER = /email task poller not started/i

/** Clean "H:MM" gutter time — drops seconds and never leaves a trailing colon
 *  (the old slice(0,5) turned "4:46:32" into the broken-looking "4:46:"). */
function fmtGutter(t: string): string {
  const p = t.split(':')
  return p.length >= 2 ? `${p[0]}:${p[1]}` : t
}

function stripTs(line: string): { ts?: string; rest: string } {
  let m = line.match(TS_HMS)
  if (m) return { ts: fmtGutter(m[1]), rest: line.slice(m[0].length) }
  m = line.match(TS_ISO)
  if (m) return { ts: fmtGutter(m[1]), rest: line.slice(m[0].length) }
  return { rest: line }
}

function severityOf(text: string): LogSeverity {
  if (RE_MAIL.test(text)) return 'mail'
  if (RE_ERROR.test(text)) return 'error'
  if (RE_MCP.test(text)) return 'mcp'
  return 'info'
}

/** Cheap djb2 string hash → base36, for deriving content-stable React keys. */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** Parse the raw buffer into dividers + rows, folding consecutive MCP lines. */
export function parseLog(raw: string): StreamItem[] {
  const lines = stripAnsi(raw)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0)

  const items: StreamItem[] = []
  let mcpBuf: { ts?: string; body: string }[] = []

  // Content-derived keys so a row's key follows its content across front-
  // truncation of the 20k buffer (positional ids would shift every parse and
  // force React to re-mount/mis-diff rows). A per-parse occurrence counter
  // disambiguates identical lines while preserving order.
  const seen = new Map<string, number>()
  const keyFor = (base: string): string => {
    const c = seen.get(base) ?? 0
    seen.set(base, c + 1)
    return c === 0 ? base : `${base}#${c}`
  }

  const flushMcp = (): void => {
    if (mcpBuf.length === 0) return
    if (mcpBuf.length === 1) {
      const only = mcpBuf[0]
      items.push({ kind: 'row', id: keyFor('r:' + hash((only.ts ?? '') + '|' + only.body)), ts: only.ts, severity: 'mcp', body: only.body })
    } else {
      items.push({
        kind: 'row',
        id: keyFor('f:' + hash((mcpBuf[0].ts ?? '') + '|' + mcpBuf.map((m) => m.body).join('\n'))),
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
    // Defensive strip of a residual "PM]"/"AM]" channel prefix if a timestamp was
    // consumed upstream but its meridiem tail survived (R2).
    let body = rest.trim().replace(/^(?:AM|PM)\]\s*/i, '')
    const dm = body.match(DIVIDER)
    if (dm) {
      flushMcp()
      items.push({ kind: 'divider', id: keyFor('d:' + hash(`${dm[1]}/${dm[2]}`)), label: `TASK ${dm[1]} OF ${dm[2]}` })
      continue
    }
    // R8: a loop-exit line becomes plain language. An intentional interrupt (130) /
    // terminate (143) / clean exit (0) is info, not an error alarm.
    const em = body.match(RE_EXIT)
    if (em) {
      const code = Number(em[1])
      const gentle = code === 0 || code === 130 || code === 143
      flushMcp()
      items.push({
        kind: 'row',
        id: keyFor('r:' + hash((ts ?? '') + '|exit' + code)),
        ts,
        severity: gentle ? 'info' : 'error',
        body: `Agent stopped — ${describeExit(code)}.`
      })
      continue
    }
    let sev = severityOf(body)
    // R9: an optional-MCP / poller warning doesn't block the run — mute it and give
    // the email-poller case a clearer, non-alarming phrasing.
    if (sev === 'error' && RE_BENIGN.test(body)) {
      sev = 'info'
      if (RE_EMAIL_POLLER.test(body)) body = 'Email polling is off (optional MCP not configured).'
    }
    if (sev === 'mcp') {
      mcpBuf.push({ ts, body })
      continue
    }
    flushMcp()
    items.push({ kind: 'row', id: keyFor('r:' + hash((ts ?? '') + '|' + body)), ts, severity: sev, body })
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
  /** the selected agent's workspace path — keys the shared log buffer */
  path: string
  /** initial snapshot fallback so an agent with only a lastOutput still shows it */
  lastOutput?: string
  /** auto-scroll to the newest line when true (the Follow toggle) */
  follow: boolean
  /** show the unparsed raw buffer instead of the parsed rows (Raw log link) */
  raw?: boolean
  /**
   * whether this pane is the on-screen sub-tab. The stream stays mounted while its
   * sub-tab is hidden (display:none), during which its scrollTop can't track new
   * output; re-pin to the bottom when it becomes visible again so a hidden→visible
   * transition doesn't leave the view scrolled up.
   */
  active?: boolean
  /** live run flag — drives the empty state (idle → Start CTA, running → waiting). */
  running?: boolean
  /** last-session task tally, shown as a summary line in the empty state. */
  tasksDone?: number
  tasksTotal?: number
  /** unchecked tasks left in TODO.md — drives the idle empty-state copy so Start is
   *  only pitched as "picks up the first unchecked task" when one actually exists. */
  tasksRemaining?: number
  /** start the agent from the empty state's primary CTA (idle only). */
  onStart?: () => void
}

export function ActivityStream({
  path,
  lastOutput,
  follow,
  raw = false,
  active = true,
  running = false,
  tasksDone = 0,
  tasksTotal = 0,
  tasksRemaining = 0,
  onStart
}: ActivityStreamProps): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  // Without the AutoDev CLI runner, Start is guaranteed to fail — so disable the
  // empty-state CTA and say why, instead of inviting a press that can't work (R5).
  const { missing: cliMissing } = useCliStatus()
  // Basic renders the parsed stream calm (no ⚙ gears, looser rhythm); Advanced
  // keeps the dense expert stream. The Raw-log toggle stays Advanced (in AgentDetail).
  const { advanced } = useAdvancedMode()

  // Read the shared, path-scoped buffer; fall back to the agent's initial snapshot
  // (lastOutput) when nothing has streamed yet so the pane isn't blank on first open.
  const text = useAgentLog(path) || lastOutput || ''
  const items = React.useMemo(() => (raw ? [] : parseLog(text)), [text, raw])

  // Follow: stick to the bottom on new output only while Follow is on AND the pane is
  // visible. `active` is a dep so a hidden→visible transition re-pins to the bottom —
  // otherwise output that streamed while hidden (display:none, scrollTop frozen) would
  // leave the view scrolled up when the sub-tab is shown again.
  React.useEffect(() => {
    if (follow && active && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text, follow, raw, active])

  const empty = text.trim().length === 0
  const hasTask = tasksRemaining > 0

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
        <div
          style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            gap: 12,
            padding: 24
          }}
        >
          <span style={{ color: 'var(--tx-dim)', display: 'inline-flex' }}>
            <Icon name="terminal" size={26} />
          </span>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              fontSize: 'var(--fs-body)',
              fontWeight: 'var(--fw-selected)',
              color: 'var(--tx-2)'
            }}
          >
            {running ? 'Waiting for output…' : hasTask ? 'Agent is idle' : 'No tasks yet'}
            {/* Streaming/thinking indicator — three breathing dots while the loop is
                live and producing. Motion is disabled under prefers-reduced-motion. */}
            {running && (
              <span className="ad-thinking" aria-hidden style={{ color: 'var(--st-good-ink)' }}>
                <i />
                <i />
                <i />
              </span>
            )}
          </div>
          <div style={{ maxWidth: 420, fontSize: 'var(--fs-meta)', lineHeight: 1.55, color: 'var(--tx-4)' }}>
            {running
              ? 'This agent is running — its loop output will stream here as it works.'
              : hasTask
                ? 'Press Start and it picks up the first unchecked task in TODO.md and works autonomously.'
                : 'Add a task below (or in TODO.md), then Start — the loop picks up the first unchecked task and works autonomously.'}
          </div>
          {tasksTotal > 0 && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>
              {tasksDone}/{tasksTotal} tasks done · last session
            </div>
          )}
          {/* With an unchecked task, Start is the obvious next action (primary). With
              none, the composer below is — so Start is demoted to secondary and the
              copy points at it, matching what Start would actually do (R5). */}
          {!running && onStart && (
            <>
              <Button
                variant={hasTask ? 'primary' : 'secondary'}
                onClick={onStart}
                disabled={cliMissing}
              >
                <Icon name="play" size={10} /> Start agent
              </Button>
              {cliMissing && (
                <div style={{ fontSize: 'var(--fs-tiny)', color: 'var(--st-error-bright)' }}>
                  Install the AutoDev CLI to run agents.
                </div>
              )}
            </>
          )}
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
          {stripAnsi(text)}
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
              calm={!advanced}
            />
          )
        )
      )}
    </div>
  )
}

export default ActivityStream
