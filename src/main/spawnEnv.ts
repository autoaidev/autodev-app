import { homedir } from 'os'
import { join, delimiter } from 'path'
import { existsSync } from 'fs'

/**
 * Put provider-CLI bin dirs on PATH for spawned children (loops + operate PTYs).
 *
 * WHY: claude/copilot/opencode install into an npm-global bin that's already on the
 * default PATH, but `grok` installs to `~/.grok/bin` (its own installer) which is NOT
 * on a non-login shell's PATH. So `autodev start -p grok-tui` (the loop) and the
 * operate PTY's `grok` command both fail with "grok: command not found" even though
 * grok is installed. Prepending the known provider bin dirs fixes both, and is a
 * no-op when they're already present.
 *
 * On Windows a GUI-launched Electron app can inherit a trimmed PATH, so the npm
 * global bin (`%APPDATA%\npm`, where `grok.cmd` / `claude.cmd` live) may be absent —
 * add the common Windows install locations too. `path.delimiter` handles ';' vs ':'.
 */
export function augmentPath(basePath?: string, platform: NodeJS.Platform = process.platform): string {
  const home = homedir()
  const extra =
    platform === 'win32'
      ? [
          join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm'), // npm global (.cmd shims)
          join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'grok', 'bin'),
          join(home, '.grok', 'bin')
        ]
      : [
          join(home, '.grok', 'bin'), // grok's own installer target
          join(home, '.local', 'bin') // common user-local installs
        ]
  const cur = (basePath ?? process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const prepend = extra.filter((d) => !cur.includes(d))
  return [...prepend, ...cur].join(delimiter)
}

/**
 * Is `bin` (e.g. `grok`) resolvable on the (augmented) PATH? Used to PRE-CHECK a
 * provider CLI before spawning its Operate/loop command, so a missing provider gets
 * a clear "X not found on PATH" message instead of a cryptic node-pty failure or a
 * silent shell "command not found". Cross-platform: on win32 it honours PATHEXT
 * (`grok` also matches `grok.cmd` / `grok.exe`).
 */
export function resolveBinOnPath(
  bin: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const name = String(bin ?? '').trim()
  if (!name) return false
  // An explicit path (absolute or containing a separator) is checked directly.
  if (name.includes('/') || name.includes('\\')) return existsSync(name)
  const dirs = augmentPath(env.PATH, platform).split(delimiter).filter(Boolean)
  const exts =
    platform === 'win32'
      ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
      : ['']
  for (const dir of dirs) {
    // Bare name (unix executables, or a name that already carries an extension).
    if (existsSync(join(dir, name))) return true
    if (platform === 'win32') {
      for (const ext of exts) {
        if (ext && existsSync(join(dir, name + ext))) return true
      }
    }
  }
  return false
}
