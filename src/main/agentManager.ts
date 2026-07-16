import { spawn, execFile, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, openSync, readSync, closeSync, watch, FSWatcher } from 'fs'
import { join, basename, dirname } from 'path'
import { app } from 'electron'
import { resolveCliJs, nodeRunner } from './cli'

export type Activity = 'working' | 'idle' | 'stopped'

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
}

const WORKING_EVENTS = new Set(['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStatus', 'Notification'])
const IDLE_EVENTS = new Set(['SessionEnd', 'Stop', 'StopFailure', 'session.idle'])

/**
 * Manages a registry of agent workspaces: persists the list, reads each agent's
 * state from its `.autodev/*` files, and starts/stops the autonomous loop by
 * spawning the `autodev` CLI as a child process (one per running agent).
 */
export class AgentManager extends EventEmitter {
  private _paths: string[] = []
  private _procs = new Map<string, ChildProcess>()
  private _watchers = new Map<string, FSWatcher>()
  private readonly _registryFile = join(app.getPath('userData'), 'agents.json')

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
    let activity: Activity = running ? this._activityFromHooks(path) : 'stopped'
    return {
      path,
      name: settings.sessionName || basename(path),
      provider: settings.provider,
      sessionName: settings.sessionName,
      wsUrl: settings.wsUrl,
      running,
      activity,
      tasks: todo,
      lastOutput: this._latestOutput(path, settings.provider)
    }
  }

  private _readJson(file: string): any {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  }

  private _readTodoCounts(file: string): { total: number; remaining: number; done: number } {
    try {
      const t = readFileSync(file, 'utf8')
      const pending = (t.match(/^- \[ \]/gm) || []).length
      const inProgress = (t.match(/^- \[~\]/gm) || []).length
      const done = (t.match(/^- \[x\]/gim) || []).length
      return { total: pending + inProgress + done, remaining: pending + inProgress, done }
    } catch { return { total: 0, remaining: 0, done: 0 } }
  }

  private _activityFromHooks(path: string): Activity {
    try {
      const file = join(path, '.autodev', 'hooks-events.jsonl')
      if (!existsSync(file)) return 'working'
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
          if (IDLE_EVENTS.has(name)) return 'idle'
          if (WORKING_EVENTS.has(name)) return 'working'
        } catch { /* skip */ }
      }
      return 'working'
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
    const child = spawn(cmd, args, { cwd: path, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    this._procs.set(path, child)
    const onData = (buf: Buffer) => this.emit('log', { path, line: buf.toString('utf8') })
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', (code) => {
      this._procs.delete(path)
      this.emit('log', { path, line: `\n[loop exited code=${code ?? '?'}]\n` })
      this.emit('changed')
    })
    // Without this, an async spawn failure (e.g. ENOENT: the cwd was deleted, or
    // the node/cli binary is missing) emits 'error' with no 'exit' — the child
    // stays in _procs so the agent shows a stuck "running", and the unhandled
    // 'error' can crash the main process. Surface it and clear the entry.
    child.on('error', (err) => {
      this._procs.delete(path)
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

  disposeAll(): void {
    for (const child of this._procs.values()) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
    for (const w of this._watchers.values()) { try { w.close() } catch { /* ignore */ } }
    this._procs.clear()
    this._watchers.clear()
  }
}
