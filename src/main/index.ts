import { app, shell, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification, nativeImage } from 'electron'
import { join, sep } from 'path'
import { AgentManager } from './agentManager'
import { SessionManager } from './sessionManager'
import { PtyManager } from './ptyManager'
import { PixelOfficeClient } from './pixelOffice'
import { resolveCliJs, resolveModelCatalogJson, resolveMcpCatalogJson, nodeRunner } from './cli'
import { spawn } from 'child_process'
import type { McpCatalogServer, McpJsonEntry } from './agentManager'
import * as appSettings from './appSettings'
import { initAutoUpdate, checkForUpdatesManually } from './autoUpdate'
import {
  installShellIntegration,
  uninstallShellIntegration,
  isShellIntegrationInstalled,
  shellIntegrationStatus,
  reconcileShellIntegration,
  parseOpenFolderArg,
  isWindows
} from './shellIntegration'
import { readFileSync } from 'fs'

/** One provider family's model catalog, as emitted by `autodev models --json`. */
interface ModelCatalogEntry {
  family: string
  default: string
  models: Array<{ id: string; label: string; contextLimit: number }>
}
type ModelCatalog = ModelCatalogEntry[]

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
// True once the app has begun quitting — gates OS notifications so shutdown never
// emits a burst of toasts.
let quitting = false
let isQuitting = false
// A folder passed via `--open-folder` (Windows Explorer right-click) before the
// renderer has mounted its IPC listener. Held here until the renderer pulls it via
// `app:consumeOpenFolder` on first mount (cold-start path). `rendererReady` flips
// true then, so later (warm) deliveries broadcast `app:openFolder` directly.
let pendingOpenFolder: string | null = null
let rendererReady = false
const manager = new AgentManager()
const sessions = new SessionManager()
const ptys = new PtyManager()
const office = new PixelOfficeClient()

// --- single-instance lock --------------------------------------------------
// Required so a second launch (e.g. Explorer's right-click verb while the app is
// already running) relays its argv to the running instance instead of starting a
// rival process. Without the lock, two app copies would fight over the tray, the
// PTYs and the office socket. If we don't get the lock we are the second instance:
// Electron delivers our argv to the primary via `second-instance` below, so we
// quit immediately.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    // A second launch relayed its command line to us. Focus our window and, if it
    // carried `--open-folder <path>`, open that folder as an agent.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
    const folder = parseOpenFolderArg(argv)
    if (folder) deliverOpenFolder(folder)
  })
}

/**
 * Route a folder (from `--open-folder`) to the renderer's "open as agent" flow.
 * If the renderer has mounted (rendererReady), push it live via `app:openFolder`;
 * otherwise stash it for the renderer to pull on first mount (cold start). Also
 * raises the window so the user lands in the app either way.
 */
function deliverOpenFolder(p: string): void {
  if (!p) return
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }
  if (rendererReady) broadcast('app:openFolder', p)
  else pendingOpenFolder = p
}

/**
 * Only ever hand http(s)/mailto URLs to the OS URL dispatcher. shell.openExternal
 * forwards its string to the OS handler, so other schemes (file://, smb://,
 * custom protocol handlers) are a known local-file / code-execution vector — and
 * some of these URLs are built from remote pixel-office data (e.g. office.slug).
 */
function openExternalSafe(url: string): void {
  try {
    const p = new URL(url).protocol
    if (p === 'http:' || p === 'https:' || p === 'mailto:') void shell.openExternal(url)
  } catch { /* not a valid URL — drop */ }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'AutoDev',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The preload imports only contextBridge + ipcRenderer (both available in a
      // sandboxed preload) and the renderer touches Node only through window.api,
      // so the OS-level sandbox costs nothing while containing a renderer
      // compromise away from the privileged IPC surface (pty/cli/file reads).
      sandbox: true,
      contextIsolation: true
    }
  })

  // Camera / mic permission for the task-composer "Take photo" capture. The
  // renderer is a fixed local SPA (file:// packaged, or the dev server) that can't
  // navigate away, so getUserMedia is only ever requested by our own origin —
  // allow `media`, deny everything else. Both handlers are set: the request
  // handler covers the getUserMedia prompt, the check handler covers the
  // synchronous permission probe some Chromium paths run first.
  const isOwnOrigin = (url: string): boolean => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    return url.startsWith('file://') || (!!dev && url.startsWith(dev))
  }
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permission === 'media' && isOwnOrigin(details.requestingUrl || 'file://'))
  })
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    permission === 'media' && (requestingOrigin === 'null' || isOwnOrigin(requestingOrigin || 'file://'))
  )

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // Closing the window must NOT SIGKILL every running agent. If loops are active,
  // hide to the tray and keep them running; the user quits explicitly from the
  // tray (or the in-app Quit) which sets isQuitting.
  mainWindow.on('close', (e) => {
    if (!isQuitting && manager.runningCount() > 0) {
      e.preventDefault()
      mainWindow?.hide()
      // Only surface the tray toast when desktop notifications are enabled (off by
      // default) — the hide-to-tray behavior itself is unconditional.
      if (appSettings.getDesktopNotifications() && Notification.isSupported()) {
        new Notification({ title: 'AutoDev still running', body: `${manager.runningCount()} agent(s) keep working in the background. Reopen or quit from the tray icon.` }).show()
      }
    }
  })
  if (process.env['OPEN_DEVTOOLS']) mainWindow.webContents.openDevTools({ mode: 'bottom' })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    openExternalSafe(details.url)
    return { action: 'deny' }
  })
  // The renderer is a fixed SPA — it should never navigate the top-level frame.
  // Block any attempt (a stray link, injected content) from replacing the app.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!dev || !url.startsWith(dev)) e.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// --- push manager events to the renderer ----------------------------------
