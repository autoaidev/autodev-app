import { spawn, execFile, ChildProcess } from 'child_process'
import { augmentPath } from './spawnEnv'
import { EventEmitter } from 'events'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, openSync, readSync, closeSync, watch, FSWatcher, readdirSync, readlinkSync, realpathSync, rmSync } from 'fs'
import { join, basename, dirname, resolve, sep, delimiter as pathDelimiter } from 'path'
import { homedir } from 'os'
import { app } from 'electron'
import { resolveCliJs, nodeRunner } from './cli'

// A truthful agent status. Beyond the naive working/idle/stopped, an autonomous
// run can be: STALLED (no hook activity for minutes — a hang, e.g. a dead grok
// token or a wedged tool), CRASHED (StopFailure / non-zero exit — a real failure,
// NOT a clean stop), NEEDS-AUTH (provider login expired, loop paused for re-auth),
// or RATE-LIMITED (provider throttled, loop paused until the window clears). These
// all used to paint as a healthy "working"/"idle"; the CLI already emits the
// signals, we just have to read them.
export type Activity = 'working' | 'idle' | 'stopped' | 'stalled' | 'needs-auth' | 'rate-limited' | 'crashed'

export interface McpServerStatus {
  name: string
  kind: 'remote' | 'stdio'
  detail: string   // remote host or stdio command line — never secrets
  builtin: boolean
  enabled: boolean
  status: 'connected' | 'unreachable' | 'ready' | 'missing' | 'disabled'
  latencyMs?: number
  error?: string
}

/** True if a bare runner (no path separators) resolves on PATH, or an explicit
 *  path exists. Synchronous PATH scan — no subprocess, no side effects.
 *
 *  Two adjustments so the check reflects what AGENTS actually see, not the app's
 *  bare GUI-launch PATH:
 *   - `autodev`: the app BUNDLES the CLI (resources/autodev-cli) and runs every
 *     loop through it, so the pixel-office MCP runner is always available even
 *     when `autodev` was never `npm i -g`'d onto the system PATH. A packaged app
 *     launched from a desktop icon has a minimal PATH and would otherwise report
 *     the office MCP as "missing runner" while it demonstrably works.
 *   - scan the AUGMENTED PATH (adds ~/.grok/bin, ~/.local/bin) — the same PATH the
 *     loop is spawned with — so `grok` and user-local installs resolve too. */
function runnerOnPath(cmd: string): boolean {
  if (!cmd) return false
  if (cmd.includes('/') || cmd.includes('\\')) { try { return existsSync(cmd) } catch { return false } }
  if (cmd === 'autodev' && resolveCliJs()) return true
  const dirs = augmentPath(process.env.PATH).split(pathDelimiter).filter(Boolean)
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const d of dirs) {
    for (const ext of exts) {
      try { if (existsSync(join(d, cmd + ext)) || existsSync(join(d, cmd + ext.toLowerCase()))) return true } catch { /* ignore */ }
    }
  }
  return false
}

/** MCP `initialize` handshake against a remote (http/sse) endpoint. A 200 means
 *  the server is reachable and speaking MCP; timeouts/other codes = unreachable. */
async function probeRemoteMcp(url: string, headers: Record<string, string>): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const f = (globalThis as any).fetch as typeof fetch | undefined
  if (!f) return { ok: false, error: 'fetch unavailable' }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'autodev-app', version: '1' } } })
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 6000)
  const t0 = Date.now()
  try {
    const r = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body, signal: ctl.signal })
    const latencyMs = Date.now() - t0
    if (r.ok) return { ok: true, latencyMs }
    return { ok: false, latencyMs, error: `HTTP ${r.status}` }
  } catch (e: any) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message ?? 'network error') }
  } finally { clearTimeout(timer) }
}

export interface AgentState {
  path: string
  name: string
  provider?: string
  sessionName?: string
  wsUrl?: string
  running: boolean
  /** The loop running this workspace was started OUTSIDE this app — an external
   *  `autodev start` (CLI / another manager) matched by cwd, or (with no local
   *  loop) a character kept online in the office by a remote VM / mcp-operate
   *  bridge. The app must not spawn a duplicate or surface a stale local
   *  'crashed' for these — the live external loop supersedes it. */
  external?: boolean
  /** Connected as a live character in the pixel office (presence WS open) — true
   *  even when this app can see no LOCAL loop (e.g. an mcp-operate bridge or a
   *  loop running on a remote VM keeps the office character online). */
  online?: boolean
  activity: Activity
  tasks: { total: number; remaining: number; done: number }
  currentTask?: string
  lastOutput?: string
  error?: string
  /** Last child exit code when the loop stopped (non-zero ⇒ crashed). */
  exitCode?: number | null
  /** The office character's ENDPOINT/agent slug, parsed from the wsUrl
   *  `endpoint=<slug>` param — the ref the app uses to fetch its office chat. */
  officeAgentSlug?: string
  /** The office SLUG this character belongs to, resolved from the office
   *  presence poll (undefined until the office has been listed). A hint for the
   *  chat fetch; the fetch also scans offices when this is absent. */
  officeSlug?: string
  /** The numeric-ish office agent id, resolved from the presence poll. */
  officeAgentId?: string
  /** The office character's inline pixel-art sprite (`data:image/png…`), resolved
   *  from the presence poll — present only while the character is office-online, so
   *  the rail/fleet/detail can show its real face instead of the initials monogram. */
  officeAvatarUrl?: string
  /** The office character's identity color (e.g. '#00d4ff'), from the presence poll. */
  officeColor?: string
}

const WORKING_EVENTS = new Set(['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStatus', 'Notification'])
// Clean turn/session boundaries — the agent finished this turn, not a failure.
const CLEAN_IDLE_EVENTS = new Set(['SessionEnd', 'Stop', 'session.idle'])
const CLEAN_IDLE_ETYPES = new Set(['session_end', 'loop_complete', 'all_tasks_done', 'session.idle'])
// A run that FAILED (watchdog kill / crash) — distinct from a clean stop.
const FAILURE_EVENTS = new Set(['StopFailure'])
const WORKING_ETYPES = new Set(['notification', 'agent_message', 'tool_start', 'task_start', 'task_progress'])
// A 'working' agent whose hooks file has been silent this long is hung/stalled.
const STALE_MS = 4 * 60 * 1000

