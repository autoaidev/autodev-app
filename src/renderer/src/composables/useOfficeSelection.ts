import { useCallback, useEffect, useState } from 'react'

/** A pixel office as returned by the office API. */
export interface Office {
  slug: string
  id: number
  name: string
}

/** Sentinel dropdown value: create a brand-new office (context-dependent). */
export const NEW_OFFICE = '__new__'

/**
 * What the current selection resolves to:
 *  - `none`   → the "Connect to pixel office" checkbox is off (or not connected) → local only.
 *  - `new`    → the ＋ New office option is picked (caller decides how to create it).
 *  - `office` → an existing office is picked.
 */
export type OfficeChoice =
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'office'; office: Office }

export interface UseOfficeSelection {
  /** Whether we have a live pixel-office session (drives whether the selector shows). */
  connected: boolean
  setConnected: (v: boolean) => void
  /** The user's offices (populated once connected). */
  offices: Office[]
  /** (Re)load the office list — safe to call after creating a new office. */
  loadOffices: () => Promise<void>
  /** The "Connect to pixel office" checkbox state. */
  useOffice: boolean
  setUseOffice: (v: boolean) => void
  /** The selected office id (as a string), or NEW_OFFICE. */
  selectedOfficeId: string
  setSelectedOfficeId: (v: string) => void
  /** Resolve the current selection into a concrete choice. */
  resolve: () => OfficeChoice
}

/**
 * Shared "connect to a pixel office?" selection state, extracted so the Create
 * dialog, the Spawn-agents view, and any other site drive ONE implementation.
 *
 * Owns: the live-connection probe (officeStatus + autoConnect), the office list,
 * the checkbox toggle, and the selected-office id (with the NEW_OFFICE sentinel).
 * Presentation lives in `OfficeSelector`; office-binding lives in
 * `connectAgentToNewCharacter` below.
 */
export function useOfficeSelection(opts?: {
  defaultUseOffice?: boolean
  defaultSelection?: string
}): UseOfficeSelection {
  const [connected, setConnected] = useState(false)
  const [offices, setOffices] = useState<Office[]>([])
  const [useOffice, setUseOffice] = useState(opts?.defaultUseOffice ?? false)
  const [selectedOfficeId, setSelectedOfficeId] = useState<string>(opts?.defaultSelection ?? NEW_OFFICE)

  // Probe for a live session once on mount (reusing the app's shared office
  // session — same one the Office view uses). autoConnect is a no-op if already up.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const st = (await window.api.officeStatus()) as { connected: boolean }
        const ok = st.connected || (await window.api.officeAutoConnect())
        if (alive) setConnected(!!ok)
      } catch {
        if (alive) setConnected(false)
      }
    })()
    return () => { alive = false }
  }, [])

  const loadOffices = useCallback(async () => {
    try {
      const list = (await window.api.officeOffices()) as Office[]
      setOffices(Array.isArray(list) ? list : [])
    } catch {
      setOffices([])
    }
  }, [])

  // Populate/refresh the dropdown whenever we (re)connect.
  useEffect(() => { if (connected) void loadOffices() }, [connected, loadOffices])

  const resolve = useCallback((): OfficeChoice => {
    if (!connected || !useOffice) return { kind: 'none' }
    if (selectedOfficeId === NEW_OFFICE) return { kind: 'new' }
    const office = offices.find((o) => String(o.id) === selectedOfficeId)
    return office ? { kind: 'office', office } : { kind: 'none' }
  }, [connected, useOffice, selectedOfficeId, offices])

  return {
    connected,
    setConnected,
    offices,
    loadOffices,
    useOffice,
    setUseOffice,
    selectedOfficeId,
    setSelectedOfficeId,
    resolve
  }
}

/**
 * Bind a freshly-created LOCAL agent to a pixel office by creating a new
 * character in that office and connecting the workspace to it — mirrors
 * ConnectModal's create-a-new-character path (createCharacter → setupUrl →
 * `autodev connect --setup-url`). Optionally enables the office file browser via
 * the `--file-browser` connect arg.
 *
 * Returns `{ ok }` on success or `{ ok: false, error }` with a user-facing message.
 */
export async function connectAgentToNewCharacter(
  office: { id: number; slug: string },
  charName: string,
  path: string,
  fileBrowser: boolean
): Promise<{ ok: boolean; error?: string; charId?: string }> {
  const created = (await window.api.officeCreateCharacter(office.id, charName)) as
    { ok?: boolean; id?: string; error?: string }
  if (created?.error || !created?.id) return { ok: false, error: created?.error || 'Could not create the office character' }
  const su = (await window.api.officeSetupUrl(office.slug, created.id)) as
    { ok?: boolean; setupUrl?: string; error?: string }
  if (su?.error || !su?.setupUrl) return { ok: false, error: su?.error || 'Could not get a setup URL for that character' }
  const args = ['connect', '--setup-url', su.setupUrl, path]
  if (fileBrowser) args.push('--file-browser')
  const r = await window.api.runCli(args)
  if (r.code !== 0) return { ok: false, error: r.stderr || 'Connect failed', charId: created.id }
  return { ok: true, charId: created.id }
}
