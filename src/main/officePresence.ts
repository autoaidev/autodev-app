/**
 * officePresence — the pure, electron-free verdict for "is this office character
 * connected right now?", extracted from PixelOffice so it is unit-testable without
 * importing `electron` (pixelOffice.ts imports electron at module top, so it can't
 * be loaded from a node:test — same reason operateCommand.ts was split out).
 *
 * THE BUG THIS FIXES (operate-mode agents show OFFLINE / "connecting…"):
 * pixel-office exposes THREE presence signals per character in Agent::toApiArray —
 *   • `isConnected`  — the raw WebSocket flag. A LOOP/spawn agent (and the
 *                      `autodev mcp-operate` bridge) attaches a socket, so this is
 *                      true for them.
 *   • `mcpConnected` — true when `last_mcp_seen_at` is fresh (the agent polled the
 *                      office-MCP recently). A character driven purely over MCP has
 *                      NO WebSocket, so `isConnected` stays false while this is true.
 *   • `presence`     — the server's reconciled single value ('ws' > 'mcp' >
 *                      'offline'), which it tells clients to trust instead of
 *                      combining the two booleans themselves. It also guards against
 *                      a zombie `isConnected=true` after an unclean drop / WS restart
 *                      (reconciled against ping freshness).
 *
 * The app's "Connect & operate" flow launches a provider TUI (e.g. grok) in a PTY
 * whose ONLY office link is the office-MCP server in its `.mcp.json`. It connects
 * purely over MCP (it loops on `wait_for_events` / `get_tasks`), so the server sets
 * `presence:'mcp'` + `mcpConnected:true` but leaves `isConnected:false`. The old
 * app verdict `!!(isConnected ?? online)` therefore read such a genuinely-working
 * operate agent as OFFLINE — which cascaded into every office surface:
 *   - CharacterCard StatusPill showed OFFLINE (never LIVE/WORKING), and the card
 *     never surfaced its working line / latest event (both gated on `online`).
 *   - OfficeView `onlineAgentIds` excluded it, so the Operate console tab badge
 *     stuck on "◐ connecting…" instead of "● operating (MCP)".
 *   - `characterWorking()` / `tickFor()` short-circuit to idle when `!online`.
 * The pixel-office WEB UI reads `presence`, so it showed the same agent live — the
 * desktop app was the only surface blind to MCP-only presence.
 *
 * The fix: trust the server's reconciled `presence` first ('ws' OR 'mcp' == present),
 * then fall back to the legacy booleans so an OLDER office server (which doesn't send
 * `presence`/`mcpConnected`) still works exactly as before. Provider-agnostic — it
 * keys off the connection TRANSPORT (WS vs MCP), never the provider — and it cannot
 * regress a local-loop / WS agent, whose `isConnected`/`presence:'ws'` already make
 * this return true.
 */

/** The presence-bearing subset of a raw `/api/offices/{slug}/agents` row. All
 *  optional — an older server omits `presence`/`mcpConnected`, a hand-rolled test
 *  row may carry only `online`. */
export interface RawAgentPresence {
  /** Reconciled server verdict: 'ws' > 'mcp' > 'offline'. Authoritative when present. */
  presence?: unknown
  /** Raw WebSocket flag (true for loop/spawn + the mcp-operate bridge). */
  isConnected?: unknown
  /** Fresh office-MCP poll within the server's TTL (a pure-MCP operate agent). */
  mcpConnected?: unknown
  /** Legacy single flag some older payloads used instead of `isConnected`. */
  online?: unknown
}

/**
 * Is this office character connected right now (over EITHER a WebSocket or MCP)?
 *
 * Order matters: the reconciled `presence` string wins when the server sends it (it
 * already folds `isConnected` + `mcpConnected` and discounts a stale WS flag); only
 * when it's absent do we OR the legacy booleans, so this is a strict superset of the
 * old `!!(isConnected ?? online)` behavior — it can only turn MORE agents online
 * (the MCP-only ones), never fewer.
 */
export function isOfficeAgentPresent(a: RawAgentPresence | null | undefined): boolean {
  if (!a) return false
  const presence = typeof a.presence === 'string' ? a.presence.toLowerCase() : ''
  if (presence) return presence === 'ws' || presence === 'mcp'
  // Older server without a reconciled `presence`: honor WS, MCP, and the legacy flag.
  return !!(a.isConnected || a.mcpConnected || a.online)
}
