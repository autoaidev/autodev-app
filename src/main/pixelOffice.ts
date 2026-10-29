import { app, safeStorage } from 'electron'
import { join, resolve, sep } from 'path'
import { homedir } from 'os'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, chmodSync, unlinkSync, renameSync, rmSync, readdirSync, statSync, realpathSync } from 'fs'
import { Jar } from './cookieJar'
import { resolveCliJs, nodeRunner } from './cli'
import { resolveBinOnPath } from './spawnEnv'
import { isValidSessionId, safeSeg, safeMcpUrl, safeWsUrl, isSecureBaseUrl } from './officeSanitize'
import { humanizeFetchError } from './netError'
// NOTE: appSettings imports DEFAULT_OFFICE_BASE from this module; the dependency
// is only ever used inside function bodies (never at module top level) on both
// sides, so the cycle resolves before either is called.
import { getOfficeBaseUrl, getCozempicAutoInit, getResetSessionEveryNTurns } from './appSettings'
import { markGrokFolderTrusted } from './grokTrust'
import { removeCozempicHooks } from './cozempicClean'
import { buildOperateCommand } from './operateCommand'
import { isOfficeAgentPresent } from './officePresence'

/** Concise main-process tracing for the pixel-office flow. Always on (low
 *  volume) so the "can't see my agents" path is diagnosable from app logs. */
function dbg(...a: unknown[]): void {
  console.log('[pixel-office]', ...a)
}

/** A distinct marker so callers/renderer can tell a dead network from an HTTP
 *  4xx/5xx or an auth failure. */
const TIMEOUT_MSG = 'Network timeout — check your connection'

/**
 * fetch with a hard timeout (Node/undici's default body timeout is ~300s, so a
 * connected-then-stalled request would otherwise hang ~5 min and leave the UI on
 * a spinner that never resolves). Aborts after `ms` and maps the abort to a
 * distinct, user-legible message.
 */
async function fetchT(url: string, init: RequestInit = {}, ms = 12_000): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new Error(TIMEOUT_MSG)
    throw humanizeFetchError(e, url)
  } finally {
    clearTimeout(t)
  }
}

/** As fetchT, but retries an idempotent GET with exponential backoff on network
 *  failure/timeout (never on an HTTP status — a 4xx/5xx is a real answer). */
async function fetchRetry(url: string, init: RequestInit = {}, ms = 12_000, tries = 3): Promise<Response> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try { return await fetchT(url, init, ms) } catch (e) {
      last = e
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 300 * 2 ** i))
    }
  }
  throw last
}

/**
 * Connects to a remote pixel-office (Laravel, session auth) so the app can list
 * the user's office agents and OPERATE any of them: it fetches the agent's
 * office-MCP credentials and drops a `.mcp.json` into a scratch workspace, so a
 * spawned `claude` session drives that character live (via the mcp-operate
 * bridge).
 *
 * Auth: the login flow yields durable cookies — pixel-office logs in with
 * `Auth::attempt(…, remember: true)`, so the response carries a long-lived
 * `remember_web` token cookie. We persist the cookie jar (the "remote token")
 * rather than the password, and re-verify it on launch via /api/auth/me. When
 * it's expired the user just logs in again.
 */

export interface OfficeAgent {
  office: string; officeSlug: string; id: string; name: string; slug: string; status?: string; online: boolean
  /** Agent's configured provider family or -cli/-tui/-sdk variant (Agent::toApiArray 'provider'). */
  provider?: string
  /** Friendly model label if the office knows one yet (Agent::toApiArray 'model'). */
  model?: string
  /** The pixel-art sprite index (0..6) this character is drawn with in the office
   *  (Agent::toApiArray 'avatarIndex'). Maps to /assets/characters/char_<idx>.png. */
  avatarIndex?: number
  /** The character's chosen identity color (Agent::toApiArray 'color'), e.g. '#00d4ff'. */
  color?: string
  /** The character's chosen emoji face (Agent::toApiArray 'emoji'). */
  emoji?: string
  /** A ready-to-render `data:image/png;base64,…` of this character's pixel-art
   *  sprite sheet, fetched + cached main-side (the renderer CSP forbids remote
   *  images, so we inline it). Undefined when the sprite couldn't be fetched. */
  avatarUrl?: string
}

/** One row of an agent's in-office conversation, normalized from the office
 *  message feed AND the agent's narration hook events into a single chat shape. */
export interface OfficeMessage {
  id: string
  /** Who the bubble is attributed to (drives left/right + accent). */
  role: 'user' | 'assistant' | 'a2a' | 'system'
  /** Small caption above the bubble ('You', the agent name, '⚡ Steer', …). */
  author: string
  text: string
  /** The source message type / hook eventType, for finer styling. */
  kind: string
  /** Epoch ms — the feed is sorted ascending (newest at the bottom). */
  at: number
}
/** One compact row of an office character's SERVER-SIDE hook_events stream — the
 *  authoritative activity feed the pixel-office web "Events" tab renders (tool
 *  calls, narration, status, task start/complete). Read-only; newest-first. */
export interface OfficeEvent {
  id: string
  /** Epoch ms (parsed from the row's ISO `createdAt`). */
  at: number
  /** The normalized event name, e.g. 'tool_start' | 'tool_end' | 'notification'
   *  | 'agent_message' | 'task_start' | 'task_complete'. */
  evt: string
  /** The tool this event is about, when any (e.g. 'Bash', 'Edit'). */
  tool?: string
  /** A short human summary line — prose message when present, else a tool/status label. */
  text: string
  /** Tool-call input/args, when the row carries them (for the expandable detail). */
  toolInput?: unknown
  /** Tool-call output/result, when the row carries it (for the expandable detail). */
  toolOutput?: unknown
  /** The full raw hook row (already secret-redacted server-side) for the raw-JSON
   *  toggle in the expandable event detail. */
  raw?: Record<string, unknown>
}

/**
 * Pull the expandable DETAIL (tool args/input, tool output, and the full raw hook
 * row) out of a `/api/hooks/events` row, so the events panel can reveal a tool
 * call's specifics + raw JSON on click. Server field names vary by provider/hook
 * version, so we probe the common aliases. The feed is already secret-redacted on
 * ingest (pixel-office SecretRedactor + CLI redaction), so the raw row is safe to
 * surface.
 */
function hookRowDetail(ev: any): { toolInput?: unknown; toolOutput?: unknown; raw: Record<string, unknown> } {
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      const v = ev?.[k]
      if (v !== undefined && v !== null && v !== '') return v
    }
    return undefined
  }
  return {
    toolInput: pick('toolInput', 'tool_input', 'input', 'args', 'arguments', 'params', 'parameters'),
    toolOutput: pick('toolResponse', 'tool_response', 'toolOutput', 'tool_output', 'output', 'result', 'response'),
    raw: ev && typeof ev === 'object' ? (ev as Record<string, unknown>) : {}
  }
}

/** One usage/limit window for a provider credential, flattened from the
 *  deployer's cached `meta.usage.windows` (see KeyUsage). The renderer draws each
 *  as a progress bar. */
export interface KeyUsageLimit {
  /** Human window label, e.g. 'Session (5h)', 'Weekly', 'Credit'. */
  label: string
  /** Amount consumed (openrouter dollars); absent for %-only Claude windows. */
  used?: number
  /** The window's cap; absent when the provider reports only a percentage / is unlimited. */
  limit?: number
  /** ISO8601 when this window resets, when the provider reports one. */
  resetAt?: string | null
  /** 0-100 utilization the deployer already computed (higher = closer to the cap). */
  pct?: number
  /** Bar severity hint from the deployer ('normal'|'warning'|'critical'). */
  severity?: string
}

/** Per-account provider key usage, normalized from the connected pixel-office's
 *  deployer credential vault. One entry per credential that exposes a reading. */
export interface KeyUsage {
  /** Provider family ('claude'|'openrouter'|'copilot'|…). */
  provider: string
  /** The credential's display label from the vault. */
  label?: string
  /** The raw secret kind ('claude_token'|'openrouter'|…). */
  kind?: string
  /** One row per usage/limit window. */
  limits: KeyUsageLimit[]
  /** ISO8601 credential expiry (secret.valid_until), when known. */
  expiresAt?: string | null
  /** A soft error the deployer attached ('reauth_required'|'rate_limited'); UI degrades. */
  error?: string | null
  /** True when the provider reports no spend cap (openrouter unlimited key). */
  unlimited?: boolean
}

interface Persisted { baseUrl: string; email: string; cookies: [string, string][] }

export const DEFAULT_OFFICE_BASE = 'https://app.pixeloffice.org'

/**
 * Build the `.mcp.json` "pixel-office" stdio server entry. Prefer the CLI that
 * ships WITH the app (resolveCliJs → bundled/pinned vendor copy) run under the
 * same node the app uses for the agent loop, so a spawned `claude` session does
 * NOT fetch-and-run the latest `autodev-cli` from the public npm registry at
 * spawn time (supply-chain + offline + flaky-network hazard). Falls back to
 * `npx` only when no bundled CLI is found (strictly no worse than before).
 */