function broadcast(channel: string, payload: unknown): void {
  // Guard the window AND its webContents against destruction: on quit (esp. while a
  // PTY is still streaming, e.g. closing the app mid-spawn) a `pty:data` event can
  // arrive after the webContents is gone → `send` throws "Object has been destroyed"
  // as an uncaught main-process exception. Drop the frame instead.
  if (!mainWindow || mainWindow.isDestroyed()) return
  const wc = mainWindow.webContents
  if (!wc || wc.isDestroyed()) return
  try { wc.send(channel, payload) } catch { /* window tearing down */ }
}

// --- pixel-office presence → local agent list ------------------------------
// The Agents list is built from local process detection only; on its own it can't
// see that a workspace's office character is ONLINE (kept alive by an mcp-operate
// bridge or a loop on a remote VM). Poll the office's isConnected truth and feed
// it to the manager so those agents read as running/online instead of "Stopped".
// Best-effort: any failure (not logged in, offline) leaves presence empty, so the
// list falls back to purely-local truth. Only re-broadcast when it actually changed.
let _officePoll: NodeJS.Timeout | null = null
async function refreshOfficePresence(): Promise<void> {
  try {
    const ags = await office.listAgents()
    const changed = manager.setOfficeOnline(ags.map((a) => ({ slug: a.slug, id: a.id, online: a.online, status: a.status, officeSlug: a.officeSlug, avatarUrl: a.avatarUrl, color: a.color })))
    if (changed) broadcast('agents:changed', null)
  } catch { /* not connected / offline — leave office presence empty */ }
}
function startOfficePolling(): void {
  if (_officePoll) return
  void refreshOfficePresence()
  _officePoll = setInterval(refreshOfficePresence, 8000)
}
manager.on('agentUpdated', (s) => broadcast('agent:updated', s))
manager.on('changed', () => broadcast('agents:changed', null))
manager.on('log', (l) => broadcast('agent:log', l))

// --- OS notifications on meaningful transitions ---------------------------
// The point of autonomy is NOT sitting and watching. Fire a native notification
// when an agent needs attention (needs-auth / crashed / stalled / rate-limited)
// or finishes its work (working → idle). Only on a real state TRANSITION so the
// 5s poll doesn't spam.
const _lastActivity = new Map<string, string>()
manager.on('agentUpdated', (s: any) => {
  if (!s?.path || !Notification.isSupported()) return
  // Desktop notifications are OFF by default — the user opts in via Settings.
  // (They were noisy/false-positive; live progress is shown in-app instead.)
  if (!appSettings.getDesktopNotifications()) return
  // Never fire OS toasts while the app is shutting down (exiting to the tray used
  // to unleash a stream of them).
  if (quitting) return
  const prev = _lastActivity.get(s.path)
  _lastActivity.set(s.path, s.activity)
  if (prev === undefined || prev === s.activity) return
  // NOTIFICATION POLICY (user directive): desktop toasts fire ONLY for EXCEPTIONS
  // that actually need the user — needs-auth / crashed / stalled / rate-limited.
  // The routine "✓ finished — now idle" toast was REMOVED: it added no signal and,
  // with an idle-polling agent flapping working↔idle, spammed the desktop. Live
  // progress is shown IN-APP (the working state + the events view), not as OS
  // toasts. (Important user-decision/choice events are surfaced in-app; add them
  // here only if a dedicated 'needs-you' signal is wired.)
  let title: string | null = null
  const body = s.error || s.name
  // Only DEFINITE provider exceptions toast: needs-auth / crashed / rate-limited
  // come from explicit hooks (reauth_required / StopFailure / rate_limit), so they
  // are real. 'stalled' is a SILENCE-BASED HEURISTIC — a quiet-but-fine agent
  // (headless grok on a long tool, waiting) trips it, so it must NOT toast (it
  // wrongly said "the agent may be hung"). Stalled stays an in-app status the user
  // verifies against the events log; no desktop notification.
  if (s.activity === 'needs-auth') title = `🔑 ${s.name} needs re-authentication`
  else if (s.activity === 'crashed') title = `⚠ ${s.name} crashed`
  else if (s.activity === 'rate-limited') title = `⏳ ${s.name} rate-limited`
  if (!title) return
  const n = new Notification({ title, body })
  n.on('click', () => { mainWindow?.show(); mainWindow?.focus(); broadcast('agent:focus', s.path) })
  n.show()
})

