import { contextBridge, ipcRenderer } from 'electron'

const api = {
  listAgents: () => ipcRenderer.invoke('agents:list'),
  addAgent: (path: string) => ipcRenderer.invoke('agents:add', path),
  workspaceInfo: (path: string) => ipcRenderer.invoke('workspace:info', path),
  removeAgent: (path: string) => ipcRenderer.invoke('agents:remove', path),
  agentState: (path: string) => ipcRenderer.invoke('agent:state', path),
  startAgent: (path: string, provider?: string) => ipcRenderer.invoke('agent:start', path, provider),
  stopAgent: (path: string) => ipcRenderer.invoke('agent:stop', path),
  sendAgentMessage: (path: string, text: string) => ipcRenderer.invoke('agent:message', path, text),
  readAgentMcp: (path: string) => ipcRenderer.invoke('agent:readMcp', path),
  writeAgentMcp: (path: string, content: string) => ipcRenderer.invoke('agent:writeMcp', path, content),
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
  onSessionData: (cb: (d: { file: string; msgs: any[] }) => void) => sub('session:data', cb),
  // Interactive PTY panes — spawn `claude` (or a shell) in a folder
  ptySpawn: (id: string, opts: { cwd: string; command?: string; cols?: number; rows?: number; keepShell?: boolean }) => ipcRenderer.invoke('pty:spawn', id, opts),
  ptyWrite: (id: string, data: string) => ipcRenderer.invoke('pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('pty:resize', id, cols, rows),
  ptyKill: (id: string) => ipcRenderer.invoke('pty:kill', id),
  onPtyData: (cb: (d: { id: string; data: string }) => void) => sub('pty:data', cb),
  onPtyExit: (cb: (d: { id: string; exitCode: number }) => void) => sub('pty:exit', cb),
  // Remote pixel-office — connect + list + operate agents
  officeLogin: (baseUrl: string, email: string, password: string) => ipcRenderer.invoke('office:login', baseUrl, email, password),
  officeAutoConnect: () => ipcRenderer.invoke('office:autoConnect'),
  officeStatus: () => ipcRenderer.invoke('office:status'),
  officeLogout: () => ipcRenderer.invoke('office:logout'),
  officeAgents: () => ipcRenderer.invoke('office:agents'),
  officeOperate: (officeSlug: string, agentId: string, agentSlug: string) => ipcRenderer.invoke('office:operate', officeSlug, agentId, agentSlug),
  officeSteer: (agentId: string, text: string) => ipcRenderer.invoke('office:steer', agentId, text),
  officeCreateCharacter: (officeId: number, name: string) => ipcRenderer.invoke('office:createCharacter', officeId, name),
  officeOffices: () => ipcRenderer.invoke('office:offices'),
  officeConnectSession: (officeSlug: string, officeId: number, cwd: string, sessionId: string, name: string) => ipcRenderer.invoke('office:connectSession', officeSlug, officeId, cwd, sessionId, name),
  officeCreateOffice: (name: string, description: string) => ipcRenderer.invoke('office:createOffice', name, description),
  officeGenerateTeam: (officeId: number, prompt: string, count: number) => ipcRenderer.invoke('office:generateTeam', officeId, prompt, count),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
}

function sub(channel: string, cb: (...a: any[]) => void): () => void {
  const h = (_e: unknown, payload: any) => cb(payload)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
