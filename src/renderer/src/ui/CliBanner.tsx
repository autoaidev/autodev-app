import React from 'react'
import { Button } from './Button'
import { Icon } from './Icon'

/**
 * CliBanner — the "AutoDev CLI isn't installed" strip, rendered by <AppShell> in
 * its OWN full-width layout row directly beneath the nav bar (never an overlay).
 * Because it is a normal flex child it reserves vertical space and pushes the
 * screen's content header down, so it can never sit on top of the agent toolbar,
 * a session title, or the Settings heading. Returns null when the CLI is present,
 * collapsing the row to zero height.
 *
 * Pure/presentational: it takes the resolved status + handlers as props (AppShell
 * feeds them from the Cli-status context) so it carries no data dependency of its
 * own. Styling is token-only (theme.css --st-error* family).
 *
 * Two actions, matching the onboarding need: a PRIMARY "Install CLI" that reveals
 * a copyable install command + guide link (a first-time user has no other way to
 * unblock), and a SECONDARY "Recheck". The copy line disambiguates the AutoDev CLI
 * (the missing runner) from the provider CLIs (Grok / Claude), which may already
 * be installed.
 */
export function CliBanner({
  missing,
  checking,
  onRecheck
}: {
  missing: boolean
  checking: boolean
  onRecheck: () => void | Promise<void>
}): React.JSX.Element | null {
  const [showHelp, setShowHelp] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  if (!missing) return null

  const cmd = 'npm install -g autodev-cli'
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(cmd)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — the command is shown for manual copy */
    }
  }

  return (
    <div
      role="alert"
      style={{
        background: 'var(--st-error-soft)',
        borderBottom: '1px solid var(--st-error-bd)',
        fontFamily: 'var(--font-sans)'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          padding: '9px 16px'
        }}
      >
        <span
          aria-hidden
          style={{
            flex: 'none',
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--st-error)'
          }}
        />
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <div style={{ fontSize: 'var(--fs-meta)', fontWeight: 600, color: 'var(--st-error-bright)' }}>
            The AutoDev CLI isn&rsquo;t installed &mdash; agents can&rsquo;t run until it is.
          </div>
          <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-3)', marginTop: 2 }}>
            The AutoDev runner that drives your agents is the missing piece — install it, then check
            your provider CLIs (Claude, Grok) are signed in on this machine.
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowHelp((v) => !v)}
            aria-expanded={showHelp}
          >
            <Icon name="external" size={11} /> Install CLI
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onRecheck()}
            disabled={checking}
          >
            <Icon name="refresh" size={11} /> {checking ? 'Checking…' : 'Recheck'}
          </Button>
        </div>
      </div>

      {showHelp && (
        <div
          style={{
            padding: '0 16px 11px 26px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxWidth: 720
          }}
        >
          <div style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-3)' }}>
            Install the AutoDev CLI globally, then press Recheck:
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px 6px 12px',
              borderRadius: 'var(--r-input)',
              background: 'var(--bg-input)',
              border: '1px solid var(--bd-1)'
            }}
          >
            <code
              style={{
                flex: 1,
                minWidth: 0,
                overflowX: 'auto',
                whiteSpace: 'nowrap',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-mono-code)',
                color: 'var(--tx-1)'
              }}
            >
              {cmd}
            </code>
            <Button variant="secondary" size="sm" onClick={() => void copy()}>
              <Icon name={copied ? 'check' : 'copy'} size={11} /> {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <button
            type="button"
            onClick={() => window.api?.openExternal?.('https://autoaidev.com')}
            style={{
              alignSelf: 'flex-start',
              all: 'unset',
              cursor: 'pointer',
              color: 'var(--accent)',
              fontSize: 'var(--fs-desc)'
            }}
          >
            Open the install guide ↗
          </button>
        </div>
      )}
    </div>
  )
}

export default CliBanner