// --- tray + graceful background running -----------------------------------
function refreshTray(): void {
  if (!tray) return
  const n = manager.runningCount()
  tray.setToolTip(n > 0 ? `AutoDev — ${n} agent(s) running` : 'AutoDev')
  // Windows-only: a checkbox to toggle the Explorer "Open as AutoDev agent"
  // right-click menu, staying in sync with the Settings toggle (both call the same
  // install/uninstall + persist + broadcast). Hidden on Linux/mac.
  const shellItems = isWindows()
    ? [
        {
          label: 'Open-folder right-click menu',
          type: 'checkbox' as const,
          checked: isShellIntegrationInstalled(),
          click: (item: { checked: boolean }) => {
            const on = item.checked
            if (on) installShellIntegration()
            else uninstallShellIntegration()
            appSettings.setShellIntegration(on)
            refreshTray()
            broadcast('shell:integrationChanged', { installed: isShellIntegrationInstalled(), on })
          }
        },
        { type: 'separator' as const }
      ]
    : []
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: n > 0 ? `${n} agent(s) running` : 'No agents running', enabled: false },
    { type: 'separator' },
    { label: 'Show AutoDev', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { label: 'Check for Updates…', click: () => { checkForUpdatesManually() } },
    { type: 'separator' },
    ...shellItems,
    // Always a clearly-labelled quit so the app is quittable even if the tray
    // icon is hidden by the desktop's icon theme. When agents are running the
    // label spells out the side effect so it's never a surprise stop.
    { label: n > 0 ? `Quit AutoDev — stops ${n} agent${n === 1 ? '' : 's'}` : 'Quit AutoDev', click: () => { isQuitting = true; app.quit() } }
  ]))
}
function createTray(): void {
  try {
    // Resolve a REAL icon in both layouts. Packaged: electron-builder stages
    // build/icons/32x32.png → <resourcesPath>/icon.png via `extraResources` (the
    // same root the bundled CLI ships to). Dev: app.getAppPath() is the repo root,
    // so build/icons/32x32.png resolves there. The old path
    // (join(__dirname,'../../resources/icon.png')) pointed at a file that exists in
    // NEITHER layout → always createEmpty() → invisible tray on Linux.
    const devIcon = join(app.getAppPath(), 'build', 'icons', '32x32.png')
    const packagedIcon = join(process.resourcesPath ?? '', 'icon.png')
    let img = nativeImage.createFromPath(packagedIcon)
    if (img.isEmpty()) img = nativeImage.createFromPath(devIcon)
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 18, height: 18 }))
    tray.on('click', () => { if (mainWindow?.isVisible()) mainWindow.focus(); else mainWindow?.show() })
    refreshTray()
    manager.on('changed', refreshTray)
  } catch { /* tray unavailable (headless CI) — skip */ }
}
sessions.on('data', (d) => broadcast('session:data', d))
ptys.on('data', (d) => broadcast('pty:data', d))
// Map an Operate PTY id → its office scratch cwd (Change 1). Populated in
// pty:spawn for `op-*` ids so that when the PTY exits we can de-register the
// tracked office-operate Agents-tab row for that character.
const operatePtyCwd = new Map<string, string>()

/**
 * Reap a PTY child's WHOLE process tree via the bundled CLI's cross-platform
 * `kill-tree <pid>` (taskkill /T /F on win32). Killing the app-spawned Operate PTY
 * alone leaves an interactive grok's child tree alive on Windows; this cleans it
 * up. Best-effort ONLY: fire-and-forget, never throws, never blocks the stop flow,
 * and no-ops when the pid is missing/invalid or the CLI can't be resolved. Capture
 * the pid via ptys.pidOf(id) BEFORE ptys.kill(id) (which drops the entry).
 */
