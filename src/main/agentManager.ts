import { spawn, execFile, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, openSync, readSync, closeSync, watch, FSWatcher } from 'fs'
import { join, basename, dirname } from 'path'
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

export interface AgentState {
  path: string
  name: string
  provider?: string
  sessionName?: string
  wsUrl?: string
  running: boolean
  activity: Activity
  tasks: { total: number; remaining: number; done: number }
  currentTask?: string
  lastOutput?: string
  error?: string
  /** Last child exit code when the loop stopped (non-zero ⇒ crashed). */
  exitCode?: number | null
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

  // --- state reading -------------------------------------------------------
  readState(path: string): AgentState {
    const settings = this._readJson(join(path, '.autodev', 'settings.json')) ?? {}
    const todo = this._readTodoCounts(join(path, 'TODO.md'))
    const running = this._procs.has(path)
    let activity: Activity
    let error: string | undefined
    let exitCode: number | null | undefined
    if (running) {
      const ss = this._streamState.get(path)
      if (ss) {
        // A live reauth/rate-limit pause wins over the hooks read (the loop is
        // paused, so hooks look 'working' from the last pre-pause event).
        activity = ss.activity
        error = ss.error
      } else {
        activity = this._activityFromHooks(path)
        if (activity === 'crashed') error = 'The run reported a failure (StopFailure) — likely a crash or watchdog timeout.'
        else if (activity === 'stalled') error = 'No activity for several minutes — the agent may be hung (e.g. a dead token or a wedged tool).'
      }
    } else {
      exitCode = this._lastExit.get(path)
      if (typeof exitCode === 'number' && exitCode !== 0) {
        activity = 'crashed'
        error = `Loop exited with code ${exitCode}.`
      } else {
        activity = 'stopped'
      }
    }
    return {
      path,
      name: settings.sessionName || basename(path),
      provider: settings.provider,
      sessionName: settings.sessionName,
      wsUrl: settings.wsUrl,
      running,
      activity,
      tasks: { total: todo.total, remaining: todo.remaining, done: todo.done },
      currentTask: todo.currentTask,
      lastOutput: this._latestOutput(path, settings.provider),
      error,
      exitCode
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
          if (FAILURE_EVENTS.has(name) || et === 'stop_failure') return 'crashed'
          if (CLEAN_IDLE_EVENTS.has(name) || CLEAN_IDLE_ETYPES.has(et)) return 'idle'
          if (WORKING_EVENTS.has(name) || WORKING_ETYPES.has(et)) return stale() ? 'stalled' : 'working'
        } catch { /* skip */ }
      }
      return stale() ? 'stalled' : 'working'
    } catch { return 'working' }
  }

  private _latestOutput(path: string, provider?: string): string | undefined {
    if (!provider) return undefined
    try {
      const base = provider.replace('-sdk', '').replace('-tui', '')
      const ptr = join(path, '.autodev', 'output', `${provider}.latest`)
      let outFile: string | undefined
      if (existsSync(ptr)) {
        const id = readFileSync(ptr, 'utf8').trim()
        const cand = join(path, '.autodev', 'output', provider, `${id}.txt`)
        if (existsSync(cand)) outFile = cand
      }
      if (!outFile) return undefined
      const raw = readFileSync(outFile, 'utf8')
      const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      return clean.length > 4000 ? '…' + clean.slice(-4000) : clean
    } catch { return undefined }
  }

  // --- loop control --------------------------------------------------------
  start(path: string, provider?: string): { ok: true } | { error: string } {
    if (this._procs.has(path)) return { ok: true }
    const cliJs = resolveCliJs()
    if (!cliJs) return { error: 'autodev CLI not found. Set AUTODEV_CLI_JS or place autodev-cli beside the app.' }
    const { cmd, baseEnv } = nodeRunner()
    const args = [cliJs, 'start', path]
    if (provider) args.push('-p', provider)
    // Fresh start clears any prior crash/pause state so a restart reads clean.
    this._lastExit.delete(path)
    this._streamState.delete(path)
    const child = spawn(cmd, args, { cwd: path, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    this._procs.set(path, child)
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

  stop(path: string): void {
    const child = this._procs.get(path)
    if (child) {
      try { child.kill('SIGINT') } catch { /* ignore */ }
      // hard-kill fallback
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 4000).unref()
    }
  }

  isRunning(path: string): boolean { return this._procs.has(path) }

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
  }

  /** How many agent loops are running right now (for the quit-guard + tray). */
  runningCount(): number { return this._procs.size }

  disposeAll(): void {
    for (const child of this._procs.values()) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
    for (const w of this._watchers.values()) { try { w.close() } catch { /* ignore */ } }
    this._procs.clear()
    this._watchers.clear()
  }
}
