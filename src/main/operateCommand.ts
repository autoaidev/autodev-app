/**
 * operateCommand — the pure builder for an Operate pane's raw-TUI launch command.
 *
 * Extracted from PixelOffice so the grok resume decision is unit-testable without
 * electron/fs (pixelOffice.ts imports `electron` at module top, so it can't be
 * imported from a node:test). The session-PRESENCE lookup (does a resumable grok
 * transcript exist for this dir?) stays in PixelOffice; this module decides the
 * command GIVEN that boolean.
 *
 * Why grok resumes via `--continue` and NOT `--resume <id>` (the bug this fixes):
 * the app's "Connect & operate" pane re-launches grok per turn. The old command
 * `grok --resume <id> --always-approve` passed an id WE computed (newest session
 * by mtime under the URL-encoded cwd). That id is fragile: grok keys sessions by
 * its OWN encoding of the process cwd, so a stale id or a cwd-encoding/realpath
 * mismatch makes `grok --resume <id>` error on launch and FALL BACK TO A FRESH,
 * STATELESS session. The operate character then opens a blank chat that holds only
 * the system prompt + skill-list reminders — no prior context, no task — so grok
 * sits idle at an empty prompt forever (the observed post-turn-1 stall). grok's
 * own `-c, --continue` ("continue the most recent session for the current working
 * directory") lets grok resolve the newest session for the REAL cwd itself, which
 * is immune to our id-tracking drift. This mirrors the autodev-cli grok provider,
 * which abandoned per-turn `--resume <id>` for `--continue` for exactly this reason
 * (see autodev-cli src/providers/grok/tui.ts `grokSessionArgsFor`).
 *
 *   grok    → `grok --continue --always-approve` when a non-empty prior session
 *             exists for this scratch dir, else bare `grok --always-approve`.
 *   claude  → `claude --continue` (resumes the most-recent session in this cwd, no
 *             picker; harmless when there is none — it just starts fresh).
 *   opencode/copilot → bare (no clean, non-interactive continue flag).
 *
 * `hasResumableGrokSession` is only consulted for grok; other providers ignore it.
 */
export function buildOperateCommand(provider: string, hasResumableGrokSession: boolean): string {
  const p = String(provider ?? '').toLowerCase()
  if (p.startsWith('grok')) {
    return hasResumableGrokSession ? 'grok --continue --always-approve' : 'grok --always-approve'
  }
  if (p.startsWith('claude') || p === '') return 'claude --continue'
  if (p.startsWith('opencode')) return 'opencode'
  if (p.startsWith('copilot')) return 'copilot'
  return 'claude --continue'
}
