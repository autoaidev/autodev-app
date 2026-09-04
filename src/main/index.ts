import { app, shell, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification, nativeImage } from 'electron'
import { join, sep } from 'path'
import { AgentManager } from './agentManager'
import { SessionManager } from './sessionManager'
import { PtyManager } from './ptyManager'
import { PixelOfficeClient } from './pixelOffice'
import { resolveCliJs, resolveModelCatalogJson } from './cli'
import * as appSettings from './appSettings'
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
let isQuitting = false
const manager = new AgentManager()
const sessions = new SessionManager()
const ptys = new PtyManager()
const office = new PixelOfficeClient()

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

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // Closing the window must NOT SIGKILL every running agent. If loops are active,
  // hide to the tray and keep them running; the user quits explicitly from the
  // tray (or the in-app Quit) which sets isQuitting.
  mainWindow.on('close', (e) => {
    if (!isQuitting && manager.runningCount() > 0) {
      e.preventDefault()
      mainWindow?.hide()
      if (Notification.isSupported()) {
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
  const prev = _lastActivity.get(s.path)
  _lastActivity.set(s.path, s.activity)
  if (prev === undefined || prev === s.activity) return
  let title: string | null = null
  let body = s.error || s.name
  if (s.activity === 'needs-auth') title = `🔑 ${s.name} needs re-authentication`
  else if (s.activity === 'crashed') title = `⚠ ${s.name} crashed`
  else if (s.activity === 'stalled') title = `⚠ ${s.name} stalled`
  else if (s.activity === 'rate-limited') title = `⏳ ${s.name} rate-limited`
  else if (s.activity === 'idle' && prev === 'working') { title = `✓ ${s.name} finished`; body = `${s.tasks?.done ?? 0} tasks done — now idle` }
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: n > 0 ? `${n} agent(s) running` : 'No agents running', enabled: false },
    { type: 'separator' },
    { label: 'Show AutoDev', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { type: 'separator' },
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
ptys.on('exit', (d) => broadcast('pty:exit', d))

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
ipcMain.handle('agent:stop', (_e, path: string) => { manager.stop(path); return true })
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
ipcMain.handle('pty:spawn', (_e, id: string, opts: { cwd: string; command?: string; cols?: number; rows?: number; keepShell?: boolean }) => ptys.spawn(id, opts))
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
ipcMain.handle('settings:set', (_e, patch: { officeBaseUrl?: string; defaultModels?: Record<string, string>; advancedMode?: boolean; theme?: 'system' | 'dark' | 'light' }) => appSettings.updateSettings(patch ?? {}))
ipcMain.handle('office:logout', () => { office.logout(); return true })
ipcMain.handle('office:agents', () => office.listAgents())
ipcMain.handle('office:operate', (_e, officeSlug: string, agentId: string, agentSlug: string) => office.operate(officeSlug, agentId, agentSlug))
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
    const added = manager.add(a.path)
    if ((added as { error?: string })?.error) continue // bind should have written settings.json; skip if not a workspace
    await manager.start(a.path, a.provider)
  }
  // Reflect the freshly-online characters without waiting for the 8s poll.
  void refreshOfficePresence()
  return { ok: true as const, agents: prep.agents }
})
// Stop an entire office: stop + untrack + delete the scratch dir of every tracked
// loop bound to that office (its workspaces all live under the office scratch root).
// Uses removeFolder so the office-key-bearing scratch dirs don't linger after stop.
ipcMain.handle('office:stopOffice', async (_e, officeSlug: string) => {
  const root = office.officeLoopRoot(officeSlug)
  if (!root) return { error: 'Invalid office identifier.' }
  const paths = manager.list()
    .map((s) => s.path)
    .filter((p) => p === root || p.startsWith(root + sep))
  for (const p of paths) manager.removeFolder(p)
  void refreshOfficePresence()
  return { ok: true as const, stopped: paths.length }
})
// Per-account provider key usage/limits (Claude sub 5h+weekly, OpenRouter credit,
// Copilot) read from the connected office's deployer credential vault. Fails soft
// to [] so the UI degrades rather than crashes.
ipcMain.handle('office:keyUsage', () => office.keyUsage())
ipcMain.handle('office:steer', (_e, agentId: string, text: string) => office.steer(agentId, text))
ipcMain.handle('office:messages', (_e, officeSlug: string, agentRef: string) => office.messages(officeSlug, agentRef))
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
  // Re-verify the stored office token, then start polling office presence so the
  // Agents list reflects which characters are live in the office from launch.
  office.autoConnect().catch(() => false).finally(() => startOfficePolling())
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

// Only truly quit when no agents are running (else the window-close guard has
// hidden us to the tray and the loops keep going).
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && manager.runningCount() === 0) app.quit() })
app.on('before-quit', () => { manager.disposeAll(); sessions.closeAll(); ptys.killAll() })
