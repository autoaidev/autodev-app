import React from 'react'
import { Icon, StatusDot, IconButton } from '@renderer/ui'
import { metaFor, transportLabel, failureHint, type McpServerStatus } from './mcpStatus'

/**
 * ServerRow — one line in the 2g CONNECTIVITY list: state dot + name + transport
 * badge + command/url + colored state word + per-server `···` menu.
 *
 * A failing server wraps itself in a red-wash container and drops an inline
 * error panel with the actionable fix (Install CLI / Set path…) instead of a
 * stack trace — matching DESIGN-SPEC §3.7.
 */
export interface ServerRowProps {
  server: McpServerStatus
  /** per-server menu affordance clicked (edit / duplicate / remove / recheck one) */
  onMenu?: (server: McpServerStatus, anchor: HTMLElement) => void
  /** failing-panel primary action — "Install CLI" for a missing runner */
  onInstallCli?: (server: McpServerStatus) => void
  /** failing-panel secondary action — "Set path…" */
  onSetPath?: (server: McpServerStatus) => void
}

const badge: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '9.5px',
  letterSpacing: '.04em',
  color: 'var(--tx-4)',
  background: 'var(--bg-chip-idle)',
  border: '1px solid var(--bd-1)',
  borderRadius: 'var(--r-chip)',
  padding: '1px 5px',
  flex: 'none'
}

export function ServerRow({ server, onMenu, onInstallCli, onSetPath }: ServerRowProps): React.JSX.Element {
  const meta = metaFor(server)
  const stateColor =
    meta.tone === 'ready' ? 'var(--st-running)' : meta.tone === 'failing' ? 'var(--st-error)' : 'var(--tx-dim)'

  const row = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        padding: '9px 10px',
        borderRadius: 'var(--r-card)'
      }}
    >
      {meta.failing ? (
        <span style={{ color: 'var(--st-error)', fontSize: 12, lineHeight: 1, flex: 'none' }}>✗</span>
      ) : (
        <StatusDot status={meta.dot} size={6} />
      )}
      <span
        style={{
          width: 150,
          flex: 'none',
          fontSize: 'var(--fs-meta)',
          fontWeight: 600,
          color: 'var(--tx-1)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {server.name}
      </span>
      <span style={badge}>{transportLabel(server)}</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: '10.5px',
          color: 'var(--tx-dim)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
        title={server.detail}
      >
        {server.detail}
      </span>
      <span
        style={{
          flex: 'none',
          fontFamily: 'var(--font-mono)',
          fontSize: '10.5px',
          letterSpacing: '.06em',
          color: stateColor
        }}
      >
        {meta.label}
        {typeof server.latencyMs === 'number' && meta.tone === 'ready' ? (
          <span style={{ color: 'var(--tx-gutter)', marginLeft: 5 }}>{server.latencyMs}ms</span>
        ) : null}
      </span>
      <IconButton
        icon="more"
        iconSize={13}
        label={`${server.name} actions`}
        onClick={(e) => onMenu?.(server, e.currentTarget as HTMLElement)}
      />
    </div>
  )

  if (!meta.failing) return row

  const hint = failureHint(server)
  return (
    <div
      style={{
        background: 'var(--st-error-wash)',
        border: '1px solid var(--st-error-bd)',
        borderRadius: 'var(--r-card)',
        overflow: 'hidden'
      }}
    >
      {row}
      <div
        style={{
          margin: '0 10px 10px',
          background: 'var(--bg-panel-alt)',
          border: '1px solid var(--st-error-bd)',
          borderRadius: 'var(--r-input)',
          padding: '10px 12px'
        }}
      >
        <div style={{ fontSize: 'var(--fs-meta)', fontWeight: 700, color: 'var(--st-error-bright)' }}>
          {hint.title}
        </div>
        <div style={{ marginTop: 4, fontSize: 'var(--fs-desc)', color: 'var(--tx-3)', lineHeight: 1.5 }}>
          {hint.detail}
        </div>
        <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
          {hint.runnerMissing && (
            <button
              type="button"
              onClick={() => onInstallCli?.(server)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                background: 'var(--accent)',
                border: '1px solid transparent',
                borderRadius: 'var(--r-button)',
                color: 'var(--tx-onaccent)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-desc)',
                fontWeight: 700,
                padding: '5px 11px',
                cursor: 'pointer'
              }}
            >
              <Icon name="external" size={11} />
              Install CLI
            </button>
          )}
          <button
            type="button"
            onClick={() => onSetPath?.(server)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              background: 'var(--bg-input)',
              border: '1px solid var(--bd-1)',
              borderRadius: 'var(--r-button)',
              color: 'var(--tx-2)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-desc)',
              fontWeight: 600,
              padding: '5px 11px',
              cursor: 'pointer'
            }}
          >
            Set path…
          </button>
        </div>
      </div>
    </div>
  )
}

export default ServerRow
