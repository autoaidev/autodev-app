import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'

/**
 * Locate the `autodev` CLI entry (bin/autodev.js). Resolution order:
 *   1. AUTODEV_CLI_JS env override
 *   2. sibling `autodev-cli` repo next to this app (dev / monorepo layout)
 *   3. a few parent levels up
 * Returns the absolute path to bin/autodev.js, or null if not found.
 */
export function resolveCliJs(): string | null {
  const env = process.env['AUTODEV_CLI_JS']
  if (env && existsSync(env)) return env

  const candidates: string[] = []
  // app root in dev is the project dir; in prod it's resources/app
  const roots = [app.getAppPath(), process.cwd(), dirname(app.getAppPath())]
  for (const root of roots) {
    let dir = root
    for (let i = 0; i < 5; i++) {
      candidates.push(join(dir, 'autodev-cli', 'bin', 'autodev.js'))
      candidates.push(join(dir, '..', 'autodev-cli', 'bin', 'autodev.js'))
      dir = dirname(dir)
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

import { execFileSync } from 'child_process'

let _systemNode: string | null | undefined

/**
 * Locate a SYSTEM Node ≥ 22 binary. Electron's bundled node (process.execPath +
 * ELECTRON_RUN_AS_NODE) is Node 20, which lacks `node:sqlite` (Node 22.5+) — so
 * opencode session/export features silently fail when the CLI runs under it.
 * Prefer a real system node so the CLI runs in its native environment; fall back
 * to Electron's node if none is found (claude/copilot still work).
 */
function findSystemNode(): string | null {
  if (_systemNode !== undefined) return _systemNode
  const candidates = [process.env['AUTODEV_NODE'], '/usr/bin/node', '/usr/local/bin/node', 'node']
  for (const c of candidates) {
    if (!c) continue
    try {
      const v = execFileSync(c, ['-v'], { encoding: 'utf8' }).trim() // e.g. v22.22.2
      const major = parseInt(v.replace(/^v/, '').split('.')[0], 10)
      if (major >= 22) { _systemNode = c; return c }
    } catch { /* not present */ }
  }
  _systemNode = null
  return null
}

/** Node executable + env to run the `autodev` CLI with. */
export function nodeRunner(): { cmd: string; baseEnv: NodeJS.ProcessEnv } {
  const sys = findSystemNode()
  if (sys) {
    return { cmd: sys, baseEnv: { ...process.env, NODE_NO_WARNINGS: '1' } }
  }
  // Fallback: Electron's bundled node (no node:sqlite — opencode portability degraded).
  return { cmd: process.execPath, baseEnv: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' } }
}