function killTree(pid: number | undefined): void {
  try {
    if (!pid || pid <= 1) return
    const cliJs = resolveCliJs()
    if (!cliJs) return
    const { cmd, baseEnv } = nodeRunner()
    const child = spawn(cmd, [cliJs, 'kill-tree', String(pid)], {
      env: baseEnv,
      windowsHide: true,
      detached: false,
      stdio: 'ignore'
    })
    // Detach from our lifecycle; a spawn failure must never surface.
    child.on('error', () => {})
    child.unref?.()
  } catch {
    /* best-effort — a failed reap must never block or throw in the stop flow */
  }
}

ptys.on('exit', (d) => {
  broadcast('pty:exit', d)
  const cwd = operatePtyCwd.get(d.id)
  if (cwd) { operatePtyCwd.delete(d.id); manager.endOperate(cwd) }
})

// --- IPC -------------------------------------------------------------------
// The installed app version (electron-builder stamps package.json → app.getVersion()).
ipcMain.handle('app:version', () => app.getVersion())
ipcMain.handle('agents:list', () => manager.list())
ipcMain.handle('agents:add', (_e, path: string) => manager.add(path))
ipcMain.handle('workspace:info', (_e, path: string) => manager.workspaceInfo(path))
ipcMain.handle('agents:remove', (_e, path: string) => { manager.remove(path); return true })
// Remove from the list AND delete the workspace folder from disk (guarded to a
// registered/`.autodev`-bearing path, never a filesystem/home root).
ipcMain.handle('agents:removeFolder', (_e, path: string) => manager.removeFolder(path))
ipcMain.handle('agent:state', (_e, path: string) => manager.readState(path))
ipcMain.handle('agent:start', (_e, path: string, provider?: string) => manager.start(path, provider))
ipcMain.handle('agent:stop', (_e, path: string) => {
  // A locally-operated office character (Change 1) has no loop to stop — map Stop
  // to closing its Operate PTY (owned by the renderer's term registry, keyed by
  // id). Killing the PTY fires ptys 'exit' → manager.endOperate, which drops the
  // row. If no PTY is tracked (edge), just drop the tracked entry.
  if (manager.isOperating(path)) {
    let killed = false
    for (const [id, cwd] of operatePtyCwd) if (cwd === path) {
      // Capture the OS pid BEFORE kill() drops the entry, then reap grok's whole
      // child tree (essential on Windows where the PTY kill leaves it alive).
      const pid = ptys.pidOf(id)
      ptys.kill(id); killed = true
      killTree(pid)
    }
    if (!killed) manager.endOperate(path)
    return true
  }
  manager.stop(path); return true
})
// A native confirmation dialog driven from the main process. `window.confirm`
// in the sandboxed renderer is unreliable (it can return false without ever
// showing a dialog), which silently no-op'd destructive actions — so route them
// through the OS dialog instead. Returns true only when the user confirms.
ipcMain.handle('dialog:confirm', async (_e, message: string, detail?: string) => {
  const r = await dialog.showMessageBox(mainWindow ?? undefined as unknown as BrowserWindow, {
    type: 'question', buttons: ['Cancel', 'OK'], defaultId: 1, cancelId: 0, message, detail
  })
  return r.response === 1
})
ipcMain.handle('agent:message', (_e, path: string, text: string) => manager.sendMessage(path, text))
// Save a task attachment (picked file / captured photo) INTO the agent workspace,
// so the agent can read it when acting on the task. Returns the workspace-relative
// path the composer references in the task line. Path safety is enforced in the
// manager (name sanitise + in-attachments-dir assertion).
ipcMain.handle('attachments:save', (_e, agentPath: string, filename: string, dataBase64: string) =>
  manager.saveAttachment(agentPath, filename, dataBase64)
)
ipcMain.handle('agent:readMcp', (_e, path: string) => manager.readMcp(path))
ipcMain.handle('agent:writeMcp', (_e, path: string, content: string) => manager.writeMcp(path, content))
ipcMain.handle('agent:mcpStatus', (_e, path: string) => manager.mcpStatus(path))
// Detected creative apps (Blender/GIMP) → enable-as-MCP. Both route through the
// bundled CLI (mcpDetect / mcpEnableApp → runCli), so enabling propagates the
// server to every provider (syncProjectMcpServers) instead of just poking
// .mcp.json the way writeMcp would.
ipcMain.handle('mcp:detect', (_e, path: string) => manager.mcpDetect(path))
ipcMain.handle('mcp:enableApp', (_e, opts: { path: string; app: string; gimpClient?: string }) =>
  manager.mcpEnableApp(opts)
)
ipcMain.handle('cli:run', (_e, args: string[], cwd?: string) => manager.runCli(args, cwd))
// The provider model catalog (id/label/contextLimit per family) sourced from the
// bundled CLI's `autodev models --json`. The catalog is STATIC for a given CLI
// version, so cache it in-memory after the first successful read. If the live CLI
// run ever fails (slow/errored IPC), fall back to the GENERATED model-catalog.json
// shipped beside the bundled CLI (written from that same `autodev models --json`
// at build time) — a REAL, versioned catalog, so the fallback can never drift.
// Only when neither is available (no CLI at all) do we return [].
function readGeneratedCatalog(): ModelCatalog | null {
  try {
    const p = resolveModelCatalogJson()
    if (!p) return null
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as ModelCatalog
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null
  } catch { return null }
}
let _modelCatalog: ModelCatalog | null = null
ipcMain.handle('models:list', async (): Promise<ModelCatalog> => {
  if (_modelCatalog) return _modelCatalog
  try {
    const r = await manager.runCli(['models', '--json'])
    if (r.code === 0 && r.stdout.trim().startsWith('[')) {
      const parsed = JSON.parse(r.stdout) as ModelCatalog
      if (Array.isArray(parsed) && parsed.length > 0) { _modelCatalog = parsed; return parsed }
    }
  } catch { /* live CLI failed — fall through to the generated on-disk catalog */ }
  const gen = readGeneratedCatalog()
  if (gen) { _modelCatalog = gen; return gen }
  return []
})
// The pickable MCP catalog (`autodev mcp catalog --json`) — the single source of
// truth for the app's default/bulk/per-agent MCP pickers. STATIC per CLI version,
// so cache after the first successful read; if the live CLI run fails, fall back
// to the GENERATED mcp-catalog.json shipped beside the bundled CLI (written from
// that same command at build time) so the picker works even offline. Mirrors
// `models:list` exactly.
function readGeneratedMcpCatalog(): { servers: McpCatalogServer[] } | null {
  try {
    const p = resolveMcpCatalogJson()
    if (!p) return null
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { servers?: McpCatalogServer[] }
    return Array.isArray(parsed?.servers) && parsed.servers.length > 0 ? { servers: parsed.servers } : null
  } catch { return null }
}
let _mcpCatalog: { servers: McpCatalogServer[] } | null = null
ipcMain.handle('mcp:catalog', async (): Promise<{ servers: McpCatalogServer[] } | { error: string }> => {
  if (_mcpCatalog) return _mcpCatalog
  const live = await manager.mcpCatalog()
  if ('servers' in live && live.servers.length > 0) { _mcpCatalog = live; return live }
  const gen = readGeneratedMcpCatalog()
  if (gen) { _mcpCatalog = gen; return gen }
  return live // propagate the {error} (or empty {servers:[]}) when nothing else is available
})
ipcMain.handle('mcp:list', (_e, path: string) => manager.mcpList(path))
// Every layered MCP write (default seed / per-folder bulk / per-agent picker)
// routes through here → `autodev mcp <op>` → provider-sync + `_meta`, never writeMcp.
ipcMain.handle('mcp:apply', (_e, opts: { path: string; op: 'add' | 'remove' | 'enable' | 'disable'; name: string; server?: McpJsonEntry }) =>
  manager.mcpApply(opts)
)
ipcMain.handle('agent:exportTrace', (_e, path: string, output: string) => manager.exportTrace(path, output))
ipcMain.handle('cli:check', () => { const p = resolveCliJs(); return { found: !!p, path: p } })
ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('dialog:saveFile', async (_e, defaultName: string) => {
  const r = await dialog.showSaveDialog(mainWindow!, { defaultPath: defaultName, filters: [{ name: 'ZIP', extensions: ['zip'] }] })
  return r.canceled ? null : r.filePath
})
ipcMain.handle('dialog:pickFile', async (_e, filters?: { name: string; extensions: string[] }[]) => {
  const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], filters })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
