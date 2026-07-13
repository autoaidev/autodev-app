import { app } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'fs'
import { Jar } from './cookieJar'
import { resolveCliJs, nodeRunner } from './cli'

/** Concise main-process tracing for the pixel-office flow. Always on (low
 *  volume) so the "can't see my agents" path is diagnosable from app logs. */
function dbg(...a: unknown[]): void {
  console.log('[pixel-office]', ...a)
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

export class PixelOfficeClient {
  private jar = new Jar()
  private base = ''
  private _authed = false
  private _email = ''
  private readonly _cfg = join(app.getPath('userData'), 'pixel-office.json')

  private loadConfig(): Persisted | null {
    try { if (existsSync(this._cfg)) return JSON.parse(readFileSync(this._cfg, 'utf8')) } catch { /* */ }
    return null
  }
  private saveToken(): void {
    // The persisted cookie jar contains the durable `remember_web` token
    // (password-equivalent) — keep it owner-only. writeFileSync's mode only
    // applies on create, so chmod after every write to remediate pre-existing
    // world-readable files too.
    try {
      writeFileSync(this._cfg, JSON.stringify({ baseUrl: this.base, email: this._email, cookies: this.jar.dump() }, null, 2), { mode: 0o600 })
      try { chmodSync(this._cfg, 0o600) } catch { /* best effort */ }
    } catch { /* */ }
  }

  async login(baseUrl: string, email: string, password: string): Promise<{ ok: true; user: unknown } | { error: string }> {
    this.base = baseUrl.replace(/\/+$/, '')
    this.jar = new Jar()
    this._authed = false
    this._email = email
    try {
      const r1 = await fetch(`${this.base}/api/csrf-token`, { headers: { Accept: 'application/json' } })
      this.jar.store(r1)
      const r2 = await fetch(`${this.base}/api/auth/login`, {
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
    this.base = c.baseUrl
    this._email = c.email
    this.jar = new Jar()
    this.jar.load(c.cookies)
    try {
      const r = await fetch(`${this.base}/api/auth/me`, { headers: { Accept: 'application/json', Cookie: this.jar.header() } })
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
  }

  private async getJson(path: string): Promise<any> {
    const r = await fetch(`${this.base}${path}`, { headers: { Accept: 'application/json', Cookie: this.jar.header() } })
    if (r.status === 401) { this._authed = false; throw new Error('Session expired — reconnect.') }
    if (!r.ok) throw new Error(`${path} → ${r.status}`)
    return r.json()
  }

  private async postJson(path: string, body: unknown): Promise<any> {
    const r = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': this.jar.xsrf(), Cookie: this.jar.header() },
      body: JSON.stringify(body)
    })
    this.jar.store(r)
    if (r.status === 401) { this._authed = false; throw new Error('Session expired — reconnect.') }
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
      const url = (creds.mcpUrl as string) || `${this.base}/api/office-mcp`
      if (!key) return { error: 'No API key returned for this agent — it may lack office-MCP access.' }
      const dir = join(homedir(), '.autodev-app', 'offices', officeSlug, agentSlug || agentId)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeMcpJson(dir, key, url)
      dbg('operate: wired', agentSlug || agentId, '→', url, 'cwd', dir)
      return { ok: true, cwd: dir, mcpUrl: url }
    } catch (e) { dbg('operate error', e); return { error: String((e as Error)?.message ?? e) } }
  }

  /** Create a character for a Claude session and wire its folder to the office,
   *  so resuming the session runs it live as that character. */
  async connectSession(officeSlug: string, officeId: number, cwd: string, sessionId: string, name: string): Promise<{ ok: true; cwd: string; sessionId: string; agentSlug: string; agentName: string } | { error: string }> {
    void officeSlug // kept for IPC signature symmetry with operate()
    try {
      const nm = (name || 'session').replace(/[^\w .-]+/g, '').slice(0, 20) || 'session'
      const created = await this.postJson('/api/agents', { name: nm, officeId, avatarIndex: 0, color: '#00d4ff', emoji: '🎬' })
      const d = created?.data ?? created
      const key = d?.apiKey as string | undefined
      const slug = (d?.slug as string) || nm
      if (!key) return { error: 'Agent created but no API key returned.' }
      const url = `${this.base}/api/office-mcp`
      mkdirSync(cwd, { recursive: true })
      writeMcpJson(cwd, key, url)
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