/**
 * Manages a registry of agent workspaces: persists the list, reads each agent's
 * state from its `.autodev/*` files, and starts/stops the autonomous loop by
 * spawning the `autodev` CLI as a child process (one per running agent).
 */
export class AgentManager extends EventEmitter {
  private _paths: string[] = []
  private _procs = new Map<string, ChildProcess>()
  private _watchers = new Map<string, FSWatcher>()
  /** Last child exit code per path (set on exit; non-zero ⇒ crashed). */
  private _lastExit = new Map<string, number | null>()
  /** State detected from the live stdout stream (reauth / rate-limit pauses). */
  private _streamState = new Map<string, { activity: Activity; error: string }>()
  /**
   * Office presence, keyed by BOTH the office-agent slug and its id (either can
   * match a workspace). Pushed by the main process from the pixel-office
   * `listAgents` poll (setOfficeOnline). Lets readState() reflect an agent that
   * is ONLINE in the office but has no locally-detected `autodev start` loop —
   * e.g. an mcp-operate bridge or a loop on a remote VM — instead of falsely
   * painting it "Stopped". Empty when no office is connected (⇒ purely local truth).
   */
  private _officeOnline = new Map<string, { online: boolean; status?: string; officeSlug?: string; agentId?: string }>()
  private readonly _registryFile = join(app.getPath('userData'), 'agents.json')

  /**
   * Recognise the CLI's distinct pause/failure markers in a stdout line. These
   * pauses (reauth, rate-limit) are taskLoop-level, so they surface on the child
   * stream — not in hooks-events.jsonl. Returns the new state, 'clear' when the
   * loop announces it resumed, or null for an ordinary line.
   */
  private _detectStreamState(line: string): { activity: Activity; error: string } | 'clear' | null {
    if (/🔑 Authentication required|pausing loop until re-auth/i.test(line)) {
      return { activity: 'needs-auth', error: 'Provider login expired — re-authenticate to resume.' }
    }
    if (/⏸ Rate limit hit|⏩ Rate limit on/i.test(line)) {
      return { activity: 'rate-limited', error: 'Rate-limited by the provider — auto-resumes when the window clears.' }
    }
    if (/received — resuming paused loop|Rate limit period ended|Rate limit timer expired|resuming loop automatically/i.test(line)) {
      return 'clear'
    }
    return null
  }

  constructor() {
    super()
    this._load()
  }

  // --- registry ------------------------------------------------------------
  private _load(): void {
    try {
      if (existsSync(this._registryFile)) {
        const data = JSON.parse(readFileSync(this._registryFile, 'utf8'))
        if (Array.isArray(data?.paths)) this._paths = data.paths.filter((p: unknown) => typeof p === 'string')
      }
    } catch { /* start empty */ }
  }

  private _save(): void {
    try {
      mkdirSync(dirname(this._registryFile), { recursive: true })
      writeFileSync(this._registryFile, JSON.stringify({ paths: this._paths }, null, 2), 'utf8')
    } catch { /* ignore */ }
  }

  list(): AgentState[] {
    return this._paths.map((p) => this.readState(p))
  }

  add(path: string): AgentState | { error: string } {
    if (!existsSync(join(path, '.autodev', 'settings.json')) && !existsSync(join(path, 'TODO.md'))) {
      return { error: 'Not an AutoDev workspace (no .autodev/settings.json or TODO.md). Use "Create agent" to init one.' }
    }
    if (!this._paths.includes(path)) {
      this._paths.push(path)
      this._save()
      this._watch(path)
    }
    return this.readState(path)
  }

  /**
   * Probe a folder before "Create agent": if it already has a
   * `.autodev/settings.json`, it's an existing agent — the caller must NOT
   * re-init it (that clobbers its provider/office binding), just connect it.
   */
  workspaceInfo(path: string): { exists: boolean; provider?: string; sessionName?: string } {
    const s = this._readJson(join(path, '.autodev', 'settings.json'))
    if (!s) return { exists: false }
    return { exists: true, provider: s.provider, sessionName: s.sessionName }
  }

  remove(path: string): void {
    this.stop(path)
    this._paths = this._paths.filter((p) => p !== path)
    this._unwatch(path)
    this._save()
    this.emit('changed')
  }

  /**
   * Remove a workspace from the registry AND delete its folder from disk. Heavily
   * guarded so a stray/hostile path can never wipe an arbitrary directory:
   *   - refuses `/`, the home dir, and any shallow (< 2 segment) top-level path;
   *   - only deletes a path that IS a registered workspace OR plainly looks like
   *     one (contains a `.autodev` dir).
   * Unregisters first (which stops the loop + drops watchers), then rms the tree.
   */
  removeFolder(path: string): { ok: true } | { error: string } {
    const p = String(path ?? '').trim()
    if (!p) return { error: 'No path.' }
    const resolved = resolve(p)
    const forbidden = new Set([resolve('/'), resolve(homedir())])
    if (resolved === '/' || forbidden.has(resolved) || resolved.split(sep).filter(Boolean).length < 2) {
      return { error: 'Refusing to delete a filesystem or home root.' }
    }
    const registered = this._paths.includes(p)
    const looksLikeWorkspace = existsSync(join(p, '.autodev'))
    if (!registered && !looksLikeWorkspace) {
      return { error: 'Refusing to delete a folder that is not a registered AutoDev workspace.' }
    }
    // Unregister first so the loop is stopped and watchers are torn down before rm.
    this.remove(p)
    try {
      rmSync(p, { recursive: true, force: true })
      return { ok: true }
    } catch (e: any) {
      return { error: e?.message ?? 'Failed to delete the workspace folder.' }
    }
  }

  // A loop can be running for a workspace WITHOUT this app having spawned it —
  // e.g. it survived an app restart, or was started from a terminal. Detect it by
  // matching /proc/<pid>/cwd to the workspace (same predicate the deployer uses),
  // so the app reflects reality instead of showing a live agent as "Stopped".
  // Linux-only (no /proc elsewhere) and cached briefly so readState stays cheap.
  private _extPidCache = new Map<string, { pid: number | null; at: number }>()
  /**
   * Attach-tail bookkeeping: the output file this app is currently streaming for
   * an EXTERNAL loop (one it did not spawn) and the byte offset already emitted.
   * Absence means "not attached" — the next tail seeds the Output pane, then only
   * appended bytes are streamed. Cleared when the loop stops or becomes our own
   * child (which streams via its own child.stdout instead).
   */
  private _extTail = new Map<string, { file: string; offset: number }>()
  /**
   * When stop() SIGINTs an external loop we record it here. A subsequent start()
   * for the same path within the window is a RESTART: the external loop is still
   * winding down, so start() force-kills it and waits for it to leave /proc before
   * re-scanning — otherwise it would see the dying pid and no-op ('alreadyRunning')
   * instead of taking the workspace over as its own child.
   */
  private _extStopping = new Map<string, number>()

