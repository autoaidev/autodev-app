import React from 'react'
import { Icon } from './Icon'

/**
 * ErrorBoundary — the resilience seam for the keep-alive shell.
 *
 * A single render throw anywhere in a React tree unmounts the WHOLE tree back to
 * the nearest boundary. In this app that would white-screen every screen at once
 * and — because unmounting a live TerminalPane runs ptyKill — SIGKILL every live
 * PTY across every view. Wrapping each keep-alive view layer in its own boundary
 * contains the blast radius: the crashing view shows a local fallback card while
 * its SIBLING layers stay mounted and their child shells keep running.
 *
 * Pass a `resetKey` (we feed it `nav`): when it changes, a previously caught
 * error is cleared so the view re-renders on the next navigation. `resetKey` is a
 * plain prop, NOT React `key`, so a healthy boundary never remounts its children
 * on navigation — that would be exactly the PTY teardown we are avoiding.
 */
export interface ErrorBoundaryProps {
  children: React.ReactNode
  /** Changing this clears a caught error (we pass the active nav id). */
  resetKey?: unknown
  /** Optional screen name shown in the fallback ("Agents hit an error"). */
  label?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Fallback owns the UI; log for diagnosis so the throw isn't swallowed silently.
    console.error('[ErrorBoundary] render crashed:', error, info.componentStack)
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  private reset = (): void => this.setState({ error: null })

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const title = this.props.label ? `${this.props.label} hit an error` : 'This screen hit an error'
    return (
      <div
        role="alert"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: 'var(--bg-0)'
        }}
      >
        <div
          style={{
            maxWidth: 440,
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            background: 'var(--bg-elev)',
            border: '1px solid var(--st-error-bd)',
            borderRadius: 'var(--r-card)',
            padding: '20px 22px',
            boxShadow: '0 6px 24px rgba(0,0,0,.4)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Icon name="close" size={14} color="var(--st-error)" />
            <span
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-section)',
                color: 'var(--tx-1)'
              }}
            >
              {title}
            </span>
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-tiny)',
              color: 'var(--tx-3)',
              wordBreak: 'break-word',
              lineHeight: 1.5
            }}
          >
            {error.message || String(error)}
          </div>
          <div>
            <button
              type="button"
              onClick={this.reset}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                background: 'var(--bg-input)',
                border: '1px solid var(--bd-1)',
                color: 'var(--tx-1)',
                borderRadius: 'var(--r-button)',
                padding: '6px 12px',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-desc)',
                cursor: 'pointer'
              }}
            >
              <Icon name="refresh" size={12} color="var(--tx-2)" />
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}

export default ErrorBoundary
