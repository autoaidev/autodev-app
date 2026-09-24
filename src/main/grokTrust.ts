import { join, resolve } from 'path'
import { homedir } from 'os'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs'

/**
 * grok's per-folder trust store lives at ~/.grok/trusted_folders.toml and keys
 * each trusted directory as a DOUBLE-QUOTED TOML table header:
 *
 *   [folders."C:\\Users\\me\\.autodev-app\\offices\\o\\a-1"]
 *   trusted = true
 *   decided_at = 1790173797
 *
 * The old app bug wrote the raw OS path verbatim into that double-quoted key —
 * on Windows that means `C:\Users\me\.autodev-app\…` with LONE backslashes. TOML
 * double-quoted strings interpret backslash escapes, so `\U`, `\u`, `\a`, `\.`,
 * `\t`, `\d`, … are INVALID escapes and the whole file becomes unparseable. grok
 * then reports "the trust store could not be read" and falls back to the
 * interactive trust prompt, so `grok --always-approve` (Operate) can't launch.
 *
 * This module owns the correct, Windows-safe write: it TOML-escapes the key, and
 * it REPAIRS a store already corrupted by the old bug (rewriting every folders
 * key in escaped form while preserving each entry's trusted/decided_at).
 *
 * Kept electron-free (only node builtins) so it is unit-testable standalone.
 */

/** grok's home dir. Honors GROK_HOME (used by tests to point at a temp dir),
 *  else the OS home dir. */
export function grokHome(): string {
  const env = process.env.GROK_HOME
  return env && env.trim() ? env : homedir()
}

/**
 * TOML-escape a value destined for a DOUBLE-QUOTED key/string: backslash `\`→`\\`
 * and double-quote `"`→`\"`. Folder paths won't contain control characters, so
 * those two are sufficient to keep grok's TOML parser happy. A Windows path
 * `C:\Users\me` becomes `C:\\Users\\me`, which grok's parser reads back as the
 * exact original `C:\Users\me` — so grok's folder lookup MATCHES and it does not
 * re-prompt.
 */
export function escapeTomlKey(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Matches a `[folders."<inner>"]` table header line, capturing the inner (still
 *  TOML-encoded) key text. */
const FOLDER_HEADER_RE = /^\s*\[folders\."(.*)"\]\s*$/

/**
 * Recover the real OS path from a folders-key's inner (TOML-encoded) text,
 * tolerating BOTH the correct escaped form (`C:\\Users`) and the old bug's raw
 * form (`C:\Users`). Known escapes `\\`→`\` and `\"`→`"` are decoded; any other
 * `\X` (the corrupt case, e.g. `\U`) keeps the backslash as a literal path
 * separator. Both forms therefore recover to the same OS path.
 */
export function recoverPath(inner: string): string {
  let out = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '\\' && i + 1 < inner.length) {
      const n = inner[i + 1]
      if (n === '\\' || n === '"') {
        out += n
        i++
        continue
      }
      // Unknown escape → the old bug's literal backslash. Keep it.
      out += c
    } else {
      out += c
    }
  }
  return out
}

/**
 * A store needs repair if ANY folders key is not already in its canonical
 * escaped form — i.e. the old bug left lone/invalid backslashes that make the
 * file unparseable to grok.
 */
export function storeNeedsRepair(text: string): boolean {
  if (!text) return false
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(FOLDER_HEADER_RE)
    if (!m) continue
    const inner = m[1]
    if (inner !== escapeTomlKey(recoverPath(inner))) return true
  }
  return false
}

/**
 * Rebuild a (possibly corrupt) store as valid TOML: every `[folders."…"]` key is
 * re-emitted properly escaped, preserving each entry's meta lines (trusted /
 * decided_at) and any preamble before the first header. Ensures `newAbs` is
 * present exactly once.
 */
function rebuildStore(text: string, newAbs: string): string {
  const lines = text.split(/\r?\n/)
  const preamble: string[] = []
  const entries: { path: string; meta: string[] }[] = []
  let cur: { path: string; meta: string[] } | null = null
  for (const line of lines) {
    const m = line.match(FOLDER_HEADER_RE)
    if (m) {
      cur = { path: recoverPath(m[1]), meta: [] }
      entries.push(cur)
      continue
    }
    if (cur) {
      if (line.trim() !== '') cur.meta.push(line)
    } else if (line.trim() !== '') {
      preamble.push(line)
    }
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (!entries.some((e) => e.path === newAbs)) {
    entries.push({ path: newAbs, meta: ['trusted = true', `decided_at = ${nowSec}`] })
  }
  const out: string[] = []
  if (preamble.length) {
    out.push(...preamble, '')
  }
  for (const e of entries) {
    out.push(`[folders."${escapeTomlKey(e.path)}"]`)
    const meta = e.meta.length ? e.meta : ['trusted = true', `decided_at = ${nowSec}`]
    out.push(...meta)
    out.push('')
  }
  return out.join('\n')
}

/**
 * Pre-trust an app-owned operate/loop dir in ~/.grok/trusted_folders.toml so a
 * spawned `grok` skips its "Do you trust the contents of this directory?" gate —
 * the grok twin of markFolderTrusted (claude). Idempotent, best-effort (never
 * throws). Windows-safe: the folder key is TOML-escaped, and a store already
 * corrupted by the old unescaped-backslash bug is repaired in place.
 */
export function markGrokFolderTrusted(dir: string): void {
  try {
    const grokDir = join(grokHome(), '.grok')
    const tf = join(grokDir, 'trusted_folders.toml')
    const abs = resolve(dir)
    const escHeader = `[folders."${escapeTomlKey(abs)}"]`
    let text = ''
    try {
      text = readFileSync(tf, 'utf8')
    } catch {
      /* no file yet */
    }

    if (storeNeedsRepair(text)) {
      // The old bug corrupted this store → grok can't parse it. Back up the
      // broken original, then rewrite every key escaped (preserving entries) and
      // add ours. If the rebuild somehow yields nothing usable, fall back to a
      // fresh single-entry store.
      mkdirSync(grokDir, { recursive: true })
      try {
        writeFileSync(`${tf}.bak-${Date.now()}`, text, 'utf8')
      } catch {
        /* best effort backup */
      }
      let rebuilt = ''
      try {
        rebuilt = rebuildStore(text, abs)
      } catch {
        rebuilt = ''
      }
      if (!rebuilt || !rebuilt.includes(escHeader)) {
        const nowSec = Math.floor(Date.now() / 1000)
        rebuilt = `${escHeader}\ntrusted = true\ndecided_at = ${nowSec}\n`
      }
      writeFileSync(tf, rebuilt, 'utf8')
      return
    }

    // Store is valid (or empty). Append our entry if it isn't already present.
    if (text.includes(escHeader)) return
    const nowSec = Math.floor(Date.now() / 1000)
    const entry = `${text.endsWith('\n') || text === '' ? '' : '\n'}\n${escHeader}\ntrusted = true\ndecided_at = ${nowSec}\n`
    mkdirSync(grokDir, { recursive: true })
    appendFileSync(tf, entry, 'utf8')
  } catch {
    /* best effort — grok's own trust prompt is the backstop */
  }
}
