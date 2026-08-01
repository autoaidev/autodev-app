import { useEffect, useRef, useState, useCallback } from 'react'

const inp: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px',
  background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--fg)', fontSize: 13
}

/**
 * App preferences. Today: the Pixel Office server URL, persisted in the main
 * process (userData/app-settings.json) so it survives restarts. Changing it does
 * NOT touch an already-connected session — office.status() reads the setting live,
 * so the new base is used on the NEXT connect from any login form.
 */
export default function SettingsView({ showToast }: { showToast: (msg: string, err?: boolean) => void }): JSX.Element {
  const [base, setBase] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [defaultBase, setDefaultBase] = useState('')   // built-in fallback (what an empty value resolves to)
  const [saving, setSaving] = useState(false)
  const [ok, setOk] = useState(false)                  // brief "Saved ✓" pulse on the button
  const [err, setErr] = useState('')
  const okTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    (async () => {
      const cfg = (await window.api.getSettings()) as { officeBaseUrl: string }
      setBase(cfg.officeBaseUrl || '')
      setDefaultBase(cfg.officeBaseUrl || '')
      setLoaded(true)
    })()
    return () => { if (okTimer.current) clearTimeout(okTimer.current) }
  }, [])

  const flashOk = useCallback(() => {
    setOk(true)
    if (okTimer.current) clearTimeout(okTimer.current)
    okTimer.current = setTimeout(() => setOk(false), 1800)
  }, [])

  // Light client-side check so the button gives feedback without a round-trip;
  // the main process re-validates (https, or http only for localhost) authoritatively.
  const looksValid = useCallback((v: string): boolean => {
    const s = v.trim()
    if (!s) return true // empty = reset to default
    try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' } catch { return false }
  }, [])

  const save = useCallback(async () => {
    setErr(''); setSaving(true)
    const r = (await window.api.setSettings({ officeBaseUrl: base.trim() })) as { ok?: true; officeBaseUrl?: string; error?: string }
    setSaving(false)
    if (r?.error) { setErr(r.error); showToast(r.error, true); return }
    const resolved = r.officeBaseUrl ?? ''
    setBase(resolved)
    flashOk()
    showToast('Pixel Office server URL saved — applies on your next connect.')
  }, [base, flashOk, showToast])

  const resetToDefault = useCallback(async () => {
    setErr(''); setSaving(true)
    const r = (await window.api.setSettings({ officeBaseUrl: '' })) as { ok?: true; officeBaseUrl?: string; error?: string }
    setSaving(false)
    if (r?.error) { setErr(r.error); return }
    setBase(r.officeBaseUrl ?? '')
    flashOk()
    showToast('Reset to the default Pixel Office server.')
  }, [flashOk, showToast])

  const dirty = base.trim() !== defaultBase.trim()
  const invalid = !looksValid(base)

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '28px 32px' }}>
      <div style={{ maxWidth: 560 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>⚙ Settings</h2>
        <p style={{ margin: '0 0 24px', fontSize: 12, color: 'var(--muted)' }}>Preferences for this app on this machine.</p>

        <section style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: 18 }}>
          <h3 style={{ margin: '0 0 2px', fontSize: 14 }}>☁ Pixel Office</h3>
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--muted)' }}>
            The server the app connects to when you sign in to your remote office.
          </p>

          <label className="fld" htmlFor="settings-office-base" style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Pixel Office server URL</label>
          <input
            id="settings-office-base"
            value={base}
            disabled={!loaded}
            onChange={(e) => { setBase(e.target.value); setErr('') }}
            onKeyDown={(e) => { if (e.key === 'Enter' && dirty && !invalid && !saving) void save() }}
            placeholder={defaultBase || 'https://…'}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            style={{ ...inp, borderColor: invalid ? 'var(--red)' : 'var(--border)' }}
          />
          <div style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
            https only; http is allowed for localhost. Leave blank to use the built-in default.
          </div>
          {invalid && <div role="alert" style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>That doesn’t look like an http(s) URL.</div>}
          {err && <div role="alert" style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{err}</div>}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
            <button
              className="primary"
              onClick={() => void save()}
              disabled={!loaded || saving || invalid || !dirty}
              style={{ minWidth: 96 }}
              title={!dirty ? 'No changes to save' : 'Save the Pixel Office server URL'}>
              {saving ? 'Saving…' : ok ? '✓ Saved' : 'Save'}
            </button>
            <button
              onClick={() => void resetToDefault()}
              disabled={!loaded || saving || base.trim() === ''}
              title="Clear the custom URL and use the built-in default">
              Reset to default
            </button>
          </div>

          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12, lineHeight: 1.5 }}>
            Applies to your next connect. Currently signed-in sessions are unaffected until you reconnect.
          </div>
        </section>
      </div>
    </div>
  )
}
