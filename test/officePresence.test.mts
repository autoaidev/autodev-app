// officePresence — the pure "is this office character connected?" verdict.
//
// The bug: the app collapsed office presence to the raw WebSocket flag
// (`!!(isConnected ?? online)`). A "Connect & operate" TUI links to its office
// ONLY through the office-MCP server in its .mcp.json and connects purely over MCP
// (it loops on wait_for_events), so pixel-office reports presence:'mcp' +
// mcpConnected:true but isConnected:false — and the old test read that genuinely-
// working agent as OFFLINE. That cascaded into a stuck "connecting…"/OFFLINE badge,
// a never-"working" card, and an Operate console tab that never flipped to
// "operating (MCP)". The fix trusts the server's reconciled `presence` first, then
// falls back to the legacy booleans so an older server still behaves exactly as before.
//
// Locks: (1) presence:'mcp' is ONLINE (the operate-agent case — the regression),
// (2) presence:'ws' is ONLINE (loop/spawn/bridge), (3) presence:'offline' is OFFLINE
// even if a zombie isConnected lingers (the reconciled value wins), (4) no `presence`
// field → fall back to isConnected OR mcpConnected OR online (older server), (5) the
// fix is a strict SUPERSET of the old behavior (never turns a previously-online agent
// offline), (6) null/empty rows are offline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isOfficeAgentPresent } from '../src/main/officePresence.ts'

test('presence:"mcp" is online — the operate-mode agent the old test missed', () => {
  // The exact shape pixel-office sends for a pure office-MCP operate character.
  assert.equal(isOfficeAgentPresent({ presence: 'mcp', isConnected: false, mcpConnected: true }), true)
})

test('presence:"ws" is online — loop / spawn / mcp-operate bridge', () => {
  assert.equal(isOfficeAgentPresent({ presence: 'ws', isConnected: true, mcpConnected: false }), true)
})

test('presence:"offline" is offline even with a lingering isConnected flag', () => {
  // The reconciled server value wins: a zombie is_connected (unclean drop / WS
  // restart before the pruner runs) must NOT report a phantom live agent.
  assert.equal(isOfficeAgentPresent({ presence: 'offline', isConnected: true }), false)
})

test('case-insensitive presence string', () => {
  assert.equal(isOfficeAgentPresent({ presence: 'MCP' }), true)
  assert.equal(isOfficeAgentPresent({ presence: 'WS' }), true)
  assert.equal(isOfficeAgentPresent({ presence: 'Offline' }), false)
})

test('no presence field → fall back to the legacy booleans (older office server)', () => {
  // WS flag only (the pre-fix behavior, preserved).
  assert.equal(isOfficeAgentPresent({ isConnected: true }), true)
  // MCP-only, no reconciled presence — still online now (was the bug).
  assert.equal(isOfficeAgentPresent({ mcpConnected: true }), true)
  // Legacy single `online` flag.
  assert.equal(isOfficeAgentPresent({ online: true }), true)
  // Nothing set → offline.
  assert.equal(isOfficeAgentPresent({ isConnected: false, mcpConnected: false }), false)
  assert.equal(isOfficeAgentPresent({}), false)
})

test('strict superset of the old !!(isConnected ?? online) verdict', () => {
  // For every legacy row the old test called online, the new one must agree; the new
  // one may ALSO turn on MCP-only rows the old one missed — but never the reverse.
  for (const isConnected of [true, false, undefined]) {
    for (const online of [true, false, undefined]) {
      const legacy = !!(isConnected ?? online)
      const now = isOfficeAgentPresent({ isConnected, online })
      if (legacy) assert.equal(now, true, `regressed online row: isConnected=${isConnected} online=${online}`)
    }
  }
})

test('null / undefined row is offline (never throws)', () => {
  assert.equal(isOfficeAgentPresent(null), false)
  assert.equal(isOfficeAgentPresent(undefined), false)
})
