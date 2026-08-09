import React from 'react'
import { Button, InfoTip } from '@renderer/ui'

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
 * The surrounding copy (title / description) is parametrised so each tab keeps its
 * own voice while the field set + button behave identically.
 *
 * Setup guidance (added): the SERVER URL is validated for http(s) shape (matching
 * Settings' looksValid) so the two connect surfaces agree on strictness; a
 * "Test connection" affordance probes the URL via window.api.officePing BEFORE any
 * credential is typed (real success/error feedback, not a silent server error at
 * submit); an inline InfoTip explains what a Pixel Office is; and the "create an
 * account" link is built-in and never a dead click — when the URL is blank it
 * focuses the field and says so instead of no-opping.
 */

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
  /** Extra content rendered under the built-in create-account line. */
  footer?: React.ReactNode
  /** width of the card (Office uses 380, Make app 340) */
  width?: number
}

/** http(s)-shape check, mirroring SettingsView2.looksValid — empty is "not yet",
 *  not an error (the Connect button already requires a non-empty base). */
function urlLooksValid(v: string): boolean {
  const s = v.trim()
  if (!s) return true
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

const fieldLabel: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 'var(--fs-desc)',
  fontWeight: 700,
  letterSpacing: '.09em',
  color: 'var(--tx-4)',
  marginBottom: 5
}
const inputStyle: React.CSSProperties = {
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
  basePlaceholder = 'https://app.pixeloffice.org',
  emailPlaceholder = 'you@example.com',
  footer,
  width = 380
}: SignInFormProps): React.JSX.Element {
  const baseRef = React.useRef<HTMLInputElement>(null)
  const [testing, setTesting] = React.useState(false)
  const [test, setTest] = React.useState<{ ok: boolean; msg: string } | null>(null)

  const baseValid = urlLooksValid(base)
  const baseMalformed = base.trim() !== '' && !baseValid
  const valid = !!(base.trim() && baseValid && email && password)

  // Clear any prior test result when the URL changes.
  const onBaseChange = (v: string): void => {
    if (test) setTest(null)
    onBase(v)
  }

  const testConnection = React.useCallback(async (): Promise<void> => {
    const b = base.trim()
    if (!b) {
      setTest({ ok: false, msg: 'Enter a Server URL first.' })
      baseRef.current?.focus()
      return
    }
    if (!baseValid) {
      setTest({ ok: false, msg: 'That doesn’t look like an http(s) URL.' })
      return
    }
    setTesting(true)
    setTest(null)
    try {
      const r = (await window.api.officePing(b)) as { ok?: true; error?: string }
      setTest(r?.ok ? { ok: true, msg: 'Reachable — this is a Pixel Office.' } : { ok: false, msg: r?.error || 'Could not reach that server.' })
    } catch (e) {
      setTest({ ok: false, msg: String((e as Error)?.message ?? e) })
    } finally {
      setTesting(false)
    }
  }, [base, baseValid])

  const openOffice = (): void => {
    const b = base.trim()
    if (b && baseValid) {
      void window.api.openExternal(b)
    } else {
      setTest({ ok: false, msg: 'Enter your Server URL above first, then open it to sign up.' })
      baseRef.current?.focus()
    }
  }

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
        <h2 style={{ margin: '0 0 6px', fontSize: 'var(--fs-panel-title)', fontWeight: 700, color: 'var(--tx-hi)', display: 'flex', alignItems: 'center', gap: 6 }}>
          {title}
          <InfoTip label="Pixel Office" width={260}>
            A Pixel Office is an optional shared team server — a room of remote agents you and your teammates can watch, message, and steer together. You need an account on the server; agents can also run locally without one.
          </InfoTip>
        </h2>
        {description && (
          <p style={{ margin: '0 0 18px', fontSize: 'var(--fs-meta)', color: 'var(--tx-4)', lineHeight: 1.55 }}>
            {description}
          </p>
        )}

        {/* SERVER URL — validated + testable */}
        <label style={{ display: 'block', marginBottom: 11 }}>
          <span style={fieldLabel}>
            SERVER URL
            <InfoTip label="Server URL" width={250}>
              The address of your Pixel Office server, e.g. <code>https://app.pixeloffice.org</code>. Your team admin can give you this. https only — http is allowed for localhost.
            </InfoTip>
          </span>
          <input
            ref={baseRef}
            className="signin-input"
            type="text"
            value={base}
            onChange={(e) => onBaseChange(e.target.value)}
            placeholder={basePlaceholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)', borderColor: baseMalformed ? 'var(--st-error-bd)' : 'var(--bd-1)' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
            <button
              type="button"
              onClick={() => void testConnection()}
              disabled={testing || !base.trim()}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                color: base.trim() ? 'var(--accent)' : 'var(--tx-faint)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-desc)',
                fontWeight: 600,
                cursor: testing || !base.trim() ? 'default' : 'pointer'
              }}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {(baseMalformed || test) && (
              <span
                role="status"
                style={{
                  fontSize: 'var(--fs-desc)',
                  lineHeight: 1.35,
                  color: baseMalformed || test?.ok === false ? 'var(--st-error-bright)' : 'var(--st-running)'
                }}
              >
                {baseMalformed ? 'That doesn’t look like an http(s) URL.' : test?.ok ? '✓ ' + test.msg : test?.msg}
              </span>
            )}
          </div>
        </label>

        {/* EMAIL */}
        <label style={{ display: 'block', marginBottom: 11 }}>
          <span style={fieldLabel}>EMAIL</span>
          <input
            className="signin-input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => onEmail(e.target.value)}
            placeholder={emailPlaceholder}
            style={inputStyle}
          />
        </label>

        {/* PASSWORD */}
        <label style={{ display: 'block', marginBottom: 11 }}>
          <span style={fieldLabel}>PASSWORD</span>
          <input
            className="signin-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            style={inputStyle}
          />
        </label>

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

        {/* Built-in create-account line — never a dead click. */}
        <p style={{ margin: '12px 0 0', fontSize: 'var(--fs-desc)', color: 'var(--tx-4)' }}>
          New here?{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              openOffice()
            }}
            style={{ color: 'var(--accent)' }}
          >
            Open the office
          </a>{' '}
          to create an account.
        </p>
        {footer && <div style={{ marginTop: 12 }}>{footer}</div>}
      </form>
    </div>
  )
}

export default SignInForm
