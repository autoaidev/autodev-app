import { EventEmitter } from 'events'
import { existsSync, readdirSync, readFileSync, statSync, createReadStream, openSync, readSync, closeSync } from 'fs'
import { watch, FSWatcher } from 'chokidar'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'

/**
 * Discovers and live-streams Claude Code sessions on this machine.
 *
 * Claude stores each session as a JSONL transcript at
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * (encoded-cwd = the workspace path with / : \ collapsed to '-'). We scan every
 * project folder — not just registered agent workspaces — so sessions started
 * anywhere (a manual `claude`, an MCP bridge, etc.) can be captured, and we tail
 * a chosen transcript in real time. Cross-user homes need elevated reads
 * (deferred to the credentials work); this covers the current user's sessions.
 */

export interface SessionMeta {
  id: string
  file: string
  project: string // the encoded ~/.claude/projects folder name
  cwd: string // best-effort real workspace path
  title: string
  mtime: number
  sizeKb: number
  msgs: number
  live: boolean
}

export interface SessionMsg {
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  ts?: number
}

const claudeDir = (): string => join(homedir(), '.claude')

/**
 * True only when `file` resolves inside ~/.claude/projects — the sole tree that
 * holds session transcripts. `backlog`/`open` are reachable over IPC with an
 * arbitrary string, so without this confinement a compromised renderer could read
 * (or begin tailing) any absolute path on disk. discover() only ever yields files
 * under this root, so every legitimate flow passes.
 */
export function underProjects(file: string): boolean {
  const root = resolve(join(claudeDir(), 'projects'))
  const f = resolve(file)
  return f === root || f.startsWith(root + sep)
}

/** sessionId → newest display title, from ~/.claude/history.jsonl. */
function titleMap(): Map<string, string> {
  const m = new Map<string, string>()
  try {
    const f = join(claudeDir(), 'history.jsonl')
    if (!existsSync(f)) return m
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line) as { sessionId?: string; display?: string }
        if (o.sessionId && o.display) m.set(o.sessionId, o.display)
      } catch { /* skip */ }
    }
  } catch { /* none */ }
  return m
}

/** Decode a `~/.claude/projects` folder name back to a plausible cwd. Lossy
 *  (dashes in real names collapse), so callers prefer the transcript's own cwd. */
function decodeProject(folder: string): string {
  return '/' + folder.replace(/^-+/, '').replace(/-/g, '/')
}

/** Read the real cwd + title hint from a transcript. Reads only a bounded head
 *  for large files so discovery never loads 100s of MB (msg count is then a
 *  floor). Small files are read whole for an exact count. */
function peekTranscript(file: string, size: number): { cwd?: string; firstUser?: string; count: number } {
  let cwd: string | undefined
  let firstUser: string | undefined
  let count = 0
  const MAX = 256_000
  try {
    let text: string
    if (size > MAX) {
      const fd = openSync(file, 'r')
      try { const buf = Buffer.alloc(MAX); readSync(fd, buf, 0, MAX, 0); text = buf.toString('utf8') } finally { closeSync(fd) }
    } else {
      text = readFileSync(file, 'utf8')
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      count++
      try {
        const o = JSON.parse(line) as Record<string, any>
        if (!cwd && typeof o.cwd === 'string') cwd = o.cwd
        if (!firstUser && o.type === 'user') {
          const t = extractText(o.message)
          if (t) firstUser = t.slice(0, 80)
        }
      } catch { /* skip */ }
    }
  } catch { /* unreadable */ }
  return { cwd, firstUser, count }
}