  // ── Auto-restart-on-crash state ──────────────────────────────────────────
  // A spawned grok loop can exit abnormally (observed: code 130 / SIGINT right
  // after going idle) and then sits "Crashed" until the user clicks Restart —
  // which reliably brings it back. So do that automatically: on a CRASH exit
  // (non-zero, NOT a user stop, NOT app quit) re-`start()` the same loop, up to
  // MAX_CRASH_RETRIES times with a short backoff. A loop that stays healthy past
  // RETRY_RESET_MS earns its budget back, so only a fast crash-loop hits the cap.
  private static readonly MAX_CRASH_RETRIES = 3
  private static readonly RETRY_BACKOFF_MS = [2000, 4000, 8000]
  private static readonly RETRY_RESET_MS = 90_000
  private _spawnedAt = new Map<string, number>()
  private _crashRetries = new Map<string, number>()
  private _retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private _intentionalStop = new Set<string>()
  private _disposing = false

  private _externalPid(path: string): number | null {
    if (process.platform !== 'linux') return null
    const now = Date.now()
    const cached = this._extPidCache.get(path)
    if (cached && now - cached.at < 3000) return cached.pid
    const found = this._externalPids(path)[0] ?? null
    this._extPidCache.set(path, { pid: found, at: now })
    return found
  }

