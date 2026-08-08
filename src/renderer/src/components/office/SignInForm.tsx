import React from 'react'
import { Button } from '@renderer/ui'

/**
 * SignInForm — the ONE shared pixel-office credential form (R11 + R12).
 *
 * Both the Office tab and the Make-app tab post the same three fields to the same
 * server; before this they were two hand-rolled forms with divergent label casing
 * (Title Case vs ALL-CAPS) and opposite Connect-button states. This component is
 * the single source: ALL-CAPS field labels (matching the app's section-label
 * convention — SETTINGS / SETUP), and ONE Connect rule — disabled-until-valid,
 * rendered with the shared token <Button> so its disabled state is identical in
 * both places. Token-only styling (theme.css vars); no hardcoded colour.
 *
 * The surrounding copy (title / description / footer) is parametrised so each tab
 * keeps its own voice while the field set + button behave identically.
 */

const FIELDS = [
  { key: 'base', label: 'SERVER URL', type: 'text', autoComplete: undefined },
  { key: 'email', label: 'EMAIL', type: 'email', autoComplete: 'username' },
  { key: 'password', label: 'PASSWORD', type: 'password', autoComplete: 'current-password' }
] as const

export interface SignInFormProps {
  title: React.ReactNode
  description?: React.ReactNode
  base: string
  email: string
  password: string
  onBase: (v: string) => void
  onEmail: (v: string) => void
  onPassword: (v: string) => void
  onSubmit: () => void
  loading?: boolean
  error?: string
  submitLabel?: string
  connectingLabel?: string
  basePlaceholder?: string
  emailPlaceholder?: string
  footer?: React.ReactNode
  /** width of the card (Office uses 380, Make app 340) */
  width?: number
}

export function SignInForm({
  title,
  description,
  base,
  email,
  password,
  onBase,
  onEmail,
  onPassword,
  onSubmit,
  loading = false,
  error,
  submitLabel = 'Connect',
  connectingLabel = 'Connecting…',
  basePlaceholder,
  emailPlaceholder = 'you@example.com',
  footer,
  width = 380
}: SignInFormProps): React.JSX.Element {
  const valid = !!(base.trim() && email && password)
  const value: Record<string, string> = { base, email, password }
  const setter: Record<string, (v: string) => void> = { base: onBase, email: onEmail, password: onPassword }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        background: 'var(--bg-0)',
        fontFamily: 'var(--font-sans)'
      }}
    >
      <style>{`.signin-input:focus{border-color:var(--accent)!important;box-shadow:0 0 0 3px var(--accent-tint)}`}</style>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (valid && !loading) onSubmit()
        }}
        style={{
          width,
          maxWidth: '100%',
          background: 'var(--bg-panel)',
          border: '1px solid var(--bd-strong)',
          borderRadius: 'var(--r-modal)',
          padding: 24,
          boxShadow: 'var(--shadow-modal)'
        }}
      >
        <h2 style={{ margin: '0 0 6px', fontSize: 'var(--fs-panel-title)', fontWeight: 700, color: 'var(--tx-hi)' }}>
          {title}
        </h2>
        {description && (
          <p style={{ margin: '0 0 18px', fontSize: 'var(--fs-meta)', color: 'var(--tx-4)', lineHeight: 1.55 }}>
            {description}
          </p>
        )}
        {FIELDS.map((f) => (
          <label key={f.key} style={{ display: 'block', marginBottom: 11 }}>
            <span
              style={{
                display: 'block',
                fontSize: 'var(--fs-desc)',
                fontWeight: 700,
                letterSpacing: '.09em',
                color: 'var(--tx-4)',
                marginBottom: 5
              }}
            >
              {f.label}
            </span>
            <input
              className="signin-input"
              type={f.type}
              autoComplete={f.autoComplete}
              value={value[f.key]}
              onChange={(e) => setter[f.key](e.target.value)}
              placeholder={f.key === 'base' ? basePlaceholder : f.key === 'email' ? emailPlaceholder : undefined}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 11px',
                background: 'var(--bg-input)',
                border: '1px solid var(--bd-1)',
                borderRadius: 'var(--r-input)',
                color: 'var(--tx-1)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-body)',
                outline: 'none'
              }}
            />
          </label>
        ))}
        {error && (
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 7,
              color: 'var(--st-error-bright)',
              fontSize: 'var(--fs-meta)',
              margin: '2px 0 6px',
              lineHeight: 1.45
            }}
          >
            <span aria-hidden style={{ fontWeight: 700 }}>
              !
            </span>{' '}
            <span>{error}</span>
          </div>
        )}
        <Button variant="primary" type="submit" block disabled={loading || !valid} style={{ marginTop: 10 }}>
          {loading ? connectingLabel : submitLabel}
        </Button>
        {footer && <div style={{ marginTop: 12 }}>{footer}</div>}
      </form>
    </div>
  )
}

export default SignInForm
