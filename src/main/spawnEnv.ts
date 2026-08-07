import { homedir } from 'os'
import { join, delimiter } from 'path'

/**
 * Put provider-CLI bin dirs on PATH for spawned children (loops + operate PTYs).
 *
 * WHY: claude/copilot/opencode install into an npm-global bin that's already on the
 * default PATH, but `grok` installs to `~/.grok/bin` (its own installer) which is NOT
 * on a non-login shell's PATH. So `autodev start -p grok-tui` (the loop) and the
 * operate PTY's `grok` command both fail with "grok: command not found" even though
 * grok is installed. Prepending the known provider bin dirs fixes both, and is a
 * no-op when they're already present.
 */
export function augmentPath(basePath?: string): string {
  const home = homedir()
  const extra = [
    join(home, '.grok', 'bin'),   // grok's own installer target
    join(home, '.local', 'bin'),  // common user-local installs
  ]
  const cur = (basePath ?? process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const prepend = extra.filter((d) => !cur.includes(d))
  return [...prepend, ...cur].join(delimiter)
}