  /**
   * Every externally-started `autodev start` loop whose cwd IS this workspace.
   * Compares by realpath so a symlinked path (e.g. /home → /var/home) still
   * matches — a plain string compare there would miss the loop and make Stop a
   * silent no-op. Returns all matches so Stop can clear a duplicated loop too.
   */
  private _externalPids(path: string): number[] {
    if (process.platform !== 'linux') return []
    let target = path
    try { target = realpathSync(path) } catch { /* use raw */ }
    const pids: number[] = []
    try {
      for (const ent of readdirSync('/proc')) {
        if (!/^\d+$/.test(ent)) continue
        let cwd: string
        try { cwd = readlinkSync(`/proc/${ent}/cwd`) } catch { continue }
        let rcwd = cwd
        try { rcwd = realpathSync(cwd) } catch { /* use raw */ }
        if (cwd !== path && rcwd !== target) continue
        let cmd: string
        try { cmd = readFileSync(`/proc/${ent}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch { continue }
        if (/autodev/.test(cmd) && /\bstart\b/.test(cmd)) pids.push(parseInt(ent, 10))
      }
    } catch { /* /proc unreadable — treat as not running externally */ }
    return pids
  }

  /**
   * Push the latest pixel-office presence (from the main process's office
   * listAgents poll). Rebuilds the lookup keyed by slug AND id so a workspace can
   * be matched by whichever it carries. Returns whether anything actually changed
   * (so the caller can skip a redundant renderer refresh).
   */
  setOfficeOnline(entries: Array<{ slug?: string; id?: string; online: boolean; status?: string; officeSlug?: string; avatarUrl?: string; color?: string }>): boolean {
    const next = new Map<string, { online: boolean; status?: string; officeSlug?: string; agentId?: string; avatarUrl?: string; color?: string }>()
    for (const e of entries) {
      const v = { online: !!e.online, status: e.status, officeSlug: e.officeSlug, agentId: e.id, avatarUrl: e.avatarUrl, color: e.color }
      if (e.slug) next.set(String(e.slug).toLowerCase(), v)
      if (e.id) next.set(String(e.id).toLowerCase(), v)
    }
    // Cheap change-detection: same size + every key maps to the same online flag.
    let changed = next.size !== this._officeOnline.size
    if (!changed) {
      for (const [k, v] of next) {
        const prev = this._officeOnline.get(k)
        if (!prev || prev.online !== v.online || prev.status !== v.status) { changed = true; break }
      }
    }
    this._officeOnline = next
    return changed
  }

  /**
   * The office presence for a workspace, matched by the office endpoint slug
   * embedded in its wsUrl (`…&endpoint=<slug>`) or its settings `agentId`.
   * Undefined when no office is connected or this workspace isn't office-bound.
   */
  private _officePresence(wsUrl?: string, agentId?: string): { online: boolean; status?: string; officeSlug?: string; agentId?: string; avatarUrl?: string; color?: string } | undefined {
    if (this._officeOnline.size === 0) return undefined
    const slug = this._endpointSlug(wsUrl)
    return (slug ? this._officeOnline.get(slug.toLowerCase()) : undefined)
      ?? (agentId ? this._officeOnline.get(String(agentId).toLowerCase()) : undefined)
  }

  /** The office character's endpoint/agent slug from a wsUrl `endpoint=<slug>`. */
  private _endpointSlug(wsUrl?: string): string | undefined {
    if (!wsUrl) return undefined
    try { return new URL(wsUrl).searchParams.get('endpoint') ?? undefined }
    catch { const m = /[?&]endpoint=([^&]+)/.exec(wsUrl); return m ? decodeURIComponent(m[1]) : undefined }
  }

  // --- state reading -------------------------------------------------------
  readState(path: string): AgentState {
    const settings = this._readJson(join(path, '.autodev', 'settings.json')) ?? {}
    const todo = this._readTodoCounts(join(path, 'TODO.md'))
    const ownProc = this._procs.has(path)
    // "Running" is true when there's a LOCAL loop (our child or an external
    // `autodev start` matched by cwd) OR the character is live in the office. The
    // office branch catches agents kept online by something this app can't see
    // locally — an mcp-operate bridge or a loop on a remote VM.
    const externalPid = ownProc ? null : this._externalPid(path)
    const localRunning = ownProc || externalPid !== null
    const presence = this._officePresence(settings.wsUrl, settings.agentId)
    const officeOnline = !!presence?.online
    const running = localRunning || officeOnline
    // Running, but NOT by a child of ours: an external CLI loop owns the cwd, or
    // the character is only kept online remotely. Surface it as external so the UI
    // shows "running (external)" and we never treat a stale local crash as current.
    const external = !ownProc && (externalPid !== null || officeOnline)
    let activity: Activity
    let error: string | undefined
    let exitCode: number | null | undefined
    if (ownProc) {
      const ss = this._streamState.get(path)
      if (ss) {
        // A live reauth/rate-limit pause wins over the hooks read (the loop is
        // paused, so hooks look 'working' from the last pre-pause event).
        activity = ss.activity
        error = ss.error
      } else {
        activity = this._activityFromHooks(path)
        // An agent with NO remaining work (all tasks done) can't be "hung on a
        // task" — a quiet hooks file just means it finished and is idle-polling.
        // Only warn "stalled/hung" when there's actually work in flight.
        if (activity === 'stalled' && todo.remaining === 0) activity = 'idle'
        if (activity === 'crashed') error = 'The run reported a failure (StopFailure) — likely a crash or watchdog timeout.'
        else if (activity === 'stalled') error = 'No activity for several minutes — the agent may be hung (e.g. a dead token or a wedged tool).'
        else if (activity === 'needs-auth') error = 'Provider login expired — re-authenticate to resume.'
        else if (activity === 'rate-limited') error = 'Rate-limited by the provider — auto-resumes when the window clears.'
      }
    } else if (externalPid !== null) {
      // An external loop (CLI or another manager) owns this workspace and its pid
      // is ALIVE — so a 'crashed'/'stalled' left in the hooks file by a previous
      // (our own) loop is STALE and must not show as the current state. Honor only
      // a live auth/rate pause; otherwise reflect the office's own status, falling
      // back to the hooks' working/idle signal when the office isn't visible.
      const hookAct = this._activityFromHooks(path)
      if (hookAct === 'needs-auth') { activity = 'needs-auth'; error = 'Provider login expired — re-authenticate to resume.' }
      else if (hookAct === 'rate-limited') { activity = 'rate-limited'; error = 'Rate-limited by the provider — auto-resumes when the window clears.' }
      else if (officeOnline) activity = presence?.status === 'working' ? 'working' : 'idle'
      else activity = hookAct === 'working' ? 'working' : 'idle'
    } else if (officeOnline) {
      // Live in the office (presence WS open) but no local loop we can detect —
      // reflect the office's own status rather than a false "Stopped". The office
      // reports 'working' while the character is mid-turn, else it's idle-polling.
      activity = presence?.status === 'working' ? 'working' : 'idle'
    } else {
      exitCode = this._lastExit.get(path)
      if (typeof exitCode === 'number' && exitCode !== 0) {
        activity = 'crashed'
        error = `Loop exited with code ${exitCode}.`
      } else {
        activity = 'stopped'
      }
    }
    // ATTACH: stream an external loop's persisted output into the Output tab. Runs
    // on the same watch/poll cadence that produced this readState — never a second
    // poller. No-op for our own child (streams via child.stdout) and stopped agents.
    this._tailExternal(path, settings.provider, ownProc, running)
    return {
      path,
      name: settings.sessionName || basename(path),
      provider: settings.provider,
      sessionName: settings.sessionName,
      wsUrl: settings.wsUrl,
      running,
      online: officeOnline,
      activity,
      tasks: { total: todo.total, remaining: todo.remaining, done: todo.done },
      currentTask: todo.currentTask,
      lastOutput: this._latestOutput(path, settings.provider),
      error,
      exitCode,
      external,
      // Office chat identity: the endpoint slug is always derivable from the wsUrl;
      // the resolved office slug + agent id only once the office has been polled.
      officeAgentSlug: this._endpointSlug(settings.wsUrl) || (settings.agentId || undefined),
      officeSlug: presence?.officeSlug,
      officeAgentId: presence?.agentId,
      // Only carry the real avatar while the character is office-online (presence is
      // undefined when offline), so an offline agent falls back to the monogram.
      officeAvatarUrl: presence?.avatarUrl,
      officeColor: presence?.color
    }
  }

  private _readJson(file: string): any {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  }

  private _readTodoCounts(file: string): { total: number; remaining: number; done: number; currentTask?: string } {
    try {
      const t = readFileSync(file, 'utf8')
      const pending = (t.match(/^- \[ \]/gm) || []).length
      const inProgress = (t.match(/^- \[~\]/gm) || []).length
      const done = (t.match(/^- \[x\]/gim) || []).length
      // What the agent is actually on: prefer an in-progress [~] item, else the
      // next pending [ ] item — so the fleet view can answer "what's it doing?".
      const cur = (t.match(/^- \[~\] (.+)$/m) || [])[1] ?? (t.match(/^- \[ \] (.+)$/m) || [])[1]
      const currentTask = cur ? cur.trim().replace(/\s+/g, ' ').slice(0, 140) : undefined
      return { total: pending + inProgress + done, remaining: pending + inProgress, done, currentTask }
    } catch { return { total: 0, remaining: 0, done: 0 } }
  }

  private _activityFromHooks(path: string): Activity {
    try {
      const file = join(path, '.autodev', 'hooks-events.jsonl')
      if (!existsSync(file)) return 'working'
      // The jsonl is appended on every hook event, so its mtime is the last sign
      // of life. A 'working' verdict below is downgraded to 'stalled' when it's
      // gone quiet — catches hangs (dead token, wedged tool) the CLI can't self-report.
      const mtimeMs = statSync(file).mtimeMs
      const stale = () => Date.now() - mtimeMs > STALE_MS
      // hooks-events.jsonl is append-only and grows for the life of an autonomous
      // run; readState() reads it for every agent on the 5s poll + each watch
      // tick. Read only the last ~64KB (the newest IDLE/WORKING event is always
      // near the end) so the cost is constant regardless of file size.
      const TAIL = 64 * 1024
      const size = statSync(file).size
      let text: string
      if (size > TAIL) {
        const fd = openSync(file, 'r')
        try { const buf = Buffer.alloc(TAIL); readSync(fd, buf, 0, TAIL, size - TAIL); text = buf.toString('utf8') } finally { closeSync(fd) }
        const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1) // drop the partial first line
      } else {
        text = readFileSync(file, 'utf8')
      }
      const lines = text.trim().split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(lines[i])
          const name = ev.hook_event_name || ev.hook || ev.payload?.type || ev.type
          const et = ev.event_type || ev.event
          // Pause states first: a loop paused for auth/rate-limit emits these as
          // its LAST event (no further hooks until resume), so scanning newest-first
          // surfaces them. The next task_start on resume supersedes them.
          if (name === 'reauth_required' || et === 'reauth_required') return 'needs-auth'
          if (name === 'rate_limit' || et === 'rate_limit' || name === 'rate_limited' || et === 'rate_limited') return 'rate-limited'
          if (FAILURE_EVENTS.has(name) || et === 'stop_failure') return 'crashed'
          if (CLEAN_IDLE_EVENTS.has(name) || CLEAN_IDLE_ETYPES.has(et)) return 'idle'
          if (WORKING_EVENTS.has(name) || WORKING_ETYPES.has(et)) return stale() ? 'stalled' : 'working'
        } catch { /* skip */ }
      }
      return stale() ? 'stalled' : 'working'
    } catch { return 'working' }
  }

  /**
   * The CLI's current persisted-output file for a workspace: follow the
   * `<provider>.latest` pointer to `output/<provider>/<id>.txt`. grok-tui streams
   * a raw pane capture (`grok-tui/pane.raw`) instead of per-turn output files, so
   * fall back to that. Undefined until the loop has produced output. Shared by the
   * snapshot read (_latestOutput) and the live external tail (_tailExternal).
   */
  private _resolveOutputFile(path: string, provider?: string): string | undefined {
    if (!provider) return undefined
    try {
      const ptr = join(path, '.autodev', 'output', `${provider}.latest`)
      if (existsSync(ptr)) {
        const id = readFileSync(ptr, 'utf8').trim()
        const cand = join(path, '.autodev', 'output', provider, `${id}.txt`)
        if (existsSync(cand)) return cand
      }
      if (provider === 'grok-tui') {
        const pane = join(path, '.autodev', 'grok-tui', 'pane.raw')
        if (existsSync(pane)) return pane
      }
    } catch { /* ignore */ }
    return undefined
  }

  private _stripAnsi(s: string): string { return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') }

  /** Read bytes [start,end) of a file as UTF-8; '' on any error. */
  private _readSlice(file: string, start: number, end: number): string {
    const len = end - start
    if (len <= 0) return ''
    let fd: number | undefined
    try {
      fd = openSync(file, 'r')
      const buf = Buffer.alloc(len)
      const n = readSync(fd, buf, 0, len, start)
      return buf.toString('utf8', 0, n)
    } catch { return '' }
    finally { if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ } }
  }

  private _latestOutput(path: string, provider?: string): string | undefined {
    const outFile = this._resolveOutputFile(path, provider)
    if (!outFile) return undefined
    try {
      const raw = readFileSync(outFile, 'utf8')
      const clean = this._stripAnsi(raw)
      return clean.length > 4000 ? '…' + clean.slice(-4000) : clean
    } catch { return undefined }
  }

  /**
   * ATTACH: stream an EXTERNAL loop's persisted output into the same 'log' channel
   * the Output tab renders, so a loop this app did NOT spawn shows live output
   * instead of a blank pane. Driven from readState (the watch + 5s-poll cadence) —
   * NOT a second polling loop of its own. No-ops for our own child (it already
   * streams via child.stdout) and for a stopped agent, dropping the tail state in
   * both so a later external attach re-seeds. On first attach it seeds the pane
   * with the tail of the current file, then emits only newly-appended bytes; it
   * follows the `.latest` pointer to the next turn's file as ids roll over.
   */
  private _tailExternal(path: string, provider: string | undefined, ownProc: boolean, running: boolean): void {
    if (ownProc || !running) { this._extTail.delete(path); return }
    const file = this._resolveOutputFile(path, provider)
    if (!file) return
    let size: number
    try { size = statSync(file).size } catch { return }
    const prev = this._extTail.get(path)
    if (!prev) {
      // Fresh attach: seed with the tail of the current file so Output isn't blank,
      // then stream only appends after this point.
      const SEED = 8 * 1024
      const from = size > SEED ? size - SEED : 0
      let seed = this._readSlice(file, from, size)
      if (from > 0) seed = seed.replace(/^[^\n]*\n/, '') // drop the partial first line
      const clean = this._stripAnsi(seed)
      if (clean) this.emit('log', { path, line: clean })
      this._extTail.set(path, { file, offset: size })
      return
    }
    // A new turn rolled to a different output id, or the file was truncated in
    // place — restart from its top. Otherwise continue from the last offset.
    const offset = (prev.file !== file || size < prev.offset) ? 0 : prev.offset
    if (size > offset) {
      const clean = this._stripAnsi(this._readSlice(file, offset, size))
      if (clean) this.emit('log', { path, line: clean })
    }
    this._extTail.set(path, { file, offset: size })
  }

  // --- loop control --------------------------------------------------------
  async start(path: string, provider?: string, isRetry = false): Promise<{ ok: true; alreadyRunning?: boolean } | { error: string }> {
    // A fresh (manual / spawn-office) start clears the crash-retry budget and any
    // pending "user stopped this" marker; an auto-retry preserves the budget.
    this._intentionalStop.delete(path)
    const pendingRetry = this._retryTimers.get(path)
    if (pendingRetry) { clearTimeout(pendingRetry); this._retryTimers.delete(path) }
    if (!isRetry) this._crashRetries.delete(path)
    // Already running — our own child OR an external loop for this workspace.
    // The external check makes "Start all" a no-op for live agents instead of
    // spawning a duplicate loop that fights the first for the same office slug.
    // Bypass the 3s _externalPid cache here (delete then re-scan): a loop the user
    // just started elsewhere — a terminal `autodev start` or this app's own
    // survivor from a prior session — may not have been in the cached scan, and a
    // stale "not running" would let this spawn a duplicate. `alreadyRunning` lets
    // the UI say so instead of silently no-op'ing.
    this._extPidCache.delete(path)
    if (this._procs.has(path)) return { ok: true, alreadyRunning: true }
    // RESTART takeover: the renderer's restart is stop()+start(). stop() SIGINTs the
    // external loop but it takes a moment to wind its provider down, so at start()
    // time its pid is often still alive — which would no-op here as 'alreadyRunning'
    // and never let this app re-own the loop. When we JUST stopped this path, force
    // the lingering loop dead and wait for it to leave /proc before re-scanning, so
    // the restart reliably takes over as our own child. (A pid we did NOT just stop
    // is a genuine live external loop — leave the 'alreadyRunning' guard intact.)
    if (this._externalPid(path) !== null && this._recentlyStopped(path)) {
      await this._killExternalAndWait(path)
    }
    this._extPidCache.delete(path)
    if (this._externalPid(path) !== null) return { ok: true, alreadyRunning: true }
    this._extStopping.delete(path)
    const cliJs = resolveCliJs()
    if (!cliJs) return { error: 'autodev CLI not found. Set AUTODEV_CLI_JS or place autodev-cli beside the app.' }
    const { cmd, baseEnv } = nodeRunner()
    const args = [cliJs, 'start', path]
    if (provider) args.push('-p', provider)
    // Fresh start clears any prior crash/pause state so a restart reads clean.
    this._lastExit.delete(path)
    this._streamState.delete(path)
    // AUTODEV_EXIT_WITH_PARENT: the loop watches this process and exits if the app
    // dies, so closing/crashing the app never leaves a stale loop (+ its provider
    // subprocess) running. disposeAll() still SIGKILLs them on a clean quit; this
    // is the backstop for force-quit / crash where disposeAll can't run.
    const child = spawn(cmd, args, { cwd: path, env: { ...baseEnv, AUTODEV_EXIT_WITH_PARENT: '1', PATH: augmentPath((baseEnv as Record<string, string>).PATH ?? process.env.PATH) }, stdio: ['ignore', 'pipe', 'pipe'] })
    this._procs.set(path, child)
    this._spawnedAt.set(path, Date.now())
    const onData = (buf: Buffer) => {
      const s = buf.toString('utf8')
      this.emit('log', { path, line: s })
      // reauth / rate-limit pauses are taskLoop-level — they surface here, not in
      // hooks-events.jsonl — so scan the stream for the CLI's distinct markers.
      for (const line of s.split('\n')) {
        const d = this._detectStreamState(line)
        if (d === 'clear') { if (this._streamState.delete(path)) this.emit('agentUpdated', this.readState(path)) }
        else if (d) { this._streamState.set(path, d); this.emit('agentUpdated', this.readState(path)) }
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', (code) => {
      this._procs.delete(path)
      this._streamState.delete(path)
      this._lastExit.set(path, code)
      this.emit('log', { path, line: `\n[loop exited code=${code ?? '?'}]\n` })
      this.emit('changed')
      this._maybeAutoRestart(path, provider, code)
    })
    // Without this, an async spawn failure (e.g. ENOENT: the cwd was deleted, or
    // the node/cli binary is missing) emits 'error' with no 'exit' — the child
    // stays in _procs so the agent shows a stuck "running", and the unhandled
    // 'error' can crash the main process. Surface it and clear the entry.
    child.on('error', (err) => {
      this._procs.delete(path)
      this._streamState.delete(path)
      this._lastExit.set(path, 1)
      this.emit('log', { path, line: `\n[failed to start: ${err.message}]\n` })
      this.emit('changed')
    })
    this._watch(path)
    this.emit('changed')
    return { ok: true }
  }

  /**
   * Auto-restart a loop that CRASHED — not one the user stopped and not on app
   * quit. Budget of MAX_CRASH_RETRIES, replenished once a loop stays healthy past
   * RETRY_RESET_MS, so a stable loop that dies hours later still gets fresh tries
   * while a spawn-time crash-loop stops after 3 and waits for a manual Restart.
   */
  private _maybeAutoRestart(path: string, provider: string | undefined, code: number | null): void {
    if (this._disposing || this._intentionalStop.has(path)) { this._intentionalStop.delete(path); return }
    if (code === 0) { this._crashRetries.delete(path); return }   // clean end — not a crash

    const ranMs = Date.now() - (this._spawnedAt.get(path) ?? Date.now())
    if (ranMs > AgentManager.RETRY_RESET_MS) this._crashRetries.delete(path)

    const n = this._crashRetries.get(path) ?? 0
    if (n >= AgentManager.MAX_CRASH_RETRIES) {
      this.emit('log', { path, line: `\n[auto-restart: gave up after ${AgentManager.MAX_CRASH_RETRIES} attempts — click Restart to try again]\n` })
      return
    }
    this._crashRetries.set(path, n + 1)
    const delay = AgentManager.RETRY_BACKOFF_MS[n] ?? 8000
    this.emit('log', { path, line: `\n[auto-restart ${n + 1}/${AgentManager.MAX_CRASH_RETRIES} after crash (code=${code ?? '?'}) in ${Math.round(delay / 1000)}s…]\n` })
    const t = setTimeout(() => {
      this._retryTimers.delete(path)
      // Something changed while we waited — don't step on it.
      if (this._procs.has(path) || this._intentionalStop.has(path) || this._disposing) return
      if (this._externalPid(path) !== null) return   // a loop for this path is live elsewhere now
      void this.start(path, provider, true)
    }, delay)
    t.unref?.()
    this._retryTimers.set(path, t)
  }

  stop(path: string): void {
    // Mark as a deliberate stop so the exit handler doesn't auto-restart it, and
    // cancel any pending retry from an earlier crash.
    this._intentionalStop.add(path)
    const pending = this._retryTimers.get(path)
    if (pending) { clearTimeout(pending); this._retryTimers.delete(path) }
    this._crashRetries.delete(path)
    const child = this._procs.get(path)
    if (child) {
      try { child.kill('SIGINT') } catch { /* ignore */ }
      // hard-kill fallback
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 4000).unref()
      return
    }
    // No child of ours — stop every externally-started loop for this workspace
    // (there can be more than one after a messy restart) by pid: SIGINT for a
    // graceful provider shutdown, SIGKILL as a fallback.
    const pids = this._externalPids(path)
    this._extPidCache.delete(path)
    // Mark the path so an immediately-following start() (a restart) knows this
    // external loop is being torn down and force-kills any lingering pid instead
    // of no-op'ing on it. Cleared once a fresh loop actually spawns.
    if (pids.length) this._extStopping.set(path, Date.now())
    for (const pid of pids) {
      this.emit('log', { path, line: `\n[stopping external loop pid=${pid}]\n` })
      try { process.kill(pid, 'SIGINT') } catch { /* ignore */ }
      setTimeout(() => { try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ } }, 4000).unref()
    }
  }

  /** True if stop() SIGINTed an external loop for this path in the last 15s. */
  private _recentlyStopped(path: string): boolean {
    const t = this._extStopping.get(path)
    return t !== undefined && Date.now() - t < 15000
  }

  /**
   * Force every external loop for a path dead (SIGKILL) and wait — up to 3s,
   * re-scanning /proc every 50ms — for the pids to disappear, so a restart's
   * start() re-scan takes over instead of seeing the dying pid. Bypasses the
   * _externalPid cache on each check so it sees the process actually leave.
   */
  private async _killExternalAndWait(path: string): Promise<void> {
    for (const pid of this._externalPids(path)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      this._extPidCache.delete(path)
      if (this._externalPids(path).length === 0) return
      await new Promise((r) => setTimeout(r, 50))
    }
    this._extPidCache.delete(path)
  }

  isRunning(path: string): boolean { return this._procs.has(path) || this._externalPid(path) !== null }

  /**
   * Send a message/task to the agent by appending it as a pending task to
   * TODO.md. A running loop picks it up on its next poll; a stopped agent acts
   * on it the next time it's started. (A task is a single `- [ ] …` line.)
   */
  sendMessage(path: string, text: string): { ok: true } | { error: string } {
    const msg = String(text ?? '').replace(/\r?\n+/g, ' ').trim()
    if (!msg) return { error: 'Message is empty.' }
    if (!existsSync(join(path, '.autodev', 'settings.json')) && !existsSync(join(path, 'TODO.md'))) {
      return { error: 'Not an AutoDev workspace.' }
    }
    const todoPath = join(path, 'TODO.md')
    try {
      // Atomic O_APPEND write: the running CLI loop concurrently rewrites TODO.md
      // (checking tasks off). A read-modify-write here would interleave with that
      // rewrite and could drop the queued line or resurrect a done task — so we
      // only ever append, which the loop's full rewrites can't clobber and which
      // can't clobber the loop's rewrites.
      const line = `- [ ] ${msg}\n`
      appendFileSync(todoPath, existsSync(todoPath) ? line : `# TODO\n\n## Tasks\n${line}`, 'utf8')
      // Refresh the UI's task counts. NOTE: index.ts bridges the 'agentUpdated'
      // event (see _watch); a colon-form name would have no listener and the
      // instant refresh would silently never fire (only the 5s poll would catch
      // up). Keep this name in sync with the watcher emit below.
      try { this.emit('agentUpdated', this.readState(path)) } catch { /* ignore */ }
      return { ok: true }
    } catch (e: any) {
      return { error: e?.message ?? 'Failed to write TODO.md' }
    }
  }

  /** Read the workspace's .mcp.json (raw) for editing. */
  readMcp(path: string): { content: string } | { error: string } {
    try {
      const p = join(path, '.mcp.json')
      return { content: existsSync(p) ? readFileSync(p, 'utf8') : '{\n  "mcpServers": {}\n}\n' }
    } catch (e: any) { return { error: e?.message ?? 'Failed to read .mcp.json' } }
  }

  /** Write the workspace's .mcp.json (validates JSON first). Restart to apply. */
  writeMcp(path: string, content: string): { ok: true } | { error: string } {
    try { JSON.parse(content) } catch (e: any) { return { error: 'Invalid JSON: ' + (e?.message ?? '') } }
    try {
      writeFileSync(join(path, '.mcp.json'), content, 'utf8')
      return { ok: true }
    } catch (e: any) { return { error: e?.message ?? 'Failed to write .mcp.json' } }
  }

  /**
   * Parse the workspace's effective MCP servers (.mcp.json — the CLI writes the
   * office A2A server and built-ins here alongside user entries) and probe each
   * for LIVE connectivity, so the app can show whether an agent's MCP wiring
   * actually works, not just what's configured:
   *   - remote (http/sse, has `url`): POST an MCP `initialize` handshake with the
   *     configured headers; a 200 = connected, anything else = unreachable.
   *   - stdio (has `command`): the runner is resolved from PATH = ready, else
   *     missing (the server would fail to spawn).
   * Never returns secrets — only names/kind/host-or-command/status.
   */
  async mcpStatus(path: string): Promise<{ servers: McpServerStatus[] } | { error: string }> {
    let cfg: { mcpServers?: Record<string, any> }
    try {
      const p = join(path, '.mcp.json')
      cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
    } catch (e: any) { return { error: e?.message ?? 'Failed to read .mcp.json' } }

    const entries = Object.entries(cfg.mcpServers ?? {})
    const servers = await Promise.all(entries.map(async ([name, e]: [string, any]): Promise<McpServerStatus> => {
      const remote = typeof e?.url === 'string' && e.url.length > 0
      const enabled = e?.enabled !== false
      const builtin = e?._meta?.kind === 'builtin'
      let detail = ''
      if (remote) { try { detail = new URL(e.url).host } catch { detail = '' } }
      else if (e?.command) { detail = [e.command, ...(e.args ?? [])].join(' ') }

      if (!enabled) return { name, kind: remote ? 'remote' : 'stdio', detail, builtin, enabled, status: 'disabled' }
      if (remote) {
        const r = await probeRemoteMcp(e.url, e.headers ?? {})
        return { name, kind: 'remote', detail, builtin, enabled, status: r.ok ? 'connected' : 'unreachable', latencyMs: r.latencyMs, error: r.error }
      }
      const ok = e?.command ? runnerOnPath(e.command) : false
      return { name, kind: 'stdio', detail, builtin, enabled, status: ok ? 'ready' : 'missing', error: ok ? undefined : `runner '${e?.command ?? '?'}' not on PATH` }
    }))
    servers.sort((a, b) => a.name.localeCompare(b.name))
    return { servers }
  }

  // --- CLI passthrough (init/config/connect/export/import/status) ----------
  runCli(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      const cliJs = resolveCliJs()
      if (!cliJs) return resolve({ stdout: '', stderr: 'autodev CLI not found', code: 1 })
      const { cmd, baseEnv } = nodeRunner()
      execFile(cmd, [cliJs, ...args], { cwd, env: baseEnv, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ stdout: stdout || '', stderr: stderr || (err ? String(err.message) : ''), code: err ? (err as any).code ?? 1 : 0 })
      })
    })
  }

  // --- Per-agent trace export (TraceX) -------------------------------------
  // Provider-aware: grok agents export their NATIVE session trace via
  // `grok trace --local` (a self-contained .tar.gz), because grok owns its own
  // on-disk session store outside the autodev workspace. Every other provider
  // reuses the existing CLI `export` (agent backup zip) — that backup already
  // bundles the provider's captured session trace, so there's no second path to
  // maintain. copilot-sdk has no resumable on-disk trace (in-memory only), so we
  // still produce the backup but flag that its trace won't be in there.
  async exportTrace(path: string, output: string): Promise<{ ok: true; output: string; note?: string } | { error: string }> {
    const info = this.workspaceInfo(path)
    if (!info.exists) return { error: 'Not an AutoDev workspace (no .autodev/settings.json).' }
    const provider = info.provider || ''
    if (provider.startsWith('grok')) return this._exportGrokTrace(path, provider, output)
    // Non-grok: reuse the backup export — it captures the session trace.
    const r = await this.runCli(['export', path, '--output', output])
    if (r.code !== 0) return { error: r.stderr || 'Backup export failed' }
    const note = provider === 'copilot-sdk'
      ? 'copilot-sdk traces are in-memory only — backup captures workspace state but no resumable on-disk trace.'
      : undefined
    return { ok: true, output, note }
  }

  /** Locate the grok binary: PATH first, then $GROK_HOME/bin/grok (default ~/.grok). */
  private _grokBinary(): string | null {
    if (runnerOnPath('grok')) return 'grok'
    const bin = join(this._grokHome(), 'bin', 'grok')
    return existsSync(bin) ? bin : null
  }

  private _grokHome(): string {
    return process.env['GROK_HOME'] || join(process.env['HOME'] || homedir(), '.grok')
  }

  /**
   * Resolve the grok SESSION_ID for a workspace. grok-tui persists it to
   * `.autodev/session-state.json`; grok-cli is stateless (fresh session per run),
   * so we fall back to grok's own session store:
   *   $GROK_HOME/sessions/<encodeURIComponent(cwd)>/<uuid>/  — newest wins.
   * Returns null if the agent has never produced a grok session.
   */
  private _resolveGrokSessionId(path: string, provider: string): string | null {
    const st = this._readJson(join(path, '.autodev', 'session-state.json')) || {}
    const fromState = st['grok-tui'] || st['grok-cli'] || st[provider]
    if (typeof fromState === 'string' && fromState.trim()) return fromState.trim()
    // Grok keys its session dir by the URL-encoded workspace cwd (raw + realpath).
    const roots = new Set<string>([path])
    try { roots.add(realpathSync(path)) } catch { /* ignore */ }
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    let best: { id: string; mtime: number } | null = null
    for (const r of roots) {
      const dir = join(this._grokHome(), 'sessions', encodeURIComponent(r))
      if (!existsSync(dir)) continue
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (!e.isDirectory() || !isUuid.test(e.name)) continue
          let m = 0
          try { m = statSync(join(dir, e.name)).mtimeMs } catch { /* ignore */ }
          if (!best || m > best.mtime) best = { id: e.name, mtime: m }
        }
      } catch { /* ignore */ }
    }
    return best?.id ?? null
  }

  private _exportGrokTrace(path: string, provider: string, output: string): Promise<{ ok: true; output: string; note?: string } | { error: string }> {
    return new Promise((resolve) => {
      const bin = this._grokBinary()
      if (!bin) return resolve({ error: 'grok CLI not found (looked on PATH and $GROK_HOME/bin/grok).' })
      const sid = this._resolveGrokSessionId(path, provider)
      if (!sid) return resolve({ error: 'No grok session for this workspace yet — start the agent once to create a grok session before exporting its trace.' })
      // grok writes a tarball; normalise the extension the save dialog produced.
      let out = output
      if (!/\.(tar\.gz|tgz)$/i.test(out)) out = out.replace(/\.zip$/i, '') + '.tar.gz'
      execFile(bin, ['trace', '--local', '--json', '-o', out, sid], { cwd: path, env: { ...process.env }, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return resolve({ error: (stderr || (err as Error).message || 'grok trace failed').toString().trim() })
        // grok --json prints {"session_id","status","local_path"} — trust local_path.
        let localPath = out
        try {
          const line = (stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'
          const j = JSON.parse(line)
          if (typeof j.local_path === 'string' && j.local_path) localPath = j.local_path
        } catch { /* fall back to -o path */ }
        try { if (!existsSync(localPath) || statSync(localPath).size === 0) return resolve({ error: 'grok reported success but the trace file is missing or empty.' }) } catch { return resolve({ error: 'grok trace file could not be verified.' }) }
        resolve({ ok: true, output: localPath })
      })
    })
  }

  // --- live updates --------------------------------------------------------
  private _watch(path: string): void {
    if (this._watchers.has(path)) return
    try {
      const dir = join(path, '.autodev')
      if (!existsSync(dir)) return
      let timer: NodeJS.Timeout | null = null
      const w = watch(dir, { persistent: false }, () => {
        if (timer) return
        timer = setTimeout(() => { timer = null; this.emit('agentUpdated', this.readState(path)) }, 300)
      })
      this._watchers.set(path, w)
    } catch { /* ignore */ }
  }

  private _unwatch(path: string): void {
    const w = this._watchers.get(path)
    if (w) { try { w.close() } catch { /* ignore */ } this._watchers.delete(path) }
    this._extTail.delete(path)
    this._extStopping.delete(path)
  }

  /** How many agent loops are running right now (for the quit-guard + tray). */
  runningCount(): number { return this._procs.size }

  disposeAll(): void {
    // App is quitting: stop any pending auto-restart from resurrecting a loop.
    this._disposing = true
    for (const t of this._retryTimers.values()) { try { clearTimeout(t) } catch { /* ignore */ } }
    this._retryTimers.clear()
    // Kill the loops WE spawned…
    for (const child of this._procs.values()) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
    // …and any EXTERNAL `autodev start` loops for our registered workspaces —
    // survivors of a previous app session (e.g. a crash before AUTODEV_EXIT_WITH_
    // PARENT fired, or a terminal-started loop) that this session shows as running
    // but never owned. If left alive they outlive the app and, on the next launch,
    // bind the same office slug and evict the fresh loop every ~5s. SIGINT lets the
    // loop shut its provider down gracefully; it runs independently of our exit.
    for (const p of this._paths) {
      if (this._procs.has(p)) continue
      for (const pid of this._externalPids(p)) {
        try { process.kill(pid, 'SIGINT') } catch { /* ignore */ }
      }
    }
    for (const w of this._watchers.values()) { try { w.close() } catch { /* ignore */ } }
    this._procs.clear()
    this._watchers.clear()
    this._extPidCache.clear()
    this._extTail.clear()
    this._extStopping.clear()
  }
}
