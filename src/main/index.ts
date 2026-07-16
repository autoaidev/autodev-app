import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { AgentManager } from './agentManager'
import { SessionManager } from './sessionManager'
import { PtyManager } from './ptyManager'
import { PixelOfficeClient } from './pixelOffice'
import { resolveCliJs } from './cli'

let mainWindow: BrowserWindow | null = null
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
  mainWindow?.webContents.send(channel, payload)
}
manager.on('agentUpdated', (s) => broadcast('agent:updated', s))
manager.on('changed', () => broadcast('agents:changed', null))
manager.on('log', (l) => broadcast('agent:log', l))
sessions.on('data', (d) => broadcast('session:data', d))
ptys.on('data', (d) => broadcast('pty:data', d))
ptys.on('exit', (d) => broadcast('pty:exit', d))

// --- IPC -------------------------------------------------------------------
ipcMain.handle('agents:list', () => manager.list())
ipcMain.handle('agents:add', (_e, path: string) => manager.add(path))
ipcMain.handle('workspace:info', (_e, path: string) => manager.workspaceInfo(path))
ipcMain.handle('agents:remove', (_e, path: string) => { manager.remove(path); return true })
ipcMain.handle('agent:state', (_e, path: string) => manager.readState(path))
ipcMain.handle('agent:start', (_e, path: string, provider?: string) => manager.start(path, provider))
ipcMain.handle('agent:stop', (_e, path: string) => { manager.stop(path); return true })
ipcMain.handle('agent:message', (_e, path: string, text: string) => manager.sendMessage(path, text))
ipcMain.handle('agent:readMcp', (_e, path: string) => manager.readMcp(path))
ipcMain.handle('agent:writeMcp', (_e, path: string, content: string) => manager.writeMcp(path, content))
ipcMain.handle('cli:run', (_e, args: string[], cwd?: string) => manager.runCli(args, cwd))
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
// --- Claude sessions (capture: discover + live attach) ---------------------
ipcMain.handle('sessions:discover', () => sessions.discover())
ipcMain.handle('sessions:backlog', (_e, file: string) => sessions.backlog(file))
ipcMain.handle('sessions:open', (_e, file: string) => { sessions.open(file); return true })
ipcMain.handle('sessions:close', (_e, file: string) => { sessions.close(file); return true })
// --- Interactive PTY panes (spawn: run `claude` in a chosen folder) --------
ipcMain.handle('pty:spawn', (_e, id: string, opts: { cwd: string; command?: string; cols?: number; rows?: number; keepShell?: boolean }) => ptys.spawn(id, opts))
ipcMain.handle('pty:write', (_e, id: string, data: string) => { ptys.write(id, data); return true })
ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) => { ptys.resize(id, cols, rows); return true })
ipcMain.handle('pty:kill', (_e, id: string) => { ptys.kill(id); return true })
// --- Remote pixel-office: connect + list + operate agents -------------------
ipcMain.handle('office:login', (_e, baseUrl: string, email: string, password: string) => office.login(baseUrl, email, password))
ipcMain.handle('office:autoConnect', () => office.autoConnect())
ipcMain.handle('office:status', () => office.status())
ipcMain.handle('office:logout', () => { office.logout(); return true })
ipcMain.handle('office:agents', () => office.listAgents())
ipcMain.handle('office:operate', (_e, officeSlug: string, agentId: string, agentSlug: string) => office.operate(officeSlug, agentId, agentSlug))
ipcMain.handle('office:steer', (_e, agentId: string, text: string) => office.steer(agentId, text))
ipcMain.handle('office:createCharacter', (_e, officeId: number, name: string) => office.createCharacter(officeId, name))
ipcMain.handle('office:offices', () => office.offices())
ipcMain.handle('office:connectSession', (_e, officeSlug: string, officeId: number, cwd: string, sessionId: string, name: string) => office.connectSession(officeSlug, officeId, cwd, sessionId, name))
ipcMain.handle('office:createOffice', (_e, name: string, description: string) => office.createOffice(name, description))
ipcMain.handle('office:generateTeam', (_e, officeId: number, prompt: string, count: number) => office.generateTeam(officeId, prompt, count))

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { manager.disposeAll(); sessions.closeAll(); ptys.killAll() })
