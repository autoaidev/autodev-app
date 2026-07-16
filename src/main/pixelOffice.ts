import { app, safeStorage } from 'electron'
import { join, resolve, sep } from 'path'
import { homedir } from 'os'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, chmodSync, unlinkSync, renameSync, rmSync } from 'fs'
import { Jar } from './cookieJar'
import { resolveCliJs, nodeRunner } from './cli'
import { isValidSessionId, safeSeg, safeMcpUrl, isSecureBaseUrl } from './officeSanitize'
import { humanizeFetchError } from './netError'

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
}
interface Persisted { baseUrl: string; email: string; cookies: [string, string][] }

export const DEFAULT_OFFICE_BASE = 'https://autodev.code.aioffice.works'

/**
 * Build the `.mcp.json` "pixel-office" stdio server entry. Prefer the CLI that
 * ships WITH the app (resolveCliJs → bundled/pinned vendor copy) run under the
 * same node the app uses for the agent loop, so a spawned `claude` session does
 * NOT fetch-and-run the latest `autodev-cli` from the public npm registry at
 * spawn time (supply-chain + offline + flaky-network hazard). Falls back to
 * `npx` only when no bundled CLI is found (strictly no worse than before).
 */
function officeMcpServer(key: string, url: string): Record<string, unknown> {
  const cli = resolveCliJs()
  if (cli) {
    const { cmd, baseEnv } = nodeRunner()
    const env: Record<string, string> = { NODE_NO_WARNINGS: '1' }
    // When the app falls back to Electron's own node, the child must be told to
    // run as node (matches AgentManager.start()'s proven prod behaviour).
    if (baseEnv.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = '1'
    return { type: 'stdio', command: cmd, args: [cli, 'mcp-operate', '--key', key, '--url', url], env }
  }
  return { type: 'stdio', command: 'npx', args: ['-y', 'autodev-cli', 'mcp-operate', '--key', key, '--url', url] }
}

/** Write a `.mcp.json` owner-only (0600) — it carries a live office API key. */
function writeMcpJson(dir: string, key: string, url: string): void {
  const file = join(dir, '.mcp.json')
  writeFileSync(file, JSON.stringify({ mcpServers: { 'pixel-office': officeMcpServer(key, url) } }, null, 2), { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* best effort */ }
}

/**
 * Merge the `pixel-office` server into an EXISTING `<dir>/.mcp.json` without
 * discarding any servers the user already configured. Used for connectSession,
 * which wires the user's REAL project cwd (not an app-owned scratch dir) — a
 * blind overwrite there would clobber the user's own MCP config. Kept 0600 since
 * the merged file still carries the live office API key.
 */
function mergeMcpJson(dir: string, key: string, url: string): void {
  const file = join(dir, '.mcp.json')
  let root: Record<string, any> = {}
  try { const p = JSON.parse(readFileSync(file, 'utf8')); if (p && typeof p === 'object') root = p } catch { /* none/invalid → start fresh */ }
  if (!root.mcpServers || typeof root.mcpServers !== 'object') root.mcpServers = {}
  root.mcpServers['pixel-office'] = officeMcpServer(key, url)
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
        if (root && root.mcpServers && typeof root.mcpServers === 'object' && root.mcpServers['pixel-office']) {
          delete root.mcpServers['pixel-office']
          const onlyOurs = Object.keys(root.mcpServers).length === 0 && Object.keys(root).length === 1
          if (onlyOurs) {
            // The file only ever held our key-bearing server — remove it entirely.
            try { unlinkSync(mcp) } catch { /* */ }
          } else {
            writeFileSync(mcp, JSON.stringify(root, null, 2), { mode: 0o600 })
            try { chmodSync(mcp, 0o600) } catch { /* */ }
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
        if (Array.isArray(s.enabledMcpjsonServers) && s.enabledMcpjsonServers.includes('pixel-office')) {
          s.enabledMcpjsonServers = s.enabledMcpjsonServers.filter((x: string) => x !== 'pixel-office'); changed = true
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

  /** The user's offices (for the connect-session picker). */
  async offices(): Promise<Array<{ slug: string; id: number; name: string }>> {
    if (!this._authed) throw new Error('Not connected to a pixel-office.')
    const list = (await this.getJson('/api/offices'))?.data?.offices ?? []
    return list.map((o: any) => ({ slug: o.slug, id: o.id, name: o.name }))
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
          out.push({ office: o.name, officeSlug: o.slug, id: a.id, name: a.name, slug: a.slug, status: a.status, online: !!(a.isConnected ?? a.online) })
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

  async operate(officeSlug: string, agentId: string, agentSlug: string): Promise<{ ok: true; cwd: string; mcpUrl: string } | { error: string }> {
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
      writeMcpJson(dir, key, url)
      writeMcpTrust(dir) // auto-approve the office-MCP server so it actually starts
      markFolderTrusted(dir) // pre-accept the folder-trust dialog for this app-owned dir
      this.recordProvisioned(dir) // track for key-purge on logout
      dbg('operate: wired', agentSlug || agentId, '→', url, 'cwd', dir)
      return { ok: true, cwd: dir, mcpUrl: url }
    } catch (e) { dbg('operate error', e); return { error: String((e as Error)?.message ?? e) } }
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

  /** AI-generate a complementary team of agents for an office (Kimi via ollama). */
  async generateTeam(officeId: number, prompt: string, count: number): Promise<{ ok: true; agents: Array<{ name: string; role?: string; emoji: string; color: string }> } | { error: string }> {
    if (!this._authed) return { error: 'Not connected to a pixel-office.' }
    try {
      const r = await this.postJson('/api/agents/generate', { officeId, prompt, count })
      const agents = (r?.data?.agents ?? r?.agents ?? []) as Array<{ name: string; role?: string; emoji: string; color: string }>
      return { ok: true, agents }
    } catch (e) { return { error: String((e as Error)?.message ?? e) } }
  }

  status(): { connected: boolean; base: string; email?: string } {
    const c = this.loadConfig()
    return { connected: this._authed, base: this.base || c?.baseUrl || DEFAULT_OFFICE_BASE, email: this._email || c?.email }
  }
}
