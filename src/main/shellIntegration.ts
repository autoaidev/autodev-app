/**
 * Windows Explorer right-click "Open as AutoDev agent" shell integration.
 *
 * Installs a per-user (HKCU, no admin needed) context-menu verb so the user can
 * right-click a folder — or the empty background INSIDE a folder — in Explorer
 * and pick "Open as AutoDev agent". The verb launches the installed app with
 * `--open-folder <path>`, which the main process (index.ts) turns into "add that
 * folder as an agent and reveal it".
 *
 * Two registry trees are installed (both under HKCU\Software\Classes, so no
 * elevation is ever required):
 *   • Directory\shell\AutoDevAgent            → right-click ON a folder    (%1)
 *   • Directory\Background\shell\AutoDevAgent  → right-click INSIDE a folder (%V)
 * Each carries a default value (the menu label), an `Icon` value (the app exe),
 * and a `command` subkey whose default value is the launch command line.
 *
 * Electron has no native registry API, so this shells out to the built-in
 * `reg.exe` (`reg add` / `reg delete` / `reg query`). Every operation is:
 *   • Windows-ONLY — a no-op returning `available:false` on Linux/mac.
 *   • Packaged-ONLY — in a dev run `process.execPath` is the bare `electron`
 *     binary (registering it would be wrong), so we skip and report that the
 *     feature is "only available in the installed app".
 *   • Best-effort — never throws; a failed `reg` call resolves to `ok:false`.
 *   • Idempotent — `reg add /f` overwrites, `reg delete /f` tolerates absence.
 */
import { app } from 'electron'
import { execFileSync } from 'child_process'
import { join } from 'path'

/** The menu label shown in Explorer's context menu. */
const LABEL = 'Open as AutoDev agent'

/** HKCU class roots for the two right-click surfaces (folder / folder background). */
const DIR_KEY = 'HKCU\\Software\\Classes\\Directory\\shell\\AutoDevAgent'
const DIR_CMD = DIR_KEY + '\\command'
const BG_KEY = 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\AutoDevAgent'
const BG_CMD = BG_KEY + '\\command'

/** The result every public function returns (never throws). */
export interface ShellIntegrationResult {
  ok: boolean
  /** True when the folder verb is currently registered (best-effort read). */
  installed: boolean
  /** True when this platform+build can register it at all (Windows + packaged). */
  available: boolean
  /** True on Windows (the renderer HIDES the toggle entirely off-Windows). */
  windows: boolean
  /** Human-readable reason when `ok` is false / `available` is false. */
  reason?: string
}

/** Whether we're on Windows — the only platform this feature targets. */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

/** True only when we can actually touch the registry: Windows AND a packaged app. */
function canRegister(): boolean {
  return isWindows() && app.isPackaged
}

/** Absolute path to reg.exe (System32), falling back to a bare `reg.exe` on PATH. */
function regExe(): string {
  const root = process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows'
  return join(root, 'System32', 'reg.exe')
}

