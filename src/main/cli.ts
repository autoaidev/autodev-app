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

/** Node executable to run the CLI with (Electron bundles its own node via process.execPath + ELECTRON_RUN_AS_NODE). */
export function nodeRunner(): { cmd: string; baseEnv: NodeJS.ProcessEnv } {
  return {
    cmd: process.execPath,
    baseEnv: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }
}
