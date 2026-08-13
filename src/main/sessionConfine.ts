import { homedir } from 'os'
import { join, resolve, sep } from 'path'

/**
 * True only when `file` resolves inside ~/.claude/projects — the sole tree that
 * holds session transcripts. `backlog`/`open` are reachable over IPC with an
 * arbitrary string, so without this confinement a compromised renderer could read
 * (or begin tailing) any absolute path on disk. discover() only ever yields files
 * under this root, so every legitimate flow passes.
 *
 * Kept in a dependency-free leaf module so the guard stays unit-testable in
 * isolation under the node test runner (which loads raw .ts without a bundler).
 */
export function underProjects(file: string): boolean {
  const root = resolve(join(homedir(), '.claude', 'projects'))
  const f = resolve(file)
  return f === root || f.startsWith(root + sep)
}