/** Run a reg.exe invocation; returns true on exit 0, false on any error. */
function runReg(args: string[]): boolean {
  try {
    execFileSync(regExe(), args, { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * Install both context-menu entries pointing at the current executable.
 * `process.execPath` is the installed app exe when packaged. Best-effort and
 * idempotent (`reg add /f` overwrites any prior value, e.g. after an update
 * changed the exe path). Never throws.
 */
export function installShellIntegration(): ShellIntegrationResult {
  if (!isWindows()) {
    return { ok: false, installed: false, available: false, windows: false, reason: 'Windows only.' }
  }
  if (!app.isPackaged) {
    // Dev run: execPath is the bare electron binary — registering it would launch
    // electron, not the app. Degrade gracefully so the Settings toggle can explain.
    return { ok: false, installed: false, available: false, windows: true, reason: 'Only available in the installed app.' }
  }
  const exe = process.execPath
  // The launch command line: quote the exe, pass the literal flag, then the folder
  // Explorer substitutes (%1 = the clicked folder; %V = the folder whose background
  // was clicked).
  const dirCmd = `"${exe}" "--open-folder" "%1"`
  const bgCmd = `"${exe}" "--open-folder" "%V"`
  const icon = `${exe},0`
  let ok = true
  // Folder (right-click ON a directory).
  ok = runReg([DIR_KEY, '/ve', '/t', 'REG_SZ', '/d', LABEL, '/f']) && ok
  ok = runReg([DIR_KEY, '/v', 'Icon', '/t', 'REG_SZ', '/d', icon, '/f']) && ok
  ok = runReg([DIR_CMD, '/ve', '/t', 'REG_SZ', '/d', dirCmd, '/f']) && ok
  // Folder background (right-click in EMPTY SPACE inside a directory).
  ok = runReg([BG_KEY, '/ve', '/t', 'REG_SZ', '/d', LABEL, '/f']) && ok
  ok = runReg([BG_KEY, '/v', 'Icon', '/t', 'REG_SZ', '/d', icon, '/f']) && ok
  ok = runReg([BG_CMD, '/ve', '/t', 'REG_SZ', '/d', bgCmd, '/f']) && ok
  return { ok, installed: isShellIntegrationInstalled(), available: true, windows: true }
}

/**
 * Remove both context-menu entries. `reg delete /f` recursively removes the
 * `command` subkey too and tolerates a missing key (so this is safe to call
 * even when nothing was installed). Best-effort; never throws.
 */
export function uninstallShellIntegration(): ShellIntegrationResult {
  if (!isWindows()) {
    return { ok: false, installed: false, available: false, windows: false, reason: 'Windows only.' }
  }
  // Deleting the parent key removes its `command` child; /f suppresses the prompt
  // and a "key not found" is treated as already-removed (a no-op, still ok).
  runReg([DIR_KEY, '/f'])
  runReg([BG_KEY, '/f'])
  const installed = isShellIntegrationInstalled()
  return { ok: !installed, installed, available: app.isPackaged, windows: true }
}

/**
 * Whether the folder verb is currently registered — read by querying the
 * `command` subkey's default value. Best-effort; returns false on any error or
 * on a non-Windows platform.
 */
export function isShellIntegrationInstalled(): boolean {
  if (!isWindows()) return false
  return runReg([DIR_CMD, '/ve'])
}

/**
 * Current status for the renderer/tray: whether it's installed and whether this
 * build can register it at all (Windows + packaged). Used to reflect the toggle
 * and to hide/disable it off-Windows.
 */
export function shellIntegrationStatus(): ShellIntegrationResult {
  return {
    ok: true,
    installed: isShellIntegrationInstalled(),
    available: canRegister(),
    windows: isWindows(),
    reason: !isWindows() ? 'Windows only.' : !app.isPackaged ? 'Only available in the installed app.' : undefined
  }
}

/**
 * Parse an `--open-folder <path>` (or `--open-folder=<path>`) argument out of a
 * process argv. Returns the folder path, or null when the flag isn't present /
 * has no value. Used for both cold start (process.argv) and the second-instance
 * argv relayed by the single-instance lock.
 */
export function parseOpenFolderArg(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--open-folder') {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) return next
      return null
    }
    if (a.startsWith('--open-folder=')) {
      const v = a.slice('--open-folder='.length)
      return v || null
    }
  }
  return null
}

/**
 * On app start: if the user has the setting ON and we're on a packaged Windows
 * build, ensure the entries are (re)installed. This self-heals after an update
 * that changed the exe path, without waiting for the user to re-toggle. When the
 * setting is OFF, best-effort remove any stale entries so on-disk state matches
 * the preference. No-op off-Windows / in dev. Never throws.
 */
export function reconcileShellIntegration(enabled: boolean): void {
  if (!canRegister()) return
  try {
    if (enabled) installShellIntegration()
    else if (isShellIntegrationInstalled()) uninstallShellIntegration()
  } catch {
    /* best-effort self-heal */
  }
}