function officeMcpServer(key: string, url: string, fileBrowser = false): Record<string, unknown> {
  // The mcp-operate bridge exposes the Files/file-browser capability when passed
  // `--file-browser` (same flag the Create/Connect flows use), so every agent
  // wired with fileBrowser on gets the office's file-browser panel.
  const fb = fileBrowser ? ['--file-browser'] : []
  const cli = resolveCliJs()
  if (cli) {
    const { cmd, baseEnv } = nodeRunner()
    const env: Record<string, string> = { NODE_NO_WARNINGS: '1' }
    // When the app falls back to Electron's own node, the child must be told to
    // run as node (matches AgentManager.start()'s proven prod behaviour).
    if (baseEnv.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = '1'
    return { type: 'stdio', command: cmd, args: [cli, 'mcp-operate', '--key', key, '--url', url, ...fb], env }
  }
  return { type: 'stdio', command: 'npx', args: ['-y', 'autodev-cli', 'mcp-operate', '--key', key, '--url', url, ...fb] }
}

/** Normalize an office provider to a VALID `autodev start -p <id>` provider id.
 *  The pixel-office stores the FAMILY name ("grok" / "claude"), but the CLI only
 *  accepts the full id ("grok-tui" / "claude-cli") — passing the bare family gives
 *  `Unknown provider "grok"` and the loop exits code=1 immediately. This is what
 *  every spawned loop hit. Maps family → the -tui/-cli id; passes a full id through. */
function toAutodevProvider(provider?: string): string {
  const p = String(provider ?? '').toLowerCase()
  const VALID = new Set(['claude-cli', 'claude-tui', 'copilot-cli', 'copilot-sdk', 'opencode-cli', 'opencode-sdk', 'grok-cli', 'grok-tui', 'grok-acp'])
  if (VALID.has(p)) return p
  // Only a BARE/unknown grok family falls back to grok-tui. An explicit variant
  // (grok-cli / grok-acp) is a VALID id handled above and must NOT be coerced —
  // coercing grok-acp here would silently downgrade the persistent ACP session.
  if (p.startsWith('grok')) return 'grok-tui'
  if (p.startsWith('claude')) return 'claude-cli'
  if (p.startsWith('opencode')) return 'opencode-cli'
  if (p.startsWith('copilot')) return 'copilot-cli'
  return 'claude-cli'
}

/**
 * A friendly provider name + install hint for the missing-CLI pre-check, keyed by
 * the interactive binary the Operate pane launches. Lets a missing provider read as
 * "Grok CLI not found on PATH — install it…" instead of a cryptic spawn error.
 */
const PROVIDER_BIN_INFO: Record<string, { label: string; install: string }> = {
  grok: { label: 'Grok CLI', install: 'install grok and make sure it is on your PATH' },
  claude: { label: 'Claude Code CLI', install: 'install `claude` (npm i -g @anthropic-ai/claude-code) and sign in' },
  opencode: { label: 'OpenCode CLI', install: 'install `opencode` and make sure it is on your PATH' },
  copilot: { label: 'GitHub Copilot CLI', install: 'install `copilot` and make sure it is on your PATH' }
}

/** Map an office agent's provider (family name OR a -cli/-tui/-sdk variant) to
 *  the interactive CLI command to launch in its wired scratch cwd. Exact variants
 *  first, then family-prefix fallbacks; default 'claude'. */
function providerCommand(provider?: string): string {
  const p = String(provider ?? '').toLowerCase()
  const exact: Record<string, string> = {
    'grok-tui': 'grok --always-approve',
    'claude-cli': 'claude',
    'opencode-cli': 'opencode',
    'copilot-cli': 'copilot'
  }
  if (exact[p]) return exact[p]
  if (p.startsWith('grok')) return 'grok --always-approve'
  if (p.startsWith('opencode')) return 'opencode'
  if (p.startsWith('copilot')) return 'copilot'
  if (p.startsWith('claude')) return 'claude'
  return 'claude' // default
}

/**
 * The 4 non-disableable core built-in MCP servers, mirroring the CLI's
 * `DEFAULT_MCP_SERVERS` (autodev-cli src/mcpManager.ts) exactly. grok reads
 * `.mcp.json` DIRECTLY (not the `.grok/config.toml` the loop fans servers into),
 * so an office scratch dir that carries only `pixel-office` leaves grok without
 * memory / sequential-thinking / playwright / computer-use — the reported bug.
 * Seeding them here gives grok all four immediately.
 */
const BUILTIN_MCP_SERVERS: Record<string, { command: string; args: string[] }> = {
  memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  'sequential-thinking': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  'computer-use-mcp': { command: 'npx', args: ['-y', 'computer-use-mcp'] }
}

/** One built-in `.mcp.json` entry in the CLI's exact shape (command/args +
 *  alwaysLoad + `_meta.kind:'builtin'`) so an app write and a CLI sync don't
 *  fight — matches replaceProjectBuiltinMcp's output in autodev-cli. */
function builtinMcpEntry(name: string, spec: { command: string; args: string[] }): Record<string, unknown> {
  return { command: spec.command, args: spec.args, alwaysLoad: true, _meta: { managedBy: 'autoaidev', name, kind: 'builtin' } }
}

/** Add every core built-in that isn't already present to a `.mcp.json` mcpServers
 *  map. Add-only (idempotent): never clobbers a builtin the user/loop customized. */
function seedBuiltinMcp(mcpServers: Record<string, any>): void {
  for (const [name, spec] of Object.entries(BUILTIN_MCP_SERVERS)) {
    if (!mcpServers[name]) mcpServers[name] = builtinMcpEntry(name, spec)
  }
}

/**
 * Write the office scratch dir's `.mcp.json` owner-only (0600) — it carries a live
 * office API key. MERGE, not overwrite: refresh the `pixel-office` operate server
 * AND seed the 4 core built-ins (memory/playwright/sequential-thinking/computer-use)
 * so grok has them immediately, while preserving any servers already in the file.
 * Idempotent — re-running operate never dupes and keeps user-added entries.
 */
function writeMcpJson(dir: string, key: string, url: string): void {
  const file = join(dir, '.mcp.json')
  let root: Record<string, any> = {}
  try { const p = JSON.parse(readFileSync(file, 'utf8')); if (p && typeof p === 'object') root = p } catch { /* none/invalid → start fresh */ }
  if (!root.mcpServers || typeof root.mcpServers !== 'object') root.mcpServers = {}
  root.mcpServers['pixel-office'] = officeMcpServer(key, url)
  seedBuiltinMcp(root.mcpServers)
  writeFileSync(file, JSON.stringify(root, null, 2), { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* best effort */ }
}

/**
 * Merge the `pixel-office` server into an EXISTING `<dir>/.mcp.json` without
 * discarding any servers the user already configured. Used for connectSession,
 * which wires the user's REAL project cwd (not an app-owned scratch dir) — a
 * blind overwrite there would clobber the user's own MCP config. Kept 0600 since
 * the merged file still carries the live office API key.
 */
function mergeMcpJson(dir: string, key: string, url: string, server = 'pixel-office', fileBrowser = false): void {
  const file = join(dir, '.mcp.json')
  let root: Record<string, any> = {}
  try { const p = JSON.parse(readFileSync(file, 'utf8')); if (p && typeof p === 'object') root = p } catch { /* none/invalid → start fresh */ }
  if (!root.mcpServers || typeof root.mcpServers !== 'object') root.mcpServers = {}
  root.mcpServers[server] = officeMcpServer(key, url, fileBrowser)
  writeFileSync(file, JSON.stringify(root, null, 2), { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* best effort */ }
}

/**
 * Ensure each entry is present in `<dir>/.gitignore` so app-written secrets/config
 * (the office-key-bearing `.mcp.json`, the local trust settings) can't be
 * accidentally git-committed from the user's real repo. Best-effort, append-only.
 */
function ensureGitignored(dir: string, entries: string[]): void {
  try {
    const gi = join(dir, '.gitignore')
    let cur = ''
    try { cur = readFileSync(gi, 'utf8') } catch { /* none yet */ }
    const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()))
    const add = entries.filter((e) => !have.has(e))
    if (!add.length) return
    appendFileSync(gi, (cur && !cur.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n')
  } catch { /* best effort */ }
}

/**
 * Pre-approve the project-scoped `.mcp.json` so the spawned `claude` doesn't sit
 * on the in-TUI "untrusted MCP server — approve?" prompt (project servers are
 * Pending until approved). Without this the office-MCP server never starts and
 * the character never comes online. `enableAllProjectMcpServers` is scoped to
 * this scratch cwd's local settings, so it can't affect the user's real projects.
 */
function writeMcpTrust(dir: string): void {
  try {
    const cdir = join(dir, '.claude')
    mkdirSync(cdir, { recursive: true, mode: 0o700 })
    writeFileSync(join(cdir, 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }, null, 2), { mode: 0o600 })
  } catch { /* best effort — falls back to the manual trust prompt */ }
}

/**
 * Pre-approve ONLY the named project MCP server (default `pixel-office`) in
 * `<dir>/.claude/settings.local.json`, merging into any existing local settings.
 * Unlike `writeMcpTrust`'s blanket `enableAllProjectMcpServers`, this scoped
 * allow-list does NOT auto-trust every other project-scoped `.mcp.json` server —
 * critical when wiring a user's REAL repo (connectSession), where a hostile
 * pre-existing MCP server would otherwise execute unprompted on `claude --resume`.
 */
/**
 * Pre-accept Claude Code's per-folder trust prompt for an APP-OWNED scratch cwd
 * by seeding `projects[cwd].hasTrustDialogAccepted=true` in `~/.claude.json`.
 * Without it, the first `claude` launch in a freshly-created operate dir blocks on
 * the full-screen "Do you trust the files in this folder?" dialog — so the first
 * Operate per agent hangs while the UI already claims the character is
 * MCP-connected. `hasTrustDialogAccepted` is Claude Code's real per-project key.
 *
 * Only ever call this for dirs WE created under ~/.autodev-app/offices. Fails
 * safe: if an existing ~/.claude.json can't be parsed we ABORT rather than risk
 * overwriting the user's real global config, and the write is atomic (tmp+rename)
 * so a concurrent `claude` never observes a partial file.
 */
function markFolderTrusted(cwd: string): void {
  const file = join(homedir(), '.claude.json')
  // The atomic tmp+rename below prevents a torn READ, but not a lost UPDATE: this
  // shared global file (Claude Code's OAuth tokens, every project's trust flag,
  // history) is rewritten frequently by other claude processes, and a blind rename
  // of our read-plus-one-key snapshot would silently clobber any change written
  // between our read and the rename. Guard with a compare-and-swap: re-read the
  // file immediately before publishing and, if it changed under us, discard our
  // stale snapshot and retry from a fresh read (bounded). markFolderTrusted is
  // fully synchronous, so the app's own concurrent operate() calls can't interleave
  // here — only cross-process writers race us, and the CAS catches them.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      let raw: string | null = null
      if (existsSync(file)) {
        try { raw = readFileSync(file, 'utf8') } catch { return /* unreadable — don't risk clobbering */ }
      }
      let root: Record<string, any>
      if (raw != null) {
        try { root = JSON.parse(raw) } catch { return /* don't clobber a real-but-unparseable config */ }
        if (!root || typeof root !== 'object') return
      } else {
        root = {}
      }
      if (!root.projects || typeof root.projects !== 'object') root.projects = {}
      const cur = (root.projects[cwd] && typeof root.projects[cwd] === 'object') ? root.projects[cwd] : {}
      if (cur.hasTrustDialogAccepted === true) return // already trusted — leave the global file untouched
      cur.hasTrustDialogAccepted = true
      root.projects[cwd] = cur
      const tmp = `${file}.autodev-${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(root, null, 2))
      // CAS check: if the on-disk file no longer matches what we read, another
      // process wrote it — our snapshot is stale, so drop the temp and retry.
      let now: string | null = null
      if (existsSync(file)) { try { now = readFileSync(file, 'utf8') } catch { now = null } }
      if (now !== raw) { try { unlinkSync(tmp) } catch { /* */ }; continue }
      renameSync(tmp, file)
      return
    } catch { return /* best effort — falls back to the manual trust prompt */ }
  }
  // Persistently contended: give up rather than risk a clobber; the first `claude`
  // launch simply shows the folder-trust prompt once.
}

// markGrokFolderTrusted lives in ./grokTrust (electron-free, unit-tested). It
// TOML-escapes the double-quoted `[folders."<path>"]` key — critical on Windows,
// where a raw `C:\Users\…` path would inject invalid TOML escapes (\U,\u,\a,…)
// and make grok's whole trust store unparseable — and repairs a store already
// corrupted by the old raw-path write.

function writeScopedMcpTrust(dir: string, server = 'pixel-office'): void {
  try {
    const cdir = join(dir, '.claude')
    mkdirSync(cdir, { recursive: true, mode: 0o700 })
    const file = join(cdir, 'settings.local.json')
    let s: Record<string, any> = {}
    try { const p = JSON.parse(readFileSync(file, 'utf8')); if (p && typeof p === 'object') s = p } catch { /* none/invalid */ }
    const cur: string[] = Array.isArray(s.enabledMcpjsonServers) ? s.enabledMcpjsonServers : []
    if (!cur.includes(server)) cur.push(server)
    s.enabledMcpjsonServers = cur
    writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 })
    try { chmodSync(file, 0o600) } catch { /* best effort */ }
  } catch { /* best effort — falls back to the manual trust prompt */ }
}

export class PixelOfficeClient {
  private jar = new Jar()
  private base = ''
  private _authed = false
  private _email = ''
  private readonly _cfg = join(app.getPath('userData'), 'pixel-office.json')
  // Every dir a live office API key was written into (operate scratch dirs AND the
  // user's REAL project cwds from connectSession). Tracked so logout() can strip
  // those keys back out — the offices scratch root rm alone never reaches a
  // connectSession dir, which lives in an arbitrary git repo.
  private readonly _manifest = join(app.getPath('userData'), 'provisioned.json')

  private recordProvisioned(dir: string): void {
    try {
      let list: string[] = []
      try { const p = JSON.parse(readFileSync(this._manifest, 'utf8')); if (Array.isArray(p)) list = p.filter((x) => typeof x === 'string') } catch { /* none/invalid */ }
      if (!list.includes(dir)) {
        list.push(dir)
        writeFileSync(this._manifest, JSON.stringify(list, null, 2), { mode: 0o600 })
        try { chmodSync(this._manifest, 0o600) } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
  }

  /**
   * Strip ONLY the `pixel-office` MCP server (and its scoped trust) that we wrote
   * into `dir` — leaving any servers/settings the user configured themselves
   * untouched. Removes the still-valid office API key that mergeMcpJson/writeMcpJson
   * left in `dir/.mcp.json`.
   */
  private deprovisionDir(dir: string): void {
    try {
      const mcp = join(dir, '.mcp.json')
      if (existsSync(mcp)) {
        let root: Record<string, any> | null = {}
        try { const p = JSON.parse(readFileSync(mcp, 'utf8')); root = (p && typeof p === 'object') ? p : null } catch { root = null }
        // Strip every office server WE wrote — the single `pixel-office` from
        // operate/connectSession AND the per-agent `pixel-office-<slug>` entries the
        // single-shared-folder spawn merges in — each carries a live office API key.
        if (root && root.mcpServers && typeof root.mcpServers === 'object') {
          const ours = Object.keys(root.mcpServers).filter((k) => k === 'pixel-office' || k.startsWith('pixel-office-'))
          if (ours.length > 0) {
            for (const k of ours) delete root.mcpServers[k]
            const onlyOurs = Object.keys(root.mcpServers).length === 0 && Object.keys(root).length === 1
            if (onlyOurs) {
              // The file only ever held our key-bearing server(s) — remove it entirely.
              try { unlinkSync(mcp) } catch { /* */ }
            } else {
              writeFileSync(mcp, JSON.stringify(root, null, 2), { mode: 0o600 })
              try { chmodSync(mcp, 0o600) } catch { /* */ }
            }
          }
        }
      }
    } catch { /* best effort */ }
    try {
      const sf = join(dir, '.claude', 'settings.local.json')
      if (existsSync(sf)) {
        let s: Record<string, any> = {}
        try { const p = JSON.parse(readFileSync(sf, 'utf8')); if (p && typeof p === 'object') s = p; else return } catch { return }
        let changed = false
        if (Array.isArray(s.enabledMcpjsonServers)) {
          const kept = s.enabledMcpjsonServers.filter((x: string) => x !== 'pixel-office' && !String(x).startsWith('pixel-office-'))
          if (kept.length !== s.enabledMcpjsonServers.length) { s.enabledMcpjsonServers = kept; changed = true }
        }
        if (changed) { writeFileSync(sf, JSON.stringify(s, null, 2), { mode: 0o600 }); try { chmodSync(sf, 0o600) } catch { /* */ } }
      }
    } catch { /* best effort */ }
  }

  private loadConfig(): Persisted | null {
    try {
      if (!existsSync(this._cfg)) return null
      const raw = readFileSync(this._cfg, 'utf8')
      const obj = JSON.parse(raw) as Persisted & { enc?: string }
      // Encrypted-at-rest form: decrypt the OS-keychain-sealed payload. Falls
      // through to the legacy plaintext shape for tokens saved before this.
      if (typeof obj.enc === 'string') {
        try {
          const clear = safeStorage.decryptString(Buffer.from(obj.enc, 'base64'))
          return JSON.parse(clear) as Persisted
        } catch { return null }
      }
      return obj
    } catch { /* */ }
    return null
  }
  private saveToken(): void {
    // The persisted cookie jar contains the durable `remember_web` token
    // (password-equivalent). Seal it with Electron safeStorage (OS keychain) when
    // available so a copied file is useless off-machine; keep an owner-only (0600)
    // plaintext fallback only when encryption is unavailable. writeFileSync's mode
    // applies on create only, so chmod after every write to also tighten any
    // pre-existing world-readable file.
    try {
      const payload = JSON.stringify({ baseUrl: this.base, email: this._email, cookies: this.jar.dump() })
      let toWrite: string
      try {
        if (safeStorage.isEncryptionAvailable()) {
          toWrite = JSON.stringify({ enc: safeStorage.encryptString(payload).toString('base64') })
        } else {
          toWrite = payload
        }
      } catch { toWrite = payload }
      writeFileSync(this._cfg, toWrite, { mode: 0o600 })
      try { chmodSync(this._cfg, 0o600) } catch { /* best effort */ }
    } catch { /* */ }
  }

  async login(baseUrl: string, email: string, password: string): Promise<{ ok: true; user: unknown } | { error: string }> {
    this.base = baseUrl.replace(/\/+$/, '')
    // The Server URL is free-text. Refuse to POST the password + persist the
    // durable remember_web token over plain http (harvestable by any passive/MITM
    // observer on the LAN) — require https, tolerating http only for a loopback
    // dev office. Fail BEFORE any credential leaves the machine.
    if (!isSecureBaseUrl(this.base)) {
      return { error: 'Server URL must use https:// (http is only allowed for localhost).' }
    }
    this.jar = new Jar()
    this._authed = false
    this._email = email
    try {
      const r1 = await fetchRetry(`${this.base}/api/csrf-token`, { headers: { Accept: 'application/json' } })
      this.jar.store(r1)
      const r2 = await fetchT(`${this.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': this.jar.xsrf(), Cookie: this.jar.header() },
        body: JSON.stringify({ email, password })
      })
      this.jar.store(r2)
      const j = (await r2.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: { user?: unknown } }
      if (!r2.ok || !j.success) {
        dbg('login failed', r2.status, j.error, 'cookies:', this.jar.size())
        return { error: j.error || `Login failed (${r2.status})` }
      }
      this._authed = true
      this.saveToken() // persist the durable cookie/token, not the password
      dbg('login ok', this._email, 'cookies:', this.jar.size())
      return { ok: true, user: j.data?.user }
    } catch (e) { dbg('login error', e); return { error: String((e as Error)?.message ?? e) } }
  }

  /** Reuse the stored token cookies from a previous login (called on launch). */
  async autoConnect(): Promise<boolean> {
    const c = this.loadConfig()
    if (!c?.baseUrl || !c.cookies?.length) { dbg('autoConnect: no stored token'); return false }
    // Never replay a durable token over cleartext http (a legacy/tampered config
    // could carry an insecure base) — that would leak the remember_web cookie.
    if (!isSecureBaseUrl(c.baseUrl)) { dbg('autoConnect: insecure base rejected', c.baseUrl); return false }
    this.base = c.baseUrl
    this._email = c.email
    this.jar = new Jar()
    this.jar.load(c.cookies)
    try {
      const r = await fetchRetry(`${this.base}/api/auth/me`, { headers: { Accept: 'application/json', Cookie: this.jar.header() } })
      this.jar.store(r) // capture any session/remember cookie rotated by /me
      const j = (await r.json().catch(() => ({}))) as { success?: boolean }
      this._authed = !!(r.ok && j.success)
      if (this._authed) this.saveToken() // refresh rotated cookies
      dbg('autoConnect', this._authed ? 'ok' : `failed (${r.status})`, this._email)
      return this._authed
    } catch (e) { dbg('autoConnect error', e); return false }
  }

  logout(): void {
    this._authed = false
    this.jar = new Jar()
    // Remove the token file entirely rather than leaving a stale (readable) one.
    try { if (existsSync(this._cfg)) unlinkSync(this._cfg) } catch { /* */ }
    // operate()/connectSession() write each agent's live office API key in
    // plaintext into a `.mcp.json` (it must be readable by the spawned claude).
    // operate() uses ~/.autodev-app/offices/<slug>/<agent>/, so rming that scratch
    // root purges those. But connectSession() writes into the caller's REAL project
    // cwd — an arbitrary git repo NOT under the scratch root — so the rm alone would
    // leave those still-valid keys behind on logout / account switch, harvestable by
    // any later local read. Walk the provisioned manifest and strip our office
    // server (+ scoped trust) out of every recorded dir, then drop the manifest.
    try {
      let dirs: string[] = []
      try { const p = JSON.parse(readFileSync(this._manifest, 'utf8')); if (Array.isArray(p)) dirs = p.filter((x) => typeof x === 'string') } catch { /* none */ }
      for (const d of dirs) this.deprovisionDir(d)
      try { if (existsSync(this._manifest)) unlinkSync(this._manifest) } catch { /* */ }
    } catch { /* best effort */ }
    try { rmSync(join(homedir(), '.autodev-app', 'offices'), { recursive: true, force: true }) } catch { /* best effort */ }
  }

  /**
   * Absorb any rotated cookies from a response into the jar and, if the durable
   * credential actually changed while we're authenticated, persist it to disk.
   * Laravel's `remember_web` re-auth rotates the session cookie via `Set-Cookie`
   * on ANY authenticated request — including the read-only GETs that make up the
   * 8s agents poll. Dropping that refreshed cookie (getJson previously never
   * stored it) means the next poll replays a server-invalidated session → 401 →
   * premature forced logout, long before the remember-token actually expires.
   */
  private absorbCookies(before: string, r: Response): void {
    this.jar.store(r)
    if (this._authed && this.jar.header() !== before) this.saveToken()
  }

  /**
   * Re-verify the durable `remember_web` token via /api/auth/me. Laravel re-auths
   * the remembered user and rotates a fresh session cookie, which we absorb. This
   * is the same self-heal the GET path relies on (the renderer retries via
   * officeAutoConnect on a 401); postJson calls it inline so a POST can recover
   * from a routine session-cookie rotation instead of dead-ending. Returns whether
   * we're authenticated again.
   */
  private async reauth(): Promise<boolean> {
    try {
      const before = this.jar.header()
      const r = await fetchRetry(`${this.base}/api/auth/me`, { headers: { Accept: 'application/json', Cookie: before } })
      this.jar.store(r)
      const j = (await r.json().catch(() => ({}))) as { success?: boolean }
      const ok = !!(r.ok && j.success)
      if (ok) { this._authed = true; this.saveToken() }
      return ok
    } catch { return false }
  }

  // The office draws every character from one of 7 pixel-art sprite SHEETS served
  // as public static assets (/assets/characters/char_0.png … char_6.png). The
  // renderer's CSP is `img-src 'self' data:`, so it can't load them cross-origin;
  // we fetch each sheet ONCE main-side and hand the renderer an inline data: URI it
  // CAN render. Keyed by the sprite index; a failed fetch caches nothing so a later
  // poll retries. Sheets are ~4–14KB each, 7 total — negligible + stable.
  private readonly _spriteCache = new Map<number, string>()
  private async spriteDataUrl(avatarIndex: unknown): Promise<string | undefined> {
    if (typeof avatarIndex !== 'number' || !Number.isFinite(avatarIndex)) return undefined
    const idx = ((Math.trunc(avatarIndex) % 7) + 7) % 7 // office wraps avatarIndex mod CHAR_COUNT (=7)
    const hit = this._spriteCache.get(idx)
    if (hit) return hit
    if (!this.base) return undefined
    try {
      const r = await fetchT(`${this.base}/assets/characters/char_${idx}.png`, { headers: { Accept: 'image/png' } }, 8_000)
      if (!r.ok) return undefined
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length === 0 || buf.length > 512_000) return undefined // sanity bound
      const uri = `data:image/png;base64,${buf.toString('base64')}`
      this._spriteCache.set(idx, uri)
      return uri
    } catch { return undefined }
  }

  private async getJson(path: string): Promise<any> {
    const before = this.jar.header()
    const r = await fetchRetry(`${this.base}${path}`, { headers: { Accept: 'application/json', Cookie: before } })
    if (r.status === 401) { this._authed = false; throw new Error('Session expired — reconnect.') }
    if (!r.ok) throw new Error(`${path} → ${r.status}`)
    this.absorbCookies(before, r)
    return r.json()
  }

  /** One POST attempt with the jar's current CSRF token + cookies. */
  private async doPost(path: string, body: unknown): Promise<Response> {
    const before = this.jar.header()
    const r = await fetchT(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': this.jar.xsrf(), Cookie: before },
      body: JSON.stringify(body)
    })
    this.absorbCookies(before, r)
    return r
  }

  /** One DELETE attempt with the jar's current CSRF token + cookies. */
  private async doDelete(path: string): Promise<Response> {
    const before = this.jar.header()
    const r = await fetchT(`${this.base}${path}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'X-XSRF-TOKEN': this.jar.xsrf(), Cookie: before }
    })
    this.absorbCookies(before, r)
    return r
  }

  /** One PATCH attempt with the jar's current CSRF token + cookies. */
  private async doPatch(path: string, body: unknown): Promise<Response> {
    const before = this.jar.header()
    const r = await fetchT(`${this.base}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': this.jar.xsrf(), Cookie: before },
      body: JSON.stringify(body)
    })
    this.absorbCookies(before, r)
    return r
  }

  /** PATCH mirror of postJson: same 419 (stale CSRF) + 401 (session) self-heal. */
  private async patchJson(path: string, body: unknown): Promise<any> {
    let r = await this.doPatch(path, body)
    if (r.status === 419) {
      try {
        const before = this.jar.header()
        const cr = await fetchRetry(`${this.base}/api/csrf-token`, { headers: { Accept: 'application/json', Cookie: before } })
        this.absorbCookies(before, cr)
      } catch { /* keep the original 419 below */ }
      r = await this.doPatch(path, body)
    }
    if (r.status === 401) {
      if (await this.reauth()) r = await this.doPatch(path, body)
    }
    if (r.status === 401 || r.status === 419) { this._authed = false; throw new Error('Session expired — reconnect.') }
    if (!r.ok) throw new Error(`${path} → ${r.status}`)
    return r.json().catch(() => ({}))
  }

  /** DELETE mirror of postJson: same 419 (stale CSRF) + 401 (session) self-heal. */
  private async deleteJson(path: string): Promise<any> {
    let r = await this.doDelete(path)
    if (r.status === 419) {
      try {
        const before = this.jar.header()
        const cr = await fetchRetry(`${this.base}/api/csrf-token`, { headers: { Accept: 'application/json', Cookie: before } })
        this.absorbCookies(before, cr)
      } catch { /* keep the original 419 below */ }
      r = await this.doDelete(path)
    }
    if (r.status === 401) {
      if (await this.reauth()) r = await this.doDelete(path)
    }
    if (r.status === 401 || r.status === 419) { this._authed = false; throw new Error('Session expired — reconnect.') }
    if (!r.ok) throw new Error(`${path} → ${r.status}`)
    return r.json().catch(() => ({}))
  }

  private async postJson(path: string, body: unknown): Promise<any> {
    let r = await this.doPost(path, body)
    // A Laravel 419 ("Page Expired") is a stale/mismatched XSRF token, NOT a dead
    // session. Silently GET a fresh CSRF token once and retry the POST — otherwise
    // Make-app / Connect-to-office / Generate-team dead-end on an opaque "419" with
    // no self-heal (e.g. after a durable-token re-auth rotated the session cookie).
    if (r.status === 419) {
      try {
        const before = this.jar.header()
        const cr = await fetchRetry(`${this.base}/api/csrf-token`, { headers: { Accept: 'application/json', Cookie: before } })
        this.absorbCookies(before, cr)
      } catch { /* keep the original 419 below */ }
      r = await this.doPost(path, body)
    }
    // A 401 (vs 419) is an unauthenticated session, but the durable remember_web
    // token can silently restore it. Mirror the GET path's recovery: re-auth via
    // /api/auth/me once, then retry the POST, before surfacing "Session expired" —
    // otherwise Make-app / Connect-session / Generate-team dead-end after a routine
    // session-cookie rotation that one /api/auth/me would have fixed.
    if (r.status === 401) {
      if (await this.reauth()) r = await this.doPost(path, body)
    }
    if (r.status === 401 || r.status === 419) { this._authed = false; throw new Error('Session expired — reconnect.') }
    if (!r.ok) throw new Error(`${path} → ${r.status}`)
    return r.json()
  }

  /** The user's offices (for the connect-session picker + the office-rail sort).
   *  Carries the office's recency signal (`lastActivityAt` — the max agent activity
   *  the list endpoint computes via withMax) and its counts so the rail can sort by
   *  most-recently-active without a second round-trip. */
  async offices(): Promise<
    Array<{
      slug: string
      id: number
      name: string
      lastActivityAt?: string | null
      createdAt?: string | null
      agentsCount?: number | null
      onlineAgentsCount?: number | null
    }>
  > {
    if (!this._authed) throw new Error('Not connected to a pixel-office.')
    const list = (await this.getJson('/api/offices'))?.data?.offices ?? []
    return list.map((o: any) => ({
      slug: o.slug,
      id: o.id,
      name: o.name,
      lastActivityAt: o.lastActivityAt ?? null,
      createdAt: o.createdAt ?? null,
      agentsCount: typeof o.agentsCount === 'number' ? o.agentsCount : null,
      onlineAgentsCount: typeof o.onlineAgentsCount === 'number' ? o.onlineAgentsCount : null
    }))
  }

  /**
   * Mint a fresh signed setup URL for a chosen office character — the exact same
   * temporary-signed `/api/cli/setup/<token>` URL the office UI's "Connect this
   * agent" modal shows for pasting into `autodev connect --setup-url`. Reads it
   * from the owner-only credentials endpoint (which also re-arms the single-use
   * setup guard), so the picker can feed it straight into the CLI connect path
   * without the user copy-pasting anything.
   */
  async setupUrl(officeSlug: string, agentId: string): Promise<{ ok: true; setupUrl: string } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    try {
      const data = (await this.getJson(`/api/offices/${encodeURIComponent(officeSlug)}/agents/${encodeURIComponent(agentId)}/credentials`))?.data ?? {}
      const url = data.setupUrl as string | undefined
      if (!url) return { error: 'The office did not return a setup URL for this character.' }
      return { ok: true, setupUrl: url }
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) }
    }
  }

  async listAgents(): Promise<OfficeAgent[]> {
    if (!this._authed) throw new Error('Not connected to a pixel-office.')
    const offices = (await this.getJson('/api/offices'))?.data?.offices ?? []
    dbg('listAgents: offices', offices.length)
    if (!offices.length) return []
    const out: OfficeAgent[] = []
    const errors: string[] = []
    for (const o of offices) {
      try {
        const ags = await this.getJson(`/api/offices/${o.slug}/agents`)
        // Accept {data:[...]}, {data:{agents:[...]}} or a bare array.
        const arr: any[] = Array.isArray(ags?.data) ? ags.data
          : Array.isArray(ags?.data?.agents) ? ags.data.agents
          : Array.isArray(ags?.agents) ? ags.agents
          : Array.isArray(ags) ? ags : []
        for (const a of arr) {
          const avatarIndex = typeof a.avatarIndex === 'number' ? a.avatarIndex : undefined
          out.push({
            office: o.name, officeSlug: o.slug, id: a.id, name: String(a.name ?? a.slug ?? 'Agent'), slug: a.slug,
            // Presence is online over EITHER transport: a WebSocket (loop/spawn +
            // the mcp-operate bridge) OR a pure office-MCP poll (an operate-mode TUI
            // whose only office link is its .mcp.json). The old `isConnected ?? online`
            // saw only the WS flag, so a genuinely-working operate agent (presence:
            // 'mcp', isConnected:false) read OFFLINE — the shared root cause of the
            // stuck "connecting…"/OFFLINE badge. See officePresence.ts.
            status: a.status, online: isOfficeAgentPresent(a), provider: a.provider, model: a.model,
            avatarIndex, color: a.color, emoji: a.emoji,
            // Inline the pixel-art sprite (CSP-safe data: URI) so both the office
            // cards AND office-bound local agents can render the character's real face.
            avatarUrl: await this.spriteDataUrl(avatarIndex)
          })
        }
      } catch (e) {
        // A 401 here means the session died mid-list — surface it, don't hide it.
        if ((e as Error)?.message?.includes('expired')) throw e
        errors.push(`${o.name}: ${String((e as Error)?.message ?? e)}`)
      }
    }
    dbg('listAgents: agents', out.length, errors.length ? `errors=${errors.length}` : '')
    // Never present a silent empty list when every office actually errored —
    // that misleading "No agents" state is the reported bug.
    if (!out.length && errors.length) throw new Error(`Couldn't load agents — ${errors.join('; ')}`)
    return out
  }

  /** Prepare a scratch workspace with this agent's office-MCP wired, so a PTY
   *  running `claude` there operates the character. Returns the cwd to spawn in. */
  /**
   * Create a new office character (agent row) in an office — the in-app equivalent
   * of the office UI's "+ Agent". Returns the minted id/slug so the caller can
   * immediately Operate it. Mirrors the shape connectSession already posts.
   */
  async createCharacter(
    officeId: number,
    name: string,
    opts?: { avatarIndex?: number; color?: string; emoji?: string }
  ): Promise<{ ok: true; id: string; slug: string; name: string } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    const nm = String(name ?? '').replace(/[^\w .-]+/g, '').trim().slice(0, 20)
    if (!nm) return { error: 'Give the character a name.' }
    if (!officeId) return { error: 'Pick an office.' }
    // Clamp appearance to safe shapes (sprite index 0..6, #rrggbb hex, one emoji glyph);
    // any invalid/absent value falls back to the historical defaults so the row always
    // creates. Provider/model are NOT set here — the caller PATCHes them after create.
    const rawIdx = Number(opts?.avatarIndex)
    const avatarIndex = Number.isInteger(rawIdx) && rawIdx >= 0 && rawIdx <= 6 ? rawIdx : 0
    const color = /^#[0-9a-fA-F]{6}$/.test(String(opts?.color ?? '')) ? String(opts!.color) : '#00d4ff'
    const emoji = String(opts?.emoji ?? '').trim().slice(0, 8) || '🤖'
    try {
      const created = (await this.postJson('/api/agents', { name: nm, officeId, avatarIndex, color, emoji }))?.data ?? {}
      if (!created.id) return { error: 'The office did not return a new character.' }
      return { ok: true, id: String(created.id), slug: String(created.slug ?? ''), name: nm }
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) }
    }
  }

  /**
   * Deliver an INSTANT message (steer) to an office character — live over its WS,
   * mid-turn if the agent supports it. Unlike the local-agent composer (which only
   * appends a TODO task), this hits the office's real steer endpoint so a connected
   * character reacts right away. A steer has no server-side queue: if the character
   * is offline it evaporates, which the caller should surface.
   */
  async steer(agentId: string, text: string): Promise<{ ok: true } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    const msg = String(text ?? '').replace(/\r?\n+/g, ' ').trim()
    if (!msg) return { error: 'Message is empty.' }
    try {
      await this.postJson(`/api/agents/${encodeURIComponent(agentId)}/steer`, { text: msg })
      return { ok: true }
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) }
    }
  }

  /**
   * Fetch an office character's conversation for the in-app Chat tab. The local
   * app only knows the agent's ENDPOINT SLUG (from its wsUrl `endpoint=<slug>`) —
   * not the numeric office-agent id the message/hook APIs key on — so resolve the
   * agent (and its office) first, matching `agentRef` against each office agent's
   * id OR slug. `officeSlug` is an optional hint; when it doesn't resolve we scan
   * every office the user owns.
   *
   * Two server feeds are merged into one chat story, mirroring the web
   * AgentChatTab: `/api/messages?agentId=` (steers, A2A, status/celebrate bubbles)
   * and `/api/hooks/events` narration (the agent's own `agent_message`/
   * `notification` prose + `user_prompt_submit`). Returns the resolved `agentId`
   * so the Chat composer can steer the right character.
   */
  async messages(officeSlug: string, agentRef: string): Promise<{ ok: true; agentId: string; agentName: string; messages: OfficeMessage[] } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    const ref = String(agentRef ?? '').toLowerCase()
    if (!ref) return { error: 'This agent is not linked to an office.' }
    try {
      const offices = (await this.getJson('/api/offices'))?.data?.offices ?? []
      if (!offices.length) return { error: 'No offices found for this account.' }
      // Prefer the hinted office, then fall back to scanning all of them.
      const ordered = officeSlug
        ? [...offices].sort((a: any, b: any) =>
            (String(b.slug).toLowerCase() === officeSlug.toLowerCase() ? 1 : 0) -
            (String(a.slug).toLowerCase() === officeSlug.toLowerCase() ? 1 : 0))
        : offices
      let matched: { officeId: number; agentId: string; agentName: string } | null = null
      for (const o of ordered) {
        try {
          const ags = await this.getJson(`/api/offices/${encodeURIComponent(o.slug)}/agents`)
          const arr: any[] = Array.isArray(ags?.data) ? ags.data
            : Array.isArray(ags?.data?.agents) ? ags.data.agents
            : Array.isArray(ags?.agents) ? ags.agents
            : Array.isArray(ags) ? ags : []
          const a = arr.find((x) => String(x.id).toLowerCase() === ref || String(x.slug).toLowerCase() === ref)
          if (a) { matched = { officeId: o.id, agentId: String(a.id), agentName: String(a.name ?? a.slug ?? 'Agent') }; break }
        } catch (e) {
          if ((e as Error)?.message?.includes('expired')) throw e
          /* skip an office we couldn't list — keep scanning */
        }
      }
      if (!matched) return { error: 'This agent could not be found in any of your offices.' }
      const { officeId, agentId, agentName } = matched
      // Both feeds in parallel; either failing degrades gracefully to the other.
      const [feed, hooks] = await Promise.all([
        this.getJson(`/api/messages?agentId=${encodeURIComponent(agentId)}`).catch(() => ({ data: [] })),
        this.getJson(`/api/hooks/events?office_id=${encodeURIComponent(String(officeId))}&agent_id=${encodeURIComponent(agentId)}&limit=120`).catch(() => ({ data: [] }))
      ])
      const out: OfficeMessage[] = []
      // 1. Office message feed — steers / A2A / status bubbles.
      for (const m of (Array.isArray(feed?.data) ? feed.data : [])) {
        const type = String(m.type ?? 'status')
        if (type === 'choice') continue // interactive wizard, not a chat line
        const text = String(m.text ?? '').trim()
        if (!text) continue
        const role: OfficeMessage['role'] =
          (type === 'a2a' || type === 'a2a_instant') ? 'a2a'
          : (type === 'user' || type === 'user_input' || type === 'steer') ? 'user'
          : (type === 'status' || type === 'checkin' || type === 'ask') ? 'system'
          : 'assistant'
        const author =
          type === 'a2a_instant' ? '⚡ A2A'
          : role === 'a2a' ? '📨 A2A'
          : type === 'steer' ? '⚡ Steer'
          : role === 'user' ? 'You'
          : agentName
        out.push({ id: `m-${m.id}`, role, author, text, kind: type, at: Date.parse(m.createdAt) || 0 })
      }
      // 2. Narration hook events — the agent's own prose + user prompts.
      const NARRATION = new Set(['agent_message', 'notification', 'user_prompt_expansion'])
      for (const ev of (Array.isArray(hooks?.data) ? hooks.data : [])) {
        const etype = String(ev.eventType ?? '')
        const at = Date.parse(ev.createdAt) || 0
        if (etype === 'user_prompt_submit') {
          const text = String(ev.message ?? ev.rawPayload?.prompt ?? '').trim()
          if (text) out.push({ id: `h-${ev.id}`, role: 'user', author: 'You', text, kind: etype, at })
          continue
        }
        if (NARRATION.has(etype)) {
          const text = String(ev.message ?? ev.reasoning ?? '').trim()
          if (text) out.push({ id: `h-${ev.id}`, role: 'assistant', author: agentName, text, kind: etype, at })
        }
      }
      // Oldest → newest; a stable id tiebreak keeps same-timestamp rows deterministic.
      out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
      // Collapse consecutive assistant bubbles with identical text (grok/opencode
      // resend cumulative narration snapshots) so the feed doesn't stutter.
      const deduped: OfficeMessage[] = []
      for (const row of out) {
        const prev = deduped[deduped.length - 1]
        if (prev && prev.role === row.role && prev.text === row.text) continue
        deduped.push(row)
      }
      return { ok: true, agentId, agentName, messages: deduped }
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) }
    }
  }

  /**
   * Resolve a local agent ref (its office-agent id OR endpoint slug) to the
   * numeric office id + agent id + display name, scanning the user's offices
   * (hinted `officeSlug` first). Shared by the agent-events reader; mirrors the
   * resolution `messages()` does inline. Rethrows a session-expiry so the caller
   * surfaces it; returns null when the agent is in none of the user's offices.
   */
  /**
   * Resolve an office SLUG → its numeric `officeId` (and its agent roster, as a
   * `agentId → name` map for labeling office-wide events). Mirrors the office-id
   * resolution `_resolveAgentRef` does, but for the whole office rather than one
   * agent. Returns null when the slug matches no accessible office.
   */
  private async _resolveOfficeId(officeSlug: string): Promise<{ officeId: number; names: Map<string, string> } | null> {
    const slug = String(officeSlug ?? '').toLowerCase()
    if (!slug) return null
    const offices = (await this.getJson('/api/offices'))?.data?.offices ?? []
    const o = offices.find((x: any) => String(x.slug).toLowerCase() === slug)
    if (!o) return null
    const names = new Map<string, string>()
    try {
      const ags = await this.getJson(`/api/offices/${encodeURIComponent(o.slug)}/agents`)
      const arr: any[] = Array.isArray(ags?.data) ? ags.data
        : Array.isArray(ags?.data?.agents) ? ags.data.agents
        : Array.isArray(ags?.agents) ? ags.agents
        : Array.isArray(ags) ? ags : []
      for (const a of arr) names.set(String(a.id), String(a.name ?? a.slug ?? 'Agent'))
    } catch (e) {
      if ((e as Error)?.message?.includes('expired')) throw e
      /* roster lookup is best-effort — events still render with fallback labels */
    }
    return { officeId: o.id, names }
  }

  private async _resolveAgentRef(officeSlug: string, agentRef: string): Promise<{ officeId: number; agentId: string; agentName: string } | null> {
    const ref = String(agentRef ?? '').toLowerCase()
    if (!ref) return null
    const offices = (await this.getJson('/api/offices'))?.data?.offices ?? []
    if (!offices.length) return null
    const ordered = officeSlug
      ? [...offices].sort((a: any, b: any) =>
          (String(b.slug).toLowerCase() === officeSlug.toLowerCase() ? 1 : 0) -
          (String(a.slug).toLowerCase() === officeSlug.toLowerCase() ? 1 : 0))
      : offices
    for (const o of ordered) {
      try {
        const ags = await this.getJson(`/api/offices/${encodeURIComponent(o.slug)}/agents`)
        const arr: any[] = Array.isArray(ags?.data) ? ags.data
          : Array.isArray(ags?.data?.agents) ? ags.data.agents
          : Array.isArray(ags?.agents) ? ags.agents
          : Array.isArray(ags) ? ags : []
        const a = arr.find((x) => String(x.id).toLowerCase() === ref || String(x.slug).toLowerCase() === ref)
        if (a) return { officeId: o.id, agentId: String(a.id), agentName: String(a.name ?? a.slug ?? 'Agent') }
      } catch (e) {
        if ((e as Error)?.message?.includes('expired')) throw e
        /* skip an office we couldn't list — keep scanning */
      }
    }
    return null
  }

  /**
   * Fetch the focused office character's recent SERVER-SIDE hook events — the same
   * authoritative feed the web "Events" tab renders (`GET /api/hooks/events`
   * filtered by `office_id` + `agent_id`, newest-first). Unlike the local
   * `.autodev/hooks-events.jsonl`, this is written by the OFFICE regardless of
   * provider (grok-tui headless loops don't reliably write the local file), so the
   * app can SHOW what a working agent is actually doing instead of trusting a
   * heuristic badge. Read-only + resilient: resolves the agent like messages()
   * does, returns a compact newest-first list.
   */
  async agentEvents(officeSlug: string, agentRef: string, limit = 200, before?: number): Promise<{ ok: true; agentId: string; agentName: string; events: OfficeEvent[]; nextBefore: number | null; hasMore: boolean; total: number } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    if (!String(agentRef ?? '').trim()) return { error: 'This agent is not linked to an office.' }
    try {
      const matched = await this._resolveAgentRef(officeSlug, agentRef)
      if (!matched) return { error: 'This agent could not be found in any of your offices.' }
      const { officeId, agentId, agentName } = matched
      // Server clamps to 500; default to a deep first page so the panel matches the
      // pixel-office web depth immediately (older pages walk back via `before`).
      const lim = Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 200))
      const beforeParam = Number.isFinite(before) && (before as number) > 0 ? `&before=${Math.trunc(before as number)}` : ''
      const raw = await this.getJson(
        `/api/hooks/events?office_id=${encodeURIComponent(String(officeId))}&agent_id=${encodeURIComponent(agentId)}&limit=${lim}&order=desc${beforeParam}`
      ).catch(() => ({ data: [] }))
      const rows: any[] = Array.isArray(raw?.data) ? raw.data : []
      const events: OfficeEvent[] = []
      for (const ev of rows) {
        const evt = String(ev.eventType ?? '').trim()
        if (!evt) continue
        const tool = String(ev.toolName ?? '').trim() || undefined
        const msg = String(ev.message ?? ev.reasoning ?? '').replace(/\s+/g, ' ').trim()
        // Prose message wins as the label; else a compact tool/status descriptor.
        const text = (msg || (tool ? `${evt} · ${tool}` : evt)).slice(0, 400)
        events.push({ id: `e-${ev.id}`, at: Date.parse(ev.createdAt) || 0, evt, tool, text, ...hookRowDetail(ev) })
      }
      // The server returns newest-first (order=desc); enforce it defensively.
      events.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
      const nextBefore = typeof raw?.nextBefore === 'number' ? raw.nextBefore : null
      const hasMore = !!raw?.hasMore
      const total = typeof raw?.total === 'number' ? raw.total : events.length
      return { ok: true, agentId, agentName, events, nextBefore, hasMore, total }
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) }
    }
  }

  /**
   * Fetch the WHOLE office's recent hook events — every agent's stream, newest-first,
   * with each row labeled by its agent NAME (like the pixel-office web "Hook Events"
   * All tab / Room stream). Same authoritative feed as `agentEvents`, but filtered by
   * `office_id` ONLY (no `agent_id`), then each event's `agent_id` is mapped to a name
   * from the office roster (resolved once and cached for the batch). Read-only +
   * resilient; fails soft to `{ error }`.
   */
  async officeEvents(officeSlug: string, limit = 200, before?: number): Promise<{ ok: true; events: Array<OfficeEvent & { agentId: string; agentName: string }>; nextBefore: number | null; hasMore: boolean; total: number } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    if (!String(officeSlug ?? '').trim()) return { error: 'No office is open.' }
    try {
      const matched = await this._resolveOfficeId(officeSlug)
      if (!matched) return { error: 'This office could not be found.' }
      const { officeId, names } = matched
      const lim = Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 200))
      const beforeParam = Number.isFinite(before) && (before as number) > 0 ? `&before=${Math.trunc(before as number)}` : ''
      const raw = await this.getJson(
        `/api/hooks/events?office_id=${encodeURIComponent(String(officeId))}&limit=${lim}&order=desc${beforeParam}`
      ).catch(() => ({ data: [] }))
      const rows: any[] = Array.isArray(raw?.data) ? raw.data : []
      const events: Array<OfficeEvent & { agentId: string; agentName: string }> = []
      for (const ev of rows) {
        const evt = String(ev.eventType ?? '').trim()
        if (!evt) continue
        const tool = String(ev.toolName ?? '').trim() || undefined
        const msg = String(ev.message ?? ev.reasoning ?? '').replace(/\s+/g, ' ').trim()
        const text = (msg || (tool ? `${evt} · ${tool}` : evt)).slice(0, 400)
        const agentId = String(ev.agentId ?? ev.agent_id ?? '').trim()
        const agentName = names.get(agentId) || 'Agent'
        events.push({ id: `e-${ev.id}`, at: Date.parse(ev.createdAt) || 0, evt, tool, text, agentId, agentName, ...hookRowDetail(ev) })
      }
      events.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
      const nextBefore = typeof raw?.nextBefore === 'number' ? raw.nextBefore : null
      const hasMore = !!raw?.hasMore
      const total = typeof raw?.total === 'number' ? raw.total : events.length
      return { ok: true, events, nextBefore, hasMore, total }
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) }
    }
  }

  /**
   * Resolve the raw-TUI launch command for an Operate pane so it RESUMES the
   * agent's existing session instead of starting a blank one (the Operate path is
   * separate from the loop, so without this a "Connect & operate" always opened a
   * fresh chat and lost all prior context).
   *
   * grok resumes via `--continue` (NOT `--resume <id>`): a per-turn re-launch with
   * an id WE computed is fragile — a stale id or a cwd-encoding/realpath mismatch
   * makes grok error on resume and silently fall back to a FRESH, stateless session
   * (the observed post-turn-1 stall: a blank session with only the system prompt +
   * skill reminders, no task, so grok idles forever). `grok --continue` lets grok
   * resolve the newest session for the real cwd itself, immune to our id drift. The
   * command shape lives in the pure, unit-tested `buildOperateCommand`; here we only
   * supply the session-PRESENCE boolean it needs.
   *
   * POISON/EMPTY GUARD: the raw Operate pane has no poison self-heal, so we only
   * treat grok as resumable when a `chat_history.jsonl` exists and is non-empty —
   * a first connect on a fresh scratch dir legitimately has no session → bare.
   */
  private resolveOperateCommand(dir: string, provider: string): string {
    const hasResumableGrokSession =
      String(provider ?? '').toLowerCase().startsWith('grok') && this.newestGrokSession(dir) !== null
    return buildOperateCommand(provider, hasResumableGrokSession)
  }

  /**
   * Newest grok session UUID for a workspace dir whose chat_history.jsonl is present
   * and non-empty, or null. grok keys its store by the URL-encoded cwd (raw AND
   * realpath — the scratch dir can resolve through a symlink), newest mtime wins.
   */
  private newestGrokSession(dir: string): string | null {
    const grokHome = process.env['GROK_HOME'] || join(homedir(), '.grok')
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const roots = new Set<string>([dir])
    try { roots.add(realpathSync(dir)) } catch { /* ignore */ }
    let best: { id: string; mtime: number } | null = null
    for (const r of roots) {
      const base = join(grokHome, 'sessions', encodeURIComponent(r))
      if (!existsSync(base)) continue
      try {
        for (const e of readdirSync(base, { withFileTypes: true })) {
          if (!e.isDirectory() || !isUuid.test(e.name)) continue
          const sessionDir = join(base, e.name)
          // Poison/empty guard: skip sessions with no usable transcript.
          const hist = join(sessionDir, 'chat_history.jsonl')
          try { if (!existsSync(hist) || statSync(hist).size === 0) continue } catch { continue }
          let m = 0
          try { m = statSync(sessionDir).mtimeMs } catch { /* ignore */ }
          if (!best || m > best.mtime) best = { id: e.name, mtime: m }
        }
      } catch { /* ignore */ }
    }
    return best?.id ?? null
  }

  async operate(officeSlug: string, agentId: string, agentSlug: string, provider = ''): Promise<{ ok: true; cwd: string; mcpUrl: string; command: string } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    try {
      let creds: any
      try {
        creds = (await this.getJson(`/api/offices/${officeSlug}/agents/${agentId}/credentials`))?.data ?? {}
      } catch (e) {
        dbg('operate: credentials fetch failed', e)
        return { error: `Couldn't fetch this agent's MCP credentials — ${String((e as Error)?.message ?? e)}` }
      }
      const key = creds.apiKey as string | undefined
      // creds.mcpUrl is server-controlled: only honour it when it's an http(s)
      // URL on this office's own origin, else fall back to the derived endpoint.
      const url = safeMcpUrl(creds.mcpUrl, this.base, `${this.base}/api/office-mcp`)
      if (!key) return { error: 'No API key returned for this agent — it may lack office-MCP access.' }
      // officeSlug/agentSlug/agentId are server-controlled — sanitize each path
      // segment and confirm the result stays inside the offices sandbox root so a
      // hostile slug (e.g. "../../.config/autostart") can't escape it.
      const root = join(homedir(), '.autodev-app', 'offices')
      const dir = join(root, safeSeg(officeSlug), safeSeg(agentSlug || agentId))
      if (resolve(dir) !== root && !resolve(dir).startsWith(resolve(root) + sep)) {
        return { error: 'Invalid office/agent identifier.' }
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      // Strip any stale cozempic-installed SessionStart hook from the GLOBAL
      // ~/.claude/settings.json (and this scratch dir's local settings) BEFORE the
      // PTY launches. An operate-only grok/claude character has no loop/profile
      // rebuild in front of it, so without this a leftover global hook keeps
      // failing on Windows (`session_start hook (global/settings) failed … exit
      // code 1`). Best-effort — a clean failure must never block the launch.
      try { removeCozempicHooks(dir) } catch { /* never block operate on hook cleanup */ }
      writeMcpJson(dir, key, url)
      writeMcpTrust(dir) // auto-approve the office-MCP server so it actually starts
      markFolderTrusted(dir) // pre-accept the folder-trust dialog for this app-owned dir (claude)
      markGrokFolderTrusted(dir) // …and for grok — always launch in trust/auto mode
      this.recordProvisioned(dir) // track for key-purge on logout
      // Resume the agent's existing session (grok --resume <id> / claude --continue)
      // rather than opening a blank chat — the Operate pane is separate from the loop
      // (ADD 2). Bare/fresh when no non-empty prior session exists for this dir.
      const command = this.resolveOperateCommand(dir, provider)
      // PRE-CHECK the provider binary is resolvable BEFORE handing the command to a
      // PTY — otherwise a missing CLI surfaces only as a cryptic node-pty "File not
      // found" (win32) or a silent shell "command not found". Surface a clear,
      // provider-named reason with an install hint instead.
      const bin = command.trim().split(/\s+/)[0] || ''
      if (bin && !resolveBinOnPath(bin)) {
        const info = PROVIDER_BIN_INFO[bin.toLowerCase()]
        const label = info?.label ?? `${bin} CLI`
        const hint = info ? ` — ${info.install}, then try again` : ' — install it and make sure it is on your PATH, then try again'
        dbg('operate: provider CLI missing', bin)
        return { error: `${label} not found on PATH${hint}.` }
      }
      dbg('operate: wired', agentSlug || agentId, '→', url, 'cwd', dir, 'cmd', command)
      return { ok: true, cwd: dir, mcpUrl: url, command }
    } catch (e) { dbg('operate error', e); return { error: String((e as Error)?.message ?? e) } }
  }

  /**
   * The scratch dir a "Connect & operate" launch for this character resolves to —
   * IDENTICAL to the dir `operate()` computes and to the loop dir `spawnOffice()`
   * writes (`~/.autodev-app/offices/<slug>/<agentSlug|agentId>`). Exposed so the
   * `office:operate` handler can find + STOP a same-character LOOP running in this
   * exact dir BEFORE launching the interactive grok/claude PTY — otherwise a loop
   * and an operate session fight over the one office connection + grok session
   * (task_already_running / "Grok stopped before this turn finished" / retry loop).
   * Returns null when the sanitized dir would escape the offices sandbox root.
   */
  resolveOperateCwd(officeSlug: string, agentSlug: string, agentId: string): string | null {
    const root = join(homedir(), '.autodev-app', 'offices')
    const dir = join(root, safeSeg(officeSlug), safeSeg(agentSlug || agentId))
    if (resolve(dir) !== root && !resolve(dir).startsWith(resolve(root) + sep)) return null
    return dir
  }

  /**
   * Ensure a character's Operate/loop scratch workspace EXISTS + is wired to the
   * office (its office-MCP key written into `.mcp.json`, folder pre-trusted), and
   * return its path — WITHOUT launching any provider. This is what the per-character
   * MCP editor (CharacterSettingsModal → McpEditorModal) scopes to, so adding /
   * toggling MCP servers there writes the SAME `.mcp.json` the operate/loop launch
   * uses. Mirrors operate()'s provisioning minus the command/bin resolution — a
   * character whose scratch dir was never operated still gets a valid workspace to
   * edit. Best-effort office-key write (an editor still works with just the file).
   */
  async ensureWorkspace(officeSlug: string, agentId: string, agentSlug: string, provider = ''): Promise<{ ok: true; cwd: string } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    const dir = this.resolveOperateCwd(officeSlug, agentSlug, agentId)
    if (!dir) return { error: 'Invalid office/agent identifier.' }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      // Write the office-MCP server (its key) so the character's MCP list starts
      // from its real office connection — best-effort: a failed credentials fetch
      // still leaves a usable dir the editor can add servers to.
      try {
        const creds = (await this.getJson(`/api/offices/${officeSlug}/agents/${agentId}/credentials`))?.data ?? {}
        const key = creds.apiKey as string | undefined
        const url = safeMcpUrl(creds.mcpUrl, this.base, `${this.base}/api/office-mcp`)
        if (key) { writeMcpJson(dir, key, url); writeMcpTrust(dir); this.recordProvisioned(dir) }
      } catch (e) { dbg('ensureWorkspace: office key write skipped', e) }
      markFolderTrusted(dir)
      markGrokFolderTrusted(dir)
      if (provider) this.writeProvider(dir, provider)
      return { ok: true, cwd: dir }
    } catch (e) { dbg('ensureWorkspace error', e); return { error: String((e as Error)?.message ?? e) } }
  }

  /**
   * The sanitized scratch ROOT for an office's spawned loops
   * (`~/.autodev-app/offices/<slug>`), or null when the slug would escape the
   * sandbox. index.ts uses it to find + stop every tracked loop bound to an
   * office (stopOffice) — the office scratch dirs all live under this root.
   */
  officeLoopRoot(officeSlug: string): string | null {
    const slug = String(officeSlug ?? '').trim()
    if (!slug) return null
    const root = join(homedir(), '.autodev-app', 'offices')
    const dir = join(root, safeSeg(slug))
    if (resolve(dir) !== root && !resolve(dir).startsWith(resolve(root) + sep)) return null
    return dir
  }

  /**
   * Record a loop's chosen provider in `<dir>/.autodev/settings.json` so
   * `autodev start` uses it even absent an explicit `-p`, and the sidebar shows
   * the right provider. bindWorkspaceToOffice merge-writes the same file and
   * preserves this key; we only touch `provider`. Best-effort.
   */
  private writeProvider(dir: string, provider: string): void {
    try {
      const p = String(provider ?? '').trim()
      if (!p) return
      const adir = join(dir, '.autodev')
      mkdirSync(adir, { recursive: true })
      const sfile = join(adir, 'settings.json')
      let s: Record<string, any> = {}
      try { const j = JSON.parse(readFileSync(sfile, 'utf8')); if (j && typeof j === 'object') s = j } catch { /* none/invalid → fresh */ }
      if (s.provider === p) return
      s.provider = p
      writeFileSync(sfile, JSON.stringify(s, null, 2), { mode: 0o600 })
      try { chmodSync(sfile, 0o600) } catch { /* best effort */ }
    } catch { /* best effort */ }
  }

  /**
   * Persist the office character's chosen MODEL into a spawned loop's
   * `<dir>/.autodev/settings.json` under the per-vendor model key
   * (`grokModel`/`claudeModel`/`opencodeModel`/`copilotModel`, mirroring the app's
   * MODEL_KEY map), so `autodev start` launches on the model the owner set in the
   * office — without this, spawnOffice only wrote `provider`, so changing a
   * character's model in the office had NO effect on the loop it spawned. Empty /
   * unknown model → no-op ("provider default"). MERGE-write (preserves provider +
   * presence keys). Best-effort.
   */
  private writeModel(dir: string, provider: string, model?: string): void {
    try {
      const m = String(model ?? '').trim()
      if (!m) return
      const vendor = String(provider ?? '').toLowerCase().split('-')[0]
      const KEY: Record<string, string> = {
        claude: 'claudeModel', grok: 'grokModel', opencode: 'opencodeModel', copilot: 'copilotModel'
      }
      const key = KEY[vendor]
      if (!key) return
      const adir = join(dir, '.autodev')
      mkdirSync(adir, { recursive: true })
      const sfile = join(adir, 'settings.json')
      let s: Record<string, any> = {}
      try { const j = JSON.parse(readFileSync(sfile, 'utf8')); if (j && typeof j === 'object') s = j } catch { /* none/invalid → fresh */ }
      if (s[key] === m) return
      s[key] = m
      writeFileSync(sfile, JSON.stringify(s, null, 2), { mode: 0o600 })
      try { chmodSync(sfile, 0o600) } catch { /* best effort */ }
    } catch { /* best effort */ }
  }

  /**
   * Seed the Cozempic long-session-guard preference into a spawned loop's
   * `<dir>/.autodev/settings.json` so the CLI reads `cozempicAutoInit` at loop
   * start (On ⇒ auto-runs `cozempic init` for Claude projects; Off ⇒ no-op).
   * The renderer create flows (MakeAppView) already `config set` this key; the
   * app-only "⚡ Spawn office" path materializes settings.json entirely in-process
   * and never touched it, so the Settings toggle had no effect on those loops.
   * MERGE-write (preserves every existing key, e.g. the presence binding and
   * provider bindWorkspaceToOffice/writeProvider just wrote); mirrors writeProvider.
   * Reads the app preference via appSettings.getCozempicAutoInit(). Best-effort.
   */
  private writeCozempicAutoInit(dir: string): void {
    try {
      const want = getCozempicAutoInit() === true
      const adir = join(dir, '.autodev')
      mkdirSync(adir, { recursive: true })
      const sfile = join(adir, 'settings.json')
      let s: Record<string, any> = {}
      try { const j = JSON.parse(readFileSync(sfile, 'utf8')); if (j && typeof j === 'object') s = j } catch { /* none/invalid → fresh */ }
      if (s.cozempicAutoInit === want) return
      s.cozempicAutoInit = want
      writeFileSync(sfile, JSON.stringify(s, null, 2), { mode: 0o600 })
      try { chmodSync(sfile, 0o600) } catch { /* best effort */ }
    } catch { /* best effort */ }
  }

  /**
   * Seed the optional loop-session reset interval (Settings toggle) into a spawned
   * loop's `<dir>/.autodev/settings.json` so the CLI reads `resetSessionEveryNTurns`
   * at loop start. Default 0 = never reset = ALWAYS RESUME; the renderer create flows
   * do this via `config set`, but this app-only spawn path materializes settings.json
   * in-process, so the toggle would otherwise never reach it. MERGE-write (mirrors
   * writeCozempicAutoInit); never writes `resumeSession` (loop default stays on, so 0
   * keeps resuming forever). Best-effort.
   */
  private writeResetSessionEveryNTurns(dir: string): void {
    try {
      const want = getResetSessionEveryNTurns()
      const adir = join(dir, '.autodev')
      mkdirSync(adir, { recursive: true })
      const sfile = join(adir, 'settings.json')
      let s: Record<string, any> = {}
      try { const j = JSON.parse(readFileSync(sfile, 'utf8')); if (j && typeof j === 'object') s = j } catch { /* none/invalid → fresh */ }
      if ((s.resetSessionEveryNTurns ?? 0) === want) return
      s.resetSessionEveryNTurns = want
      writeFileSync(sfile, JSON.stringify(s, null, 2), { mode: 0o600 })
      try { chmodSync(sfile, 0o600) } catch { /* best effort */ }
    } catch { /* best effort */ }
  }

  /**
   * Prepare EVERY character in an office to run as a TRACKED autodev-cli LOOP.
   * BLOCKS (with no side effects) if ANY character is already online — returns
   * `{ error, online:[names] }` — so we never double-drive a live character.
   * Otherwise, per character: creates an app-owned scratch workspace
   * (`~/.autodev-app/offices/<slug>/<agentSlug>`), BINDS it to the office
   * character (bindWorkspaceToOffice — presence binding + office-MCP + scoped
   * trust + file-browser), records the chosen provider (override → the roster
   * provider), and pre-accepts the folder-trust dialog. Returns the ordered list
   * of prepared workspaces; the IPC handler in index.ts then registers each with
   * AgentManager (add) and starts its loop (start(path, provider)). `path` is the
   * tracked workspace so the renderer can subscribe to each loop's `agent:log`
   * stream. `overrides` maps an agentId → the provider to launch it with.
   */
  async spawnOffice(officeSlug: string, overrides?: Array<{ agentId: string; provider?: string }>):
    Promise<{ ok: true; agents: Array<{ agentId: string; agentSlug: string; name: string; path: string; provider: string; officeSlug: string }> }
           | { error: string; online?: string[] }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    if (!officeSlug) return { error: 'Pick an office to spawn.' }
    try {
      const ags = await this.getJson(`/api/offices/${encodeURIComponent(officeSlug)}/agents`)
      const roster: any[] = Array.isArray(ags?.data) ? ags.data
        : Array.isArray(ags?.data?.agents) ? ags.data.agents
        : Array.isArray(ags?.agents) ? ags.agents
        : Array.isArray(ags) ? ags : []
      if (!roster.length) return { error: 'This office has no characters to spawn.' }

      // A non-empty `overrides` list is an explicit SELECTION of which characters to
      // spawn — the renderer passes only the offline/pending ones for a partial
      // "Connect N more". Restrict the roster to that selection so we never re-spawn
      // an already-connected character. Empty/absent list = the whole office.
      const selection = new Set((overrides ?? []).map((o) => String(o?.agentId)).filter(Boolean))
      const selected = selection.size ? roster.filter((a) => selection.has(String(a.id))) : roster
      if (!selected.length) return { error: 'None of the selected characters are in this office.' }

      // BLOCK if any SELECTED character is already online (same online test listAgents
      // uses — WS OR MCP, so a live operate-mode TUI also blocks a double-driving loop
      // spawn). The renderer filters to offline, so this now only trips on a race.
      // Checked BEFORE any workspace is written so a blocked call has no side effects.
      const online = selected.filter((a) => isOfficeAgentPresent(a))
                           .map((a) => String(a.name ?? a.slug ?? a.id))
      if (online.length) {
        return { error: `Can't spawn — ${online.length} character(s) already online: ${online.join(', ')}.`, online }
      }

      // Per-agent provider override (renderer's per-row dropdown). Falls back to
      // the roster provider when no override is given for that character.
      const overrideMap = new Map<string, string>()
      for (const o of overrides ?? []) {
        if (o && o.agentId && o.provider) overrideMap.set(String(o.agentId), String(o.provider))
      }

      const root = join(homedir(), '.autodev-app', 'offices')
      const out: Array<{ agentId: string; agentSlug: string; name: string; path: string; provider: string; officeSlug: string }> = []
      for (const a of selected) {
        const agentId = String(a.id)
        const agentSlug = String(a.slug || a.id)
        const name = String(a.name ?? agentSlug)
        // Normalize the office provider ("grok"/"claude") to the CLI's -p id
        // ("grok-tui"/"claude-cli") — the loop rejects the bare family name.
        const provider = toAutodevProvider(overrideMap.get(agentId) ?? String(a.provider ?? 'claude'))
        // Sanitize each server-controlled path segment and confirm the scratch dir
        // stays inside the offices sandbox root before any write.
        const dir = join(root, safeSeg(officeSlug), safeSeg(agentSlug))
        if (resolve(dir) !== root && !resolve(dir).startsWith(resolve(root) + sep)) {
          return { error: `Invalid office/agent identifier for "${name}".` }
        }
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        // BIND: writes the `.autodev/settings.json` presence binding + merges the
        // pixel-office mcp-operate server (with file-browser) + scoped trust +
        // gitignore + recordProvisioned — everything `autodev start` needs to come
        // up already connected as this character. Self-fetches creds/mcpUrl/wsUrl.
        const bound = await this.bindWorkspaceToOffice(dir, officeSlug, { id: agentId, slug: agentSlug, name }, true)
        if ('error' in bound) return { error: `Couldn't bind "${name}" to the office — ${bound.error}` }
        // Persist the loop's provider (override wins) so `autodev start` uses it.
        this.writeProvider(dir, provider)
        // …and the owner's chosen model, so a model change in the office actually
        // applies to the spawned loop (was previously dropped — only provider stuck).
        this.writeModel(dir, provider, typeof a.model === 'string' ? a.model : undefined)
        // Seed the Cozempic long-session-guard preference (Settings toggle) so the
        // CLI reads cozempicAutoInit at loop start — the renderer create flows do
        // this via `config set`, but this app-only spawn path writes settings.json
        // entirely in-process, so the toggle would otherwise never reach it.
        this.writeCozempicAutoInit(dir)
        // Seed the optional session-reset interval (Settings) so the CLI reads
        // resetSessionEveryNTurns at loop start (default 0 = always resume).
        this.writeResetSessionEveryNTurns(dir)
        // Pre-accept Claude Code's folder-trust dialog for this app-owned scratch
        // dir (bindWorkspaceToOffice deliberately does NOT, since it also wires real
        // repos) so a loop / interactive claude here never blocks on the prompt.
        markFolderTrusted(dir)
        markGrokFolderTrusted(dir) // grok twin — always launch in trust/auto mode
        out.push({ agentId, agentSlug, name, path: dir, provider, officeSlug })
      }
      dbg('spawnOffice: prepared', out.length, 'loop(s) in', officeSlug)
      return { ok: true, agents: out }
    } catch (e) {
      if ((e as Error)?.message?.includes('expired')) return { error: 'Session expired — reconnect.' }
      dbg('spawnOffice error', e); return { error: String((e as Error)?.message ?? e) }
    }
  }

  /** Create a character for a Claude session and wire its folder to the office,
   *  so resuming the session runs it live as that character. */
  async connectSession(officeSlug: string, officeId: number, cwd: string, sessionId: string, name: string): Promise<{ ok: true; cwd: string; sessionId: string; agentSlug: string; agentName: string } | { error: string }> {
    void officeSlug // kept for IPC signature symmetry with operate()
    // Guard parity with operate()/createOffice(): never create a remote agent or
    // touch the filesystem when we aren't actually authenticated.
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    // sessionId is a filesystem-derived transcript stem that is interpolated into
    // a `claude --resume <id>` shell command downstream — reject anything that is
    // not a plain token so a hostile filename can't inject shell metacharacters.
    if (!isValidSessionId(sessionId)) return { error: 'Invalid session id.' }
    try {
      const nm = (name || 'session').replace(/[^\w .-]+/g, '').slice(0, 20) || 'session'
      const created = await this.postJson('/api/agents', { name: nm, officeId, avatarIndex: 0, color: '#00d4ff', emoji: '🎬' })
      const d = created?.data ?? created
      const key = d?.apiKey as string | undefined
      const slug = (d?.slug as string) || nm
      if (!key) return { error: 'Agent created but no API key returned.' }
      const url = `${this.base}/api/office-mcp`
      // connectSession wires the user's REAL project cwd (the transcript's on-disk
      // workspace), so unlike operate()'s app-owned scratch dir we must NOT clobber
      // their files or blanket-trust the repo:
      //  - gitignore the secret-bearing files first so they can't be committed,
      //  - MERGE (not overwrite) the office server into any existing .mcp.json,
      //  - scope trust to ONLY the pixel-office server (never enable-all).
      mkdirSync(cwd, { recursive: true })
      ensureGitignored(cwd, ['.mcp.json', '.claude/settings.local.json'])
      mergeMcpJson(cwd, key, url)
      writeScopedMcpTrust(cwd) // approve ONLY the office-MCP server so it starts
      this.recordProvisioned(cwd) // track this REAL repo for key-purge on logout
      return { ok: true, cwd, sessionId, agentSlug: slug, agentName: nm }
    } catch (e) { return { error: String((e as Error)?.message ?? e) } }
  }

  /** Create a new office (the "make app" flow: describe → office). */
  async createOffice(name: string, description: string): Promise<{ ok: true; office: { slug: string; id: number; name: string } } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    try {
      const r = await this.postJson('/api/offices', { name, description })
      const o = r?.data?.office ?? r?.office
      if (!o?.slug) return { error: 'Office created but no slug returned.' }
      return { ok: true, office: { slug: o.slug, id: o.id, name: o.name } }
    } catch (e) { return { error: String((e as Error)?.message ?? e) } }
  }

  /** AI-generate a complementary team of agents for an office (Kimi via ollama).
   *  Each created character comes back with its office `id`/`slug`, which the
   *  single-shared-folder spawn needs to fetch per-agent MCP credentials. */
  async generateTeam(officeId: number, prompt: string, count: number): Promise<{ ok: true; agents: Array<{ id?: string; slug?: string; name: string; role?: string; emoji: string; color: string }> } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    try {
      const r = await this.postJson('/api/agents/generate', { officeId, prompt, count })
      const raw = (r?.data?.agents ?? r?.agents ?? []) as Array<Record<string, any>>
      const agents = raw.map((a) => ({
        id: a.id != null ? String(a.id) : undefined,
        slug: a.slug != null ? String(a.slug) : undefined,
        name: String(a.name ?? ''), role: a.role, emoji: a.emoji, color: a.color
      }))
      return { ok: true, agents }
    } catch (e) { return { error: String((e as Error)?.message ?? e) } }
  }

  /**
   * SINGLE-SHARED-FOLDER spawn: wire ONE project `folder` to N office characters
   * via a single `folder/.mcp.json` holding one `pixel-office-<agentSlug>` server
   * per agent — instead of the default one-workspace-per-agent path. Each server
   * carries that character's live office-MCP key/URL (fetched from its credentials
   * endpoint), so a `claude` launched in `folder` can drive every character.
   *
   * Characters are already created (the generate-team step made them); `agents`
   * carries each one's office `id`/`slug`/`name`, resolved against the office's
   * live roster so a renamed roster box still maps to the right character. Merges
   * (never overwrites) so entries accumulate, gitignores the key-bearing files,
   * and records `folder` for key-purge on logout.
   */
  async writeSharedMcp(folder: string, officeSlug: string, agents: Array<{ id?: string; slug?: string; name?: string }>, fileBrowser = false):
    Promise<{ ok: true; folder: string; wired: number; servers: string[]; missing: string[] } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    const dir = String(folder ?? '').trim()
    if (!dir) return { error: 'Pick a folder to wire the agents into.' }
    if (!officeSlug) return { error: 'The single-shared-folder mode needs an office.' }
    if (!Array.isArray(agents) || !agents.length) return { error: 'No agents to wire.' }
    try {
      // Resolve the office's live roster once so id/slug/name all map to a character
      // (a renamed roster box keeps the original id/slug from generate time).
      let roster: any[] = []
      try {
        const ags = await this.getJson(`/api/offices/${encodeURIComponent(officeSlug)}/agents`)
        roster = Array.isArray(ags?.data) ? ags.data
          : Array.isArray(ags?.data?.agents) ? ags.data.agents
          : Array.isArray(ags?.agents) ? ags.agents
          : Array.isArray(ags) ? ags : []
      } catch (e) {
        return { error: `Couldn't list the office characters — ${String((e as Error)?.message ?? e)}` }
      }
      mkdirSync(dir, { recursive: true })
      ensureGitignored(dir, ['.mcp.json', '.claude/settings.local.json'])
      const servers: string[] = []
      const missing: string[] = []
      for (const want of agents) {
        const id = want.id ? String(want.id) : ''
        const slug = want.slug ? String(want.slug) : ''
        const nm = want.name ? String(want.name).toLowerCase() : ''
        const ch = roster.find((x) =>
          (id && String(x.id) === id) ||
          (slug && String(x.slug) === slug) ||
          (nm && String(x.name ?? '').toLowerCase() === nm))
        if (!ch) { missing.push(want.name || slug || id || '?'); continue }
        let creds: any
        try { creds = (await this.getJson(`/api/offices/${encodeURIComponent(officeSlug)}/agents/${encodeURIComponent(String(ch.id))}/credentials`))?.data ?? {} }
        catch { missing.push(String(ch.name ?? ch.slug ?? ch.id)); continue }
        const key = creds.apiKey as string | undefined
        const url = safeMcpUrl(creds.mcpUrl, this.base, `${this.base}/api/office-mcp`)
        if (!key) { missing.push(String(ch.name ?? ch.slug ?? ch.id)); continue }
        const server = `pixel-office-${safeSeg(String(ch.slug || ch.id))}`
        mergeMcpJson(dir, key, url, server, fileBrowser)   // accumulate — one entry per character (+file-browser when on)
        writeScopedMcpTrust(dir, server)      // approve THIS server so it starts
        this.recordProvisioned(dir)           // track for key-purge on logout
        servers.push(server)
      }
      if (!servers.length) return { error: `No agents could be wired${missing.length ? ` (unmatched: ${missing.join(', ')})` : ''}.` }
      dbg('writeSharedMcp: wired', servers.length, 'server(s) into', dir, missing.length ? `missing=${missing.length}` : '')
      return { ok: true, folder: dir, wired: servers.length, servers, missing }
    } catch (e) { dbg('writeSharedMcp error', e); return { error: String((e as Error)?.message ?? e) } }
  }

  /**
   * Create a fresh office character via `POST /api/agents` (mirrors
   * AgentController::store: server mints the slug + api_key). Used by
   * bindWorkspaceToOffice when no roster match exists so connect-to-office can
   * (re)create a deleted/never-created character instead of dead-ending, and by
   * the sidebar quick-add. Returns the new character's id/slug/apiKey.
   */
  async createOfficeAgent(officeSlug: string, name: string):
    Promise<{ ok: true; id: string; slug: string; apiKey: string; name: string } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    const nm = String(name ?? '').replace(/<[^>]*>/g, '').trim() || 'Agent'
    if (!officeSlug) return { error: 'Pick an office to create the character in.' }
    try {
      const office = (await this.offices()).find((o) => o.slug === officeSlug)
      if (!office) return { error: `Office "${officeSlug}" not found.` }
      const res = await this.postJson('/api/agents', {
        name: nm.slice(0, 20), officeId: office.id, avatarIndex: 0, color: '#00d4ff', emoji: '🎬',
      })
      const d = res?.data ?? {}
      if (!d.id || !d.apiKey) return { error: 'The office did not return a new character id + key.' }
      return { ok: true, id: String(d.id), slug: String(d.slug ?? ''), apiKey: String(d.apiKey), name: nm }
    } catch (e) { return { error: String((e as Error)?.message ?? e) } }
  }

  /**
   * Bind an EXISTING local workspace `cwd` to an office character — the core
   * primitive both the Spawn flow (fresh per-agent workspaces) and the
   * Connect-to-office action (already-spawned agents) build on. A correctly
   * office-connected agent has BOTH a `.autodev/settings.json` presence binding
   * (serverBaseUrl / serverApiKey / webhookSlug / wsUrl) AND the `pixel-office`
   * mcp-operate server in `.mcp.json`; this writes both, MERGING each so no
   * existing keys/servers are clobbered. The character is matched against the
   * office roster by id, then slug, then name (lowercased). A loop
   * started/restarted in `cwd` afterwards comes up already connected.
   */
  async bindWorkspaceToOffice(cwd: string, officeSlug: string, want: { id?: string; slug?: string; name?: string }, fileBrowser = false):
    Promise<{ ok: true; slug: string; name: string } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    const dir = String(cwd ?? '').trim()
    if (!dir) return { error: 'No workspace folder to bind.' }
    if (!officeSlug) return { error: 'Pick an office to bind to.' }
    try {
      // Resolve the office's live roster so id/slug/name all map to a character.
      let roster: any[] = []
      try {
        const ags = await this.getJson(`/api/offices/${encodeURIComponent(officeSlug)}/agents`)
        roster = Array.isArray(ags?.data) ? ags.data
          : Array.isArray(ags?.data?.agents) ? ags.data.agents
          : Array.isArray(ags?.agents) ? ags.agents
          : Array.isArray(ags) ? ags : []
      } catch (e) {
        return { error: `Couldn't list the office characters — ${String((e as Error)?.message ?? e)}` }
      }
      const id = want.id ? String(want.id) : ''
      const slug = want.slug ? String(want.slug) : ''
      const nm = want.name ? String(want.name).toLowerCase() : ''
      let ch: any = roster.find((x) =>
        (id && String(x.id) === id) ||
        (slug && String(x.slug) === slug) ||
        (nm && String(x.name ?? '').toLowerCase() === nm))
      let creds: any = null
      if (!ch) {
        // No character with this id/slug/name in the office (e.g. it was deleted
        // from the pixel office). Recreate it via the API so connect-to-office is a
        // true "(re)create + bind" instead of a dead end — the fix for "deleted the
        // team, now they won't recreate". Requires a name/slug to create it under.
        if (!want.name && !want.slug) return { error: `No office character matches "${want.id || '?'}"` }
        const created = await this.createOfficeAgent(officeSlug, want.name || want.slug || '')
        if ('error' in created) return { error: `Couldn't (re)create a character for "${want.name || want.slug || '?'}" — ${created.error}` }
        ch = { id: created.id, slug: created.slug, name: created.name }
        creds = { apiKey: created.apiKey, slug: created.slug }
      }
      if (!creds) {
        try { creds = (await this.getJson(`/api/offices/${encodeURIComponent(officeSlug)}/agents/${encodeURIComponent(String(ch.id))}/credentials`))?.data ?? {} }
        catch (e) { return { error: `Couldn't fetch this character's MCP credentials — ${String((e as Error)?.message ?? e)}` } }
      }
      const key = creds.apiKey as string | undefined
      if (!key) return { error: 'No API key returned for that character — it may lack office-MCP access.' }
      const base = this.base
      const wsBase = base.replace(/^http/, 'ws')
      const chSlug = String(ch.slug || creds.slug || slug || ch.id)
      const url = safeMcpUrl(creds.mcpUrl, base, `${base}/api/office-mcp`)
      // Prefer the office's own authoritative wsUrl (its WS path may be configured),
      // but only when it's a ws/wss URL whose host matches the connected office base
      // (mirrors safeMcpUrl); otherwise fall back to the documented
      // `${wsBase}/ws?token=…&endpoint=…` derivation so a malicious office response
      // can't repoint the presence socket at an attacker endpoint.
      const wsUrl = safeWsUrl(creds.wsUrl, base, `${wsBase}/ws?token=${key}&endpoint=${chSlug}`)
      // MERGE-write the presence binding into `.autodev/settings.json` — preserve
      // every existing key (provider, sessionName, …), set only the 4 presence fields.
      const adir = join(dir, '.autodev')
      mkdirSync(adir, { recursive: true })
      const sfile = join(adir, 'settings.json')
      let s: Record<string, any> = {}
      try { const p = JSON.parse(readFileSync(sfile, 'utf8')); if (p && typeof p === 'object') s = p } catch { /* none/invalid → fresh */ }
      s.serverBaseUrl = base
      s.serverApiKey = key
      s.webhookSlug = chSlug
      s.wsUrl = wsUrl
      writeFileSync(sfile, JSON.stringify(s, null, 2), { mode: 0o600 })
      try { chmodSync(sfile, 0o600) } catch { /* best effort */ }
      // Wire the office-MCP server + scoped trust (mirrors connectSession's real-repo path).
      ensureGitignored(dir, ['.mcp.json', '.claude/settings.local.json'])
      mergeMcpJson(dir, key, url, undefined, fileBrowser)
      writeScopedMcpTrust(dir)
      this.recordProvisioned(dir)
      dbg('bindWorkspaceToOffice: bound', chSlug, '→', dir)
      return { ok: true, slug: chSlug, name: String(ch.name ?? chSlug) }
    } catch (e) { dbg('bindWorkspaceToOffice error', e); return { error: String((e as Error)?.message ?? e) } }
  }

  /**
   * Update an office character's owner-editable settings — provider family, model,
   * display name, file-browser toggle — via the flat, owner-scoped
   * `PATCH /api/agents/{id}` (AgentController::update). This is the SINGLE source of
   * truth for a character's provider: it persists in the office DB, drives the card
   * badge on the next poll, AND is what spawnOffice/operate read to launch the loop
   * with the right `-p` id — so the identity (name/slug/key) is untouched while the
   * engine changes ("provider-portable identity"). Only the keys present in `patch`
   * are sent; the server whitelists + validates each.
   */
  async updateCharacter(
    agentId: string,
    patch: { provider?: string; model?: string; name?: string; fileBrowserEnabled?: boolean }
  ): Promise<{ ok: true; provider?: string; model?: string; name?: string } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    const id = String(agentId ?? '').trim()
    if (!id) return { error: 'No office character id to update.' }
    const body: Record<string, unknown> = {}
    if (patch.provider !== undefined) body.provider = String(patch.provider).toLowerCase()
    if (patch.model !== undefined) body.model = String(patch.model)
    if (patch.name !== undefined) body.name = String(patch.name)
    if (patch.fileBrowserEnabled !== undefined) body.fileBrowserEnabled = !!patch.fileBrowserEnabled
    if (Object.keys(body).length === 0) return { error: 'Nothing to update.' }
    try {
      const data = (await this.patchJson(`/api/agents/${encodeURIComponent(id)}`, body))?.data ?? {}
      dbg('updateCharacter: updated', id, Object.keys(body).join(','))
      return { ok: true, provider: data.provider, model: data.model, name: data.name }
    } catch (e) { return { error: String((e as Error)?.message ?? e) } }
  }

  /**
   * Delete an office character (agent row) from the pixel office. The owner-scoped
   * route is the flat `DELETE /api/agents/{id}` (AgentController::destroy) — the
   * office slug is only needed to resolve the id, which the caller already has, so
   * it's accepted for signature symmetry but not required by the endpoint.
   */
  async deleteOfficeAgent(officeSlug: string, agentId: string): Promise<{ ok: true } | { error: string }> {
    void officeSlug // signature symmetry; the destroy route is not office-scoped
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    const id = String(agentId ?? '').trim()
    if (!id) return { error: 'No office character id to delete.' }
    try {
      await this.deleteJson(`/api/agents/${encodeURIComponent(id)}`)
      dbg('deleteOfficeAgent: deleted', id)
      return { ok: true }
    } catch (e) { return { error: String((e as Error)?.message ?? e) } }
  }

  /**
   * Lightweight reachability probe for a candidate Server URL, used by the
   * "Test connection" affordance BEFORE any credential is entered. Hits the
   * unauthenticated /api/csrf-token endpoint every pixel-office exposes; a 2xx
   * means the URL is a live office server. It NEVER sends or persists a
   * credential and NEVER mutates this client's own base/session, so probing an
   * arbitrary URL can't disturb a live login.
   */
  async ping(baseUrl: string): Promise<{ ok: true } | { error: string }> {
    const b = (baseUrl || '').trim().replace(/\/+$/, '')
    if (!b) return { error: 'Enter a Server URL first.' }
    let u: URL
    try { u = new URL(b) } catch { return { error: 'That doesn’t look like a URL.' } }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return { error: 'Server URL must start with http:// or https://' }
    }
    if (!isSecureBaseUrl(b)) {
      return { error: 'Server URL must use https:// (http is only allowed for localhost).' }
    }
    try {
      const r = await fetchT(`${b}/api/csrf-token`, { headers: { Accept: 'application/json' } }, 8000)
      if (r.ok) return { ok: true }
      return { error: `Server responded ${r.status} — is this a Pixel Office URL?` }
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) }
    }
  }

  /**
   * Fetch per-account provider key usage/limits from the connected pixel-office's
   * deployer credential vault. Reads GET /api/deployer/secrets (owner-scoped,
   * session-auth — the same endpoint the office's own credentials UI lists) and
   * maps each credential's cached `meta.usage` snapshot into the app's flat
   * KeyUsage shape. Supported providers today: Claude subscription OAuth (5h +
   * weekly windows), OpenRouter (credit), Copilot.
   *
   * Fails SOFT: any failure (not connected, deployer feature disabled, network,
   * 401) returns [] so the UI degrades instead of crashing.
   *
   * Freshness: /secrets returns the LAST-CACHED usage the deployer stored on each
   * secret (POST /secrets/{id}/usage is what refreshes it upstream). We only READ
   * here on purpose — a read-only poll must never trigger the savagely
   * rate-limited upstream provider usage calls.
   */
  async keyUsage(): Promise<KeyUsage[]> {
    if (!this._authed) return []
    try {
      const res = await this.getJson('/api/deployer/secrets')
      const list: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
      const out: KeyUsage[] = []
      for (const s of list) {
        const usage = s?.meta?.usage
        if (!usage || typeof usage !== 'object') continue
        const windows: any[] = Array.isArray(usage.windows) ? usage.windows : []
        // Nothing to render: no windows AND no soft error to surface.
        if (!windows.length && !usage.error) continue
        out.push({
          provider: String(usage.provider ?? s.kind ?? 'unknown'),
          label: typeof s.label === 'string' ? s.label : undefined,
          kind: typeof s.kind === 'string' ? s.kind : undefined,
          limits: windows.map((w) => ({
            label: String(w?.label ?? w?.key ?? 'Usage'),
            used: typeof w?.used === 'number' ? w.used : undefined,
            limit: typeof w?.limit === 'number' ? w.limit : undefined,
            resetAt: typeof w?.resets_at === 'string' ? w.resets_at : null,
            pct: typeof w?.pct === 'number' ? w.pct : undefined,
            severity: typeof w?.severity === 'string' ? w.severity : undefined
          })),
          expiresAt: typeof s.valid_until === 'string' ? s.valid_until : null,
          error: usage.error ?? null,
          unlimited: !!usage.unlimited
        })
      }
      return out
    } catch (e) {
      dbg('keyUsage: failed (degrading to empty)', String((e as Error)?.message ?? e))
      return []
    }
  }

  status(): { connected: boolean; base: string; email?: string } {
    const c = this.loadConfig()
    // Fallback resolves to the user-configured base (Settings page) when there is
    // no live/last-logged-in base, so both login forms default to it. `login()`/
    // `autoConnect()` are untouched — they use the form-supplied / last base.
    return { connected: this._authed, base: this.base || c?.baseUrl || getOfficeBaseUrl(), email: this._email || c?.email }
  }
}
