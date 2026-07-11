import { contextBridge, ipcRenderer } from 'electron'

const api = {
  listAgents: () => ipcRenderer.invoke('agents:list'),
  addAgent: (path: string) => ipcRenderer.invoke('agents:add', path),
  removeAgent: (path: string) => ipcRenderer.invoke('agents:remove', path),
  agentState: (path: string) => ipcRenderer.invoke('agent:state', path),
  startAgent: (path: string, provider?: string) => ipcRenderer.invoke('agent:start', path, provider),
  stopAgent: (path: string) => ipcRenderer.invoke('agent:stop', path),
  runCli: (args: string[], cwd?: string) => ipcRenderer.invoke('cli:run', args, cwd),
  cliCheck: () => ipcRenderer.invoke('cli:check'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  saveFile: (defaultName: string) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  pickFile: (filters?: { name: string; extensions: string[] }[]) => ipcRenderer.invoke('dialog:pickFile', filters),
  openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p),
  onAgentUpdated: (cb: (s: any) => void) => sub('agent:updated', cb),
  onAgentsChanged: (cb: () => void) => sub('agents:changed', cb),
  onAgentLog: (cb: (l: { path: string; line: string }) => void) => sub('agent:log', cb),
  // Claude sessions — capture existing sessions (discover + live attach)
  sessionsDiscover: () => ipcRenderer.invoke('sessions:discover'),
  sessionBacklog: (file: string) => ipcRenderer.invoke('sessions:backlog', file),
  sessionOpen: (file: string) => ipcRenderer.invoke('sessions:open', file),
  sessionClose: (file: string) => ipcRenderer.invoke('sessions:close', file),
  onSessionData: (cb: (d: { file: string; msgs: any[] }) => void) => sub('session:data', cb)
}

function sub(channel: string, cb: (...a: any[]) => void): () => void {
  const h = (_e: unknown, payload: any) => cb(payload)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