ipcMain.handle('shell:openExternal', (_e, url: string) => openExternalSafe(url))
// --- Sessions (capture: cross-provider discover + claude live attach) ------
ipcMain.handle('sessions:discover', () => sessions.discover())
ipcMain.handle('sessions:backlog', (_e, opts: { file?: string; provider?: string; id?: string; cwd?: string }) => sessions.backlog(opts))
ipcMain.handle('sessions:open', (_e, file: string) => { sessions.open(file); return true })
ipcMain.handle('sessions:close', (_e, file: string) => { sessions.close(file); return true })
// --- Interactive PTY panes (spawn: run `claude` in a chosen folder) --------
ipcMain.handle('pty:spawn', (_e, id: string, opts: { cwd: string; command?: string; cols?: number; rows?: number; keepShell?: boolean }) => {
  // Remember an Operate PTY's cwd so its exit de-registers the tracked office
  // character (Change 1). Operate ids are `op-<officeSlug>-<agentId>[#gen]`.
  if (id.startsWith('op-') && opts?.cwd) operatePtyCwd.set(id, opts.cwd)
  return ptys.spawn(id, opts)
})
ipcMain.handle('pty:write', (_e, id: string, data: string) => { ptys.write(id, data); return true })
ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) => { ptys.resize(id, cols, rows); return true })
ipcMain.handle('pty:kill', (_e, id: string) => { ptys.kill(id); return true })
// --- Remote pixel-office: connect + list + operate agents -------------------
// After a fresh login / token re-verify, immediately refresh office presence so
// the Agents list reflects online characters without waiting for the 8s poll.
ipcMain.handle('office:login', async (_e, baseUrl: string, email: string, password: string) => {
  const r = await office.login(baseUrl, email, password)
  if ((r as { ok?: boolean }).ok) { startOfficePolling(); void refreshOfficePresence() }
  return r
})
ipcMain.handle('office:autoConnect', async () => {
  const ok = await office.autoConnect()
  if (ok) { startOfficePolling(); void refreshOfficePresence() }
  return ok
})
ipcMain.handle('office:status', () => office.status())
ipcMain.handle('office:ping', (_e, baseUrl: string) => office.ping(baseUrl))
// --- App preferences (non-secret; userData/app-settings.json) ---------------
// Read live by office.status(), so a changed base takes effect on the NEXT
// connect from any login form without a process restart.
ipcMain.handle('settings:get', () => appSettings.getSettings())
ipcMain.handle('settings:set', (_e, patch: { officeBaseUrl?: string; defaultModels?: Record<string, string>; defaultMcp?: appSettings.DefaultMcpEntry[]; advancedMode?: boolean; theme?: 'system' | 'dark' | 'light'; cozempicAutoInit?: boolean; desktopNotifications?: boolean; shellIntegration?: boolean }) => appSettings.updateSettings(patch ?? {}))
// --- Windows shell integration ("Open as AutoDev agent" right-click) ---------
// Status the Settings toggle / tray checkbox reflect on load: whether the entries
// are registered AND whether this build can register them (Windows + packaged).
ipcMain.handle('shell:integrationStatus', () => shellIntegrationStatus())
// Toggle the integration: ON installs the HKCU context-menu entries, OFF removes
// them. The persisted preference is kept CONSISTENT with the registry (both driven
// here), and the change is broadcast so the tray checkbox and Settings toggle stay
// in sync wherever the toggle was flipped.
ipcMain.handle('shell:integrationSet', (_e, on: boolean) => {
  const r = on ? installShellIntegration() : uninstallShellIntegration()
  appSettings.setShellIntegration(!!on)
  refreshTray()
  broadcast('shell:integrationChanged', { installed: r.installed, on: !!on })
  return r
})
// The renderer pulls a folder passed via `--open-folder` on cold start (before its
// IPC listener existed). Returns the pending path once and clears it; also marks
// the renderer ready so later (warm) deliveries broadcast `app:openFolder` live.
ipcMain.handle('app:consumeOpenFolder', () => {
  rendererReady = true
  const p = pendingOpenFolder
  pendingOpenFolder = null
  return p
})
ipcMain.handle('office:logout', () => { office.logout(); return true })
ipcMain.handle('office:agents', () => office.listAgents())
ipcMain.handle('office:operate', async (_e, officeSlug: string, agentId: string, agentSlug: string, provider?: string, name?: string) => {
  // MUTUAL EXCLUSION: operating a character and running its tracked LOOP both use
  // the SAME scratch dir (~/.autodev-app/offices/<slug>/<agentSlug>). Running both
  // launches TWO grok/claude processes in that one dir, fighting over the single
  // office connection + provider session (task_already_running / "Grok stopped
  // before this turn finished" / endless retry). So BEFORE launching the Operate
  // PTY, STOP any tracked, non-operating LOOP at that exact dir — leaving only one.
  // resolveOperateCwd derives the same dir operate() will use, so we can stop the
  // loop up-front (stopping after operate() returns is too late — grok has launched).
  try {
    const cwd = office.resolveOperateCwd(officeSlug, agentSlug, agentId)
    if (cwd && manager.list().some((s) => s.path === cwd) && !manager.isOperating(cwd)) {
      manager.stop(cwd) // kills the loop + marks stay-stopped so the supervisor won't respawn it
    }
  } catch { /* pre-stop is best-effort — never block the operate launch */ }
  const r = await office.operate(officeSlug, agentId, agentSlug, provider ?? '')
  // Register the operating character as a tracked Agents-tab row (Change 1) so it
  // shows in the fleet while its Operate PTY runs. De-registered on PTY exit (see
  // the ptys 'exit' handler). Idempotent by scratch dir — re-operating never dupes.
  if ((r as { ok?: boolean; cwd?: string }).ok && (r as { cwd?: string }).cwd) {
    const cwd = (r as { cwd: string }).cwd
    try {
      manager.registerOperate(cwd, {
        name: name || agentSlug || agentId,
        provider: provider || undefined,
        officeSlug,
        officeAgentSlug: agentSlug || agentId,
        officeAgentId: agentId
      })
    } catch { /* tracking is best-effort — never fail the operate launch */ }
  }
  return r
})
// Spawn an ENTIRE office as TRACKED autodev-cli LOOPS (not interactive PTYs).
// pixelOffice.spawnOffice does the office-side prep (BLOCK-IF-ANY-ONLINE, scratch
// dir + presence/MCP bind + provider) and returns the prepared workspaces; here we
// register each with AgentManager and start its loop, so they appear in the sidebar
// grouped under the office, count toward runningCount (Stop all activates), stream
// to `agent:log`, and survive backgrounding. Idempotent: manager.add skips an
// already-tracked path and manager.start no-ops an already-running loop.
ipcMain.handle('office:spawnOffice', async (_e, officeSlug: string, overrides?: Array<{ agentId: string; provider?: string }>) => {
  const prep = await office.spawnOffice(officeSlug, overrides)
  if ('error' in prep) return prep
  for (const a of prep.agents) {
    // MUTUAL EXCLUSION (reverse of office:operate): if this character is currently
    // being OPERATED (an interactive PTY runs in its scratch dir), do NOT also start
    // a tracked loop there — two grok/claude processes in one dir fight over the
    // single office connection + provider session. Skip it; the active Operate wins.
    if (manager.isOperating(a.path)) continue
    const added = manager.add(a.path)
    if ((added as { error?: string })?.error) continue // bind should have written settings.json; skip if not a workspace
    await manager.start(a.path, a.provider)
  }
  // Reflect the freshly-online characters without waiting for the 8s poll.
  void refreshOfficePresence()
  return { ok: true as const, agents: prep.agents }
})
// Stop an entire office: STOP every tracked agent bound to that office (its
// workspaces all live under the office scratch root) WITHOUT deleting anything.
// Stop must be non-destructive — the scratch dirs (and their work/session) are
// preserved so the office can be re-spawned/resumed. Destructive cleanup lives in
// `office:removeOffice`. Loops → manager.stop (kills the loop + marks stay-stopped
// so the `autodev office` supervisor won't respawn it, folder KEPT); operate
// characters → kill the Operate PTY (removeFolder hard-refuses operate paths, and
// stop must catch characters operated AFTER the initial spawn, else "Stop office
// didn't stop all").
ipcMain.handle('office:stopOffice', async (_e, officeSlug: string) => {
  const root = office.officeLoopRoot(officeSlug)
  if (!root) return { error: 'Invalid office identifier.' }
  const paths = manager.list()
    .map((s) => s.path)
    .filter((p) => p === root || p.startsWith(root + sep))
  for (const p of paths) {
    if (manager.isOperating(p)) {
      let killed = false
      for (const [id, cwd] of operatePtyCwd) if (cwd === p) {
        const pid = ptys.pidOf(id)
        ptys.kill(id); killed = true
        killTree(pid)
      }
      if (!killed) manager.endOperate(p)
    } else {
      manager.stop(p)
    }
  }
  void refreshOfficePresence()
  return { ok: true as const, stopped: paths.length }
})
// Remove an entire office locally: stop THEN delete the scratch dir of every
// tracked workspace bound to the office (the destructive counterpart to
// stopOffice, surfaced as an explicit "Remove office" action). Operate characters
// are stopped via their PTY first (removeFolder refuses operate paths), then their
// scratch dir is deprovisioned; loops go straight through removeFolder (stop +
// delete). Does NOT delete the office itself in the pixel-office backend — only
// the local scratch workspaces this app created under ~/.autodev-app/offices.
ipcMain.handle('office:removeOffice', async (_e, officeSlug: string) => {
  const root = office.officeLoopRoot(officeSlug)
  if (!root) return { error: 'Invalid office identifier.' }
  const paths = manager.list()
    .map((s) => s.path)
    .filter((p) => p === root || p.startsWith(root + sep))
  let removed = 0
  for (const p of paths) {
    // Operate characters must have their PTY killed + be de-registered FIRST —
    // removeFolder hard-refuses a path while it is still in _operating. After
    // endOperate the scratch dir is deletable via its `.autodev` workspace marker.
    if (manager.isOperating(p)) {
      for (const [id, cwd] of operatePtyCwd) if (cwd === p) {
        const pid = ptys.pidOf(id)
        ptys.kill(id)
        killTree(pid)
      }
      manager.endOperate(p)
    }
    const r = manager.removeFolder(p)
    if ('ok' in r) removed++
  }
  void refreshOfficePresence()
  return { ok: true as const, removed }
})
// Per-account provider key usage/limits (Claude sub 5h+weekly, OpenRouter credit,
// Copilot) read from the connected office's deployer credential vault. Fails soft
// to [] so the UI degrades rather than crashes.
ipcMain.handle('office:keyUsage', () => office.keyUsage())
ipcMain.handle('office:steer', (_e, agentId: string, text: string) => office.steer(agentId, text))
ipcMain.handle('office:messages', (_e, officeSlug: string, agentRef: string) => office.messages(officeSlug, agentRef))
ipcMain.handle('office:agentEvents', (_e, officeSlug: string, agentRef: string, limit?: number) => office.agentEvents(officeSlug, agentRef, limit))
ipcMain.handle('office:createCharacter', (_e, officeId: number, name: string, opts?: { avatarIndex?: number; color?: string; emoji?: string }) => office.createCharacter(officeId, name, opts))
ipcMain.handle('office:offices', () => office.offices())
ipcMain.handle('office:setupUrl', (_e, officeSlug: string, agentId: string) => office.setupUrl(officeSlug, agentId))
ipcMain.handle('office:connectSession', (_e, officeSlug: string, officeId: number, cwd: string, sessionId: string, name: string) => office.connectSession(officeSlug, officeId, cwd, sessionId, name))
ipcMain.handle('office:createOffice', (_e, name: string, description: string) => office.createOffice(name, description))
ipcMain.handle('office:generateTeam', (_e, officeId: number, prompt: string, count: number) => office.generateTeam(officeId, prompt, count))
ipcMain.handle('office:writeSharedMcp', (_e, folder: string, officeSlug: string, agents: Array<{ id?: string; slug?: string; name?: string }>, fileBrowser?: boolean) => office.writeSharedMcp(folder, officeSlug, agents, !!fileBrowser))
// Bind an existing workspace to an office character (presence + office-MCP).
ipcMain.handle('office:bindWorkspace', (_e, cwd: string, officeSlug: string, want: { id?: string; slug?: string; name?: string }, fileBrowser?: boolean) => office.bindWorkspaceToOffice(cwd, officeSlug, want, !!fileBrowser))
// Delete an office character (agent row) from the pixel office.
ipcMain.handle('office:deleteAgent', (_e, officeSlug: string, agentId: string) => office.deleteOfficeAgent(officeSlug, agentId))
// Update an office character's owner-editable settings (provider / model / name /
// file-browser). Persists to the office DB via PATCH /api/agents/{id}; the badge
// updates on the next presence poll and the next spawn/operate uses the new engine.
ipcMain.handle('office:updateCharacter', (_e, agentId: string, patch: { provider?: string; model?: string; name?: string; fileBrowserEnabled?: boolean }) => office.updateCharacter(agentId, patch))

