import React, { useState } from 'react'
import { Modal, Button, Icon } from '@renderer/ui'

/**
 * GrokSignInModal — the PROVIDER-AWARE re-auth action for a grok agent whose loop
 * paused with `reauth_required` (grok is not logged in).
 *
 * The app already shows the needs-auth STATE everywhere (StatusPill / 🔑 / "N need
 * you"); this is the ACTION. A headless restart is useless for grok because
 * `grok login` is INTERACTIVE, so this surfaces:
 *   • an "Open login terminal" button (when the caller can spawn one — the office
 *     view reuses termRegistry to run `grok login --device-code` in the character's
 *     own workspace), and
 *   • the exact commands with copy buttons + the XAI_API_KEY escape hatch, plus a
 *     short note that grok tokens expire ~6h so a key avoids repeated logins, and
 *   • an "I've signed in — retry" button that runs the caller's headless restart.
 *
 * Shared by FleetView (workspace agents) and OfficeView (office characters) so the
 * grok sign-in experience is identical wherever a needs-auth grok agent surfaces.
 */

const LOGIN_CMD = 'grok login --device-code'
const KEY_CMD = 'export XAI_API_KEY=xai-…'

function CopyRow({ cmd }: { cmd: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'var(--bg-input)', border: '1px solid var(--bd-1)',
        borderRadius: 'var(--r-input)', padding: '7px 9px'
      }}
    >
      <code style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-desc)', color: 'var(--tx-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {cmd}
      </code>
      <button
        type="button"
        aria-label={`Copy: ${cmd}`}
        onClick={() => {
          void navigator.clipboard?.writeText(cmd).then(
            () => { setCopied(true); setTimeout(() => setCopied(false), 1400) },
            () => { /* clipboard blocked — the command is still visible to copy by hand */ }
          )
        }}
        style={{
          flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 4,
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: copied ? 'var(--st-running)' : 'var(--accent)',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-desc)', fontWeight: 600
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={12} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

export interface GrokSignInModalProps {
  open: boolean
  onClose: () => void
  /** Character / agent display name, for the title. */
  name?: string
  /** The provider's own reason (AgentState.authMessage), shown verbatim when present. */
  message?: string
  /** When provided, an "Open login terminal" button runs the interactive login in
   *  the agent's workspace (office view). Absent → only the copyable commands show. */
  onOpenTerminal?: () => void
  /** Headless restart — the "I've signed in — retry" secondary action. */
  onRetry: () => void
  /** Retry in flight (disables the button). */
  retrying?: boolean
}

export function GrokSignInModal({ open, onClose, name, message, onOpenTerminal, onRetry, retrying }: GrokSignInModalProps): React.JSX.Element {
  const label = (
    <>
      Sign in to grok
      {name ? <span style={{ color: 'var(--tx-5)', fontWeight: 400 }}> · {name}</span> : null}
    </>
  )
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={468}
      title={label}
      subtitle="grok is not logged in — the loop paused for re-authentication"
      footer={
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button variant="secondary" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Retrying…' : "I've signed in — retry"}
          </Button>
          {onOpenTerminal && (
            <Button variant="primary" onClick={onOpenTerminal}>
              <Icon name="terminal" size={12} /> Open login terminal
            </Button>
          )}
        </div>
      }
    >
      {/* The provider's own reason, verbatim, when we have it. */}
      {message && (
        <div style={{ marginBottom: 14, padding: '9px 11px', background: 'var(--st-warn-tint)', border: '1px solid var(--st-warn-ink)', borderRadius: 'var(--r-card)', fontSize: 'var(--fs-desc)', color: 'var(--st-warn-ink)', wordBreak: 'break-word' }}>
          {message}
        </div>
      )}

      {/* OPTION 1 — interactive device-code login (the recommended path). */}
      <div style={{ marginBottom: 6, fontSize: 'var(--fs-section)', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--tx-dim)' }}>
        Sign in interactively
      </div>
      <div style={{ marginBottom: 8, fontSize: 'var(--fs-desc)', color: 'var(--tx-4)' }}>
        {onOpenTerminal
          ? 'Open a login terminal (button below) and follow the device-code prompt, or run it yourself:'
          : 'Run this in the agent’s workspace and follow the device-code prompt:'}
      </div>
      <CopyRow cmd={LOGIN_CMD} />

      {/* OPTION 2 — a long-lived API key (avoids the ~6h re-login). */}
      <div style={{ marginTop: 16, marginBottom: 6, fontSize: 'var(--fs-section)', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--tx-dim)' }}>
        …or set an API key
      </div>
      <div style={{ marginBottom: 8, fontSize: 'var(--fs-desc)', color: 'var(--tx-4)' }}>
        Set <code style={{ fontFamily: 'var(--font-mono)' }}>XAI_API_KEY</code> in the agent’s environment to skip login entirely.
      </div>
      <CopyRow cmd={KEY_CMD} />

      <div style={{ marginTop: 14, fontSize: 'var(--fs-meta)', color: 'var(--tx-5)' }}>
        Grok login tokens expire roughly every 6 hours — setting <code style={{ fontFamily: 'var(--font-mono)' }}>XAI_API_KEY</code> avoids
        having to re-login. After signing in, hit <b>retry</b> to resume the agent.
      </div>
    </Modal>
  )
}

export default GrokSignInModal
