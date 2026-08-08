/**
 * Shared types + helpers for the Office screen (2c).
 *
 * These mirror the REAL office data shapes returned by `window.api` (see
 * docs/redesign/CURRENT-APP.md §1g) — no invented fields. Kept in one place so
 * OfficeView and the components/office/* cards stay small and share one vocabulary.
 */

/** A flat office character as returned by `officeAgents()`. */
export interface OfficeAgent {
  office: string
  officeSlug: string
  id: string
  name: string
  slug: string
  status?: string
  online: boolean
  provider?: string
  model?: string
}

/**
 * The raw shape as it actually crosses `window.api.officeAgents()`: the backend
 * emits the character `id` as a NUMBER, so string comparisons / `startsWith` on
 * it silently mis-match. Normalize at the boundary (see `normalizeAgent`) so the
 * rest of the app only ever sees the string-typed `OfficeAgent` above.
 */
export type RawOfficeAgent = Omit<OfficeAgent, 'id'> & { id: string | number }

/** Coerce one raw office agent to the string-id `OfficeAgent` contract. */
export function normalizeAgent(raw: RawOfficeAgent): OfficeAgent {
  return { ...raw, id: String(raw.id) }
}

/** Coerce a raw agent list at the ingest boundary (feed `officeAgents()` here). */
export function normalizeAgents(raw: readonly RawOfficeAgent[]): OfficeAgent[] {
  return raw.map(normalizeAgent)
}

/** One office folded from the flat agent list, with a per-office online summary. */
export interface OfficeGroup {
  slug: string
  name: string
  agents: OfficeAgent[]
  onlineCount: number
}

/** A live conversation message (`officeMessages().messages`). */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'a2a' | 'system'
  author?: string
  text: string
  kind?: string
  at?: string | number
}

/** Per-character segment-tick state for the OfficeCard rail. */
export type TickState = 'live' | 'needs-you' | 'idle'

/** Amber when a character's status text reads like it's waiting on a human.
 *  OfficeAgent has no explicit needs-you flag, so we heuristically parse `status`.
 *  TODO(redesign): expose a real attention flag on OfficeAgent for a truthful tick. */
export function tickFor(a: OfficeAgent): TickState {
  if (!a.online) return 'idle'
  if (a.status && /ask|wait|need|block|approv/i.test(a.status)) return 'needs-you'
  return 'live'
}

/** True when an error means the office session is dead and re-login is required. */
export function isAuthError(msg: string): boolean {
  return /expired|reconnect|not connected|unauthenticated|\b401\b|\b419\b/i.test(msg)
}

/** Map an office agent's provider to the interactive CLI to launch for Operate.
 *  Mirrors the main-process providerCommand (see PixelOfficeView) so a single
 *  Operate uses the SAME command as a full office spawn. */
export function providerToCommand(provider?: string): string {
  const p = String(provider ?? '').toLowerCase()
  const GROK = 'grok --always-approve'
  const exact: Record<string, string> = {
    'grok-tui': GROK,
    'claude-cli': 'claude',
    'opencode-cli': 'opencode',
    'copilot-cli': 'copilot'
  }
  if (exact[p]) return exact[p]
  if (p.startsWith('grok')) return GROK
  if (p.startsWith('opencode')) return 'opencode'
  if (p.startsWith('copilot')) return 'copilot'
  return 'claude'
}

/** Provider override options offered per character (value → the loop's `-p`). */
export const PROVIDER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Default' },
  { value: 'claude', label: 'Claude' },
  { value: 'grok', label: 'Grok' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'copilot', label: 'Copilot' }
]

/** Two-letter avatar initials from a character name (defensive: name may be null/undefined). */
export function initials(name?: string): string {
  const n = String(name ?? '').trim()
  const parts = n.split(/[\s_-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return n.slice(0, 2).toUpperCase() || '??'
}

/** The colored-author palette for the office room (roles reserved for people, not state). */
const AUTHOR_COLORS = ['var(--role-violet)', 'var(--accent-ink)', 'var(--role-peach)', 'var(--role-violet-2)']

/** Stable per-author color. `you`/user is always the violet-2 "your name" tint. */
export function authorColor(author: string | undefined, role: ChatMessage['role']): string {
  if (role === 'user' || /^you\b/i.test(author ?? '')) return 'var(--role-violet-2)'
  const key = author ?? role
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length]
}

/** Format a message timestamp to HH:MM (defensive across ISO / epoch-ms / undefined). */
export function hhmm(at?: string | number): string {
  if (at == null) return ''
  const d = new Date(typeof at === 'number' ? at : at)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