/** Pull readable text out of a transcript entry's `message`. */
function extractText(message: any): string {
  if (!message) return ''
  const c = message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map((b: any) => {
        if (b?.type === 'text') return b.text
        if (b?.type === 'tool_use') return `🔧 ${b.name}(${shortJson(b.input)})`
        if (b?.type === 'tool_result') return `↳ ${shortJson(b.content)}`
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function shortJson(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s.length > 120 ? s.slice(0, 120) + '…' : s
  } catch { return '' }
}

/** Parse a transcript line into a renderable message, or null to skip. */
function parseLine(line: string): SessionMsg | null {
  if (!line.trim()) return null
  try {
    const o = JSON.parse(line) as Record<string, any>
    const ts = o.timestamp ? Date.parse(o.timestamp) : undefined
    if (o.type === 'user') return { role: 'user', text: extractText(o.message), ts }
    if (o.type === 'assistant') return { role: 'assistant', text: extractText(o.message), ts }
    if (o.type === 'system' && o.content) return { role: 'system', text: String(o.content).slice(0, 200), ts }
    return null
  } catch { return null }
}

/** Best-effort liveness from the transcript's mtime alone. discover() is polled
 *  every 5s on the Electron main thread, so we deliberately avoid the previous
 *  per-session blocking `lsof` child-process spawn (which janked the UI and any
 *  open terminal): a transcript written within the last 45s is treated as live. */
function isLive(mtimeMs: number): boolean {
  return Date.now() - mtimeMs < 45_000
}

export class SessionManager extends EventEmitter {
  private _watchers = new Map<string, FSWatcher>()
  private _offsets = new Map<string, number>()
  // Cache of parsed transcript heads keyed by file, invalidated by mtime, so the
  // 5s discovery poll doesn't re-read + re-JSON.parse unchanged transcripts.
  private _peekCache = new Map<string, { mtimeMs: number; peek: ReturnType<typeof peekTranscript> }>()

  private _peekCached(file: string, size: number, mtimeMs: number): ReturnType<typeof peekTranscript> {
    const hit = this._peekCache.get(file)
    if (hit && hit.mtimeMs === mtimeMs) return hit.peek
    const peek = peekTranscript(file, size)
    this._peekCache.set(file, { mtimeMs, peek })
    return peek
  }

  /** All Claude sessions on this machine (newest first). */
  discover(): SessionMeta[] {
    const projects = join(claudeDir(), 'projects')
    if (!existsSync(projects)) return []
    const titles = titleMap()
    const out: SessionMeta[] = []
    let folders: string[] = []
    try { folders = readdirSync(projects) } catch { return [] }
    for (const folder of folders) {
      const dir = join(projects, folder)
      let files: string[] = []
      try {
        if (!statSync(dir).isDirectory()) continue
        files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'))
      } catch { continue }
      for (const f of files) {
        const file = join(dir, f)
        const id = f.replace(/\.jsonl$/, '')
        let st: ReturnType<typeof statSync>
        try { st = statSync(file) } catch { continue }
        const peek = this._peekCached(file, st.size, st.mtimeMs)
        out.push({
          id,
          file,
          project: folder,
          cwd: peek.cwd || decodeProject(folder),
          title: titles.get(id) || peek.firstUser || '(untitled)',
          mtime: st.mtimeMs,
          sizeKb: Math.round(st.size / 1024),
          msgs: peek.count,
          live: isLive(st.mtimeMs),
        })
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  /** Read the transcript so far (capped) — the backlog for a reader pane. For
   *  huge transcripts (a long-running session can be 100s of MB) only the tail
   *  is read so the main process never blocks loading the whole file. */
  backlog(file: string, limit = 300): SessionMsg[] {
    if (!underProjects(file) || !existsSync(file)) return []
    const size = safeSize(file)
    const MAX = 2_000_000 // last ~2 MB is plenty for `limit` messages
    let text = ''
    try {
      if (size > MAX) {
        const fd = openSync(file, 'r')
        try {
          const buf = Buffer.alloc(MAX)
          readSync(fd, buf, 0, MAX, size - MAX)
          text = buf.toString('utf8')
        } finally { closeSync(fd) }
        const nl = text.indexOf('\n')
        if (nl >= 0) text = text.slice(nl + 1) // drop the partial first line
      } else {
        text = readFileSync(file, 'utf8')
      }
    } catch { /* unreadable */ }
    const msgs: SessionMsg[] = []
    for (const line of text.split('\n')) {
      const m = parseLine(line)
      if (m && m.text) msgs.push(m)
    }
    this._offsets.set(file, size)
    return msgs.slice(-limit)
  }

  /** Start tailing a transcript; emits `data` {file, msgs} as lines are appended. */
  open(file: string): void {
    if (!underProjects(file)) return
    if (this._watchers.has(file)) return
    if (!existsSync(file)) return
    if (!this._offsets.has(file)) this._offsets.set(file, 0)
    const w = watch(file, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } })
    w.on('change', () => this._drain(file))
    this._watchers.set(file, w)
  }

  close(file: string): void {
    const w = this._watchers.get(file)
    if (w) { void w.close(); this._watchers.delete(file) }
    this._offsets.delete(file)
  }

  closeAll(): void {
    for (const w of this._watchers.values()) void w.close()
    this._watchers.clear()
    this._offsets.clear()
  }

  /** Read appended bytes since the last offset, parse new lines, emit them. */
  private _drain(file: string): void {
    const from = this._offsets.get(file) ?? 0
    const size = safeSize(file)
    if (size <= from) { this._offsets.set(file, size); return }
    const stream = createReadStream(file, { start: from, end: size - 1, encoding: 'utf8' })
    let buf = ''
    stream.on('data', (c) => { buf += c })
    stream.on('end', () => {
      this._offsets.set(file, size)
      const msgs = buf.split('\n').map(parseLine).filter((m): m is SessionMsg => !!m && !!m.text)
      if (msgs.length) this.emit('data', { file, msgs })
    })
    stream.on('error', () => { this._offsets.set(file, size) })
  }
}

function safeSize(file: string): number {
  try { return statSync(file).size } catch { return 0 }
}