app.whenReady().then(() => {
  createWindow()
  createTray()
  // Windows shell integration: if the user enabled the "Open as AutoDev agent"
  // right-click menu, (re)install it now so it self-heals after an update changed
  // the exe path; if disabled, clear any stale entries. No-op off-Windows / in dev.
  reconcileShellIntegration(appSettings.getShellIntegration())
  // Cold start: honor a folder passed via `--open-folder` (Explorer right-click
  // launching a fresh instance). Stashed for the renderer to pull on first mount.
  const coldFolder = parseOpenFolderArg(process.argv)
  if (coldFolder) deliverOpenFolder(coldFolder)
  // Auto-update (packaged builds only; guarded + try/catch so a missing feed is a
  // no-op). Downloads in the background, then ASKS before restarting to install.
  initAutoUpdate(() => mainWindow)
  // Re-verify the stored office token, then start polling office presence so the
  // Agents list reflects which characters are live in the office from launch.
  office.autoConnect().catch(() => false).finally(() => startOfficePolling())
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

// Only truly quit when no agents are running (else the window-close guard has
// hidden us to the tray and the loops keep going).
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && manager.runningCount() === 0) app.quit() })
app.on('before-quit', () => { quitting = true; manager.disposeAll(); sessions.closeAll(); ptys.killAll() })
