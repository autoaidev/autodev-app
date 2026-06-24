import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { AgentManager } from './agentManager'

let mainWindow: BrowserWindow | null = null
const manager = new AgentManager()

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
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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

// --- IPC -------------------------------------------------------------------
ipcMain.handle('agents:list', () => manager.list())
ipcMain.handle('agents:add', (_e, path: string) => manager.add(path))
ipcMain.handle('agents:remove', (_e, path: string) => { manager.remove(path); return true })
ipcMain.handle('agent:state', (_e, path: string) => manager.readState(path))
ipcMain.handle('agent:start', (_e, path: string, provider?: string) => manager.start(path, provider))
ipcMain.handle('agent:stop', (_e, path: string) => { manager.stop(path); return true })
ipcMain.handle('cli:run', (_e, args: string[], cwd?: string) => manager.runCli(args, cwd))
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

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => manager.disposeAll())
