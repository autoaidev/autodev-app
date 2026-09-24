import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * cozempicClean — app-side reconcile of stale cozempic-installed hooks.
 *
 * `cozempic init` wired long-session guard/pruning hooks into Claude Code's
 * standard hooks map:
 *
 *   { "hooks": { "<Event>": [ { "matcher": "…", "hooks": [ { "type": "command",
 *                                                            "command": "…" } ] } ] } }
 *
 * Making cozempic opt-in stopped NEW installs but never removed hooks a machine
 * already had. The CLI (autodev-cli/src/cozempicHooks.ts) strips them on every
 * profile rebuild — but an office character started via "Connect & operate" runs
 * an interactive `grok`/`claude` PTY directly, with no loop/profile rebuild in
 * front of it. So a stale cozempic SessionStart hook in the GLOBAL
 * `~/.claude/settings.json` keeps firing and grok logs
 * `session_start hook (global/settings) failed, ignored: exit code 1` (Windows).
 *
 * This module is a node-only (no electron) mirror of the CLI matcher so operate()
 * can strip those hooks before it launches the PTY. Kept dependency-free and
 * side-effect-free beyond the settings write so it is unit-testable and never
 * throws into the operate launch path.
 */

/**
 * True when a hook entry's `command` is a cozempic-INSTALLED hook. Mirrors
 * autodev-cli `_isCozempicCommand` EXACTLY — precise on purpose so a bare
 * substring test on `cozempic` can't false-positive strip an unrelated hook that
 * merely mentions the word (e.g. `echo not-cozempic`). Every hook `cozempic init`
 * writes carries the canonical `# cozempic-hook-schema=vN` tag AND invokes the
 * tool (`cozempic <sub>` or `python3 -m cozempic`); we match those shapes only.
 */
export function isCozempicCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false
  return /cozempic-hook-schema=/.test(cmd)      // canonical install tag
    || /(^|[^\w-])cozempic\s/.test(cmd)         // invokes the cozempic binary
    || /-m\s+cozempic\b/.test(cmd)              // invokes `python3 -m cozempic`
}

interface HookLeaf { type?: string; command?: string; [k: string]: unknown }
interface HookGroup { matcher?: string; hooks?: HookLeaf[]; [k: string]: unknown }

/**
 * Remove ONLY cozempic-tagged hook entries from a SINGLE settings file. Mirrors
 * the CLI `removeCozempicHooksFromFile`:
 * - idempotent & safe when the file / `hooks` map / any cozempic hook is absent;
 * - preserves every non-cozempic hook, matcher group and all other settings;
 * - prunes now-empty matcher groups, now-empty event arrays, and an emptied
 *   `hooks` map so no orphan scaffolding lingers;
 * - never throws (a settings write failure must not break the operate launch);
 *   malformed JSON → skip the file untouched.
 *
 * @returns true if the file was changed, false otherwise.
 */
export function removeCozempicHooksFromFile(settingsPath: string): boolean {
  try {
    if (!settingsPath) return false
    if (!existsSync(settingsPath)) return false

    const raw = readFileSync(settingsPath, 'utf8')
    // Fast path — nothing to do if the file never mentions cozempic.
    if (!raw.includes('cozempic')) return false

    let data: Record<string, unknown>
    try { data = JSON.parse(raw) } catch { return false } // malformed — do not touch
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false

    const hooks = data.hooks as Record<string, unknown> | undefined
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false

    let changed = false

    for (const event of Object.keys(hooks)) {
      const groups = hooks[event]
      if (!Array.isArray(groups)) continue

      const keptGroups: HookGroup[] = []
      for (const group of groups as HookGroup[]) {
        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
          keptGroups.push(group)
          continue
        }
        const keptLeaves = group.hooks.filter((leaf) => !isCozempicCommand(leaf?.command))
        if (keptLeaves.length !== group.hooks.length) changed = true
        if (keptLeaves.length === 0) {
          // Whole matcher group was cozempic-only → drop it.
          changed = true
          continue
        }
        keptGroups.push({ ...group, hooks: keptLeaves })
      }

      if (keptGroups.length === 0) {
        delete hooks[event]
        changed = true
      } else {
        hooks[event] = keptGroups
      }
    }

    if (!changed) return false

    // Drop an emptied hooks map so we leave a clean file.
    if (Object.keys(hooks).length === 0) delete data.hooks

    writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
    return true
  } catch {
    // A settings write failure must never break the operate launch.
    return false
  }
}

/**
 * Strip cozempic hooks from every settings file an operated office character could
 * inherit them from, mirroring the CLI `removeCozempicHooks`:
 *   1. `<dir>/.claude/settings.local.json`  — scratch-dir project-local
 *   2. `<dir>/.claude/settings.json`         — scratch-dir project shared
 *   3. `~/.claude/settings.json`             — GLOBAL user settings (the one grok
 *                                              labels "global/settings")
 * Each file is cleaned best-effort / no-throw / idempotently; missing or malformed
 * files are skipped. Returns true if ANY file was changed.
 */
export function removeCozempicHooks(dir: string): boolean {
  const targets: string[] = []
  if (dir) {
    targets.push(join(dir, '.claude', 'settings.local.json'))
    targets.push(join(dir, '.claude', 'settings.json'))
  }
  try { targets.push(join(homedir(), '.claude', 'settings.json')) } catch { /* homedir unavailable */ }

  // De-dupe: a scratch dir under HOME could collide with the global path.
  const seen = new Set<string>()
  let changed = false
  for (const p of targets) {
    if (seen.has(p)) continue
    seen.add(p)
    if (removeCozempicHooksFromFile(p)) changed = true
  }
  return changed
}
