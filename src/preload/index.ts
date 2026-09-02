import { contextBridge, ipcRenderer } from 'electron'

/** Per-account provider key usage row (mirrors main/pixelOffice.ts KeyUsage). */
export interface KeyUsage {
  provider: string
  label?: string
  kind?: string
  limits: Array<{ label: string; used?: number; limit?: number; resetAt?: string | null; pct?: number; severity?: string }>
  expiresAt?: string | null
  error?: string | null
  unlimited?: boolean
}

/** One provider family's model catalog (mirrors main/index.ts + `autodev models`). */
export interface ModelCatalogEntry {
  family: string
  default: string
  models: Array<{ id: string; label: string; contextLimit: number }>
}

const api = {
  // The installed app version string, e.g. '0.3.1'.
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  addAgent: (path: string) => ipcRenderer.invoke('agents:add', path),
  workspaceInfo: (path: string) => ipcRenderer.invoke('workspace:info', path),
  removeAgent: (path: string) => ipcRenderer.invoke('agents:remove', path),
  removeAgentFolder: (path: string) => ipcRenderer.invoke('agents:removeFolder', path),
  agentState: (path: string) => ipcRenderer.invoke('agent:state', path),
  startAgent: (path: string, provider?: string) => ipcRenderer.invoke('agent:start', path, provider),
  stopAgent: (path: string) => ipcRenderer.invoke('agent:stop', path),
  sendAgentMessage: (path: string, text: string) => ipcRenderer.invoke('agent:message', path, text),
  readAgentMcp: (path: string) => ipcRenderer.invoke('agent:readMcp', path),
  writeAgentMcp: (path: string, content: string) => ipcRenderer.invoke('agent:writeMcp', path, content),
  agentMcpStatus: (path: string) => ipcRenderer.invoke('agent:mcpStatus', path),
  confirmDialog: (message: string, detail?: string) => ipcRenderer.invoke('dialog:confirm', message, detail),
  runCli: (args: string[], cwd?: string) => ipcRenderer.invoke('cli:run', args, cwd),
  // The provider model catalog (id/label/contextLimit per family) from the bundled
  // CLI's `autodev models --json`, cached in main. Returns [] on an older CLI —
  // callers fall back to the offline MODEL_SUGGESTIONS.
  listModels: (): Promise<ModelCatalogEntry[]> => ipcRenderer.invoke('models:list'),
  exportTrace: (path: string, output: string): Promise<{ ok: true; output: string; note?: string } | { error: string }> => ipcRenderer.invoke('agent:exportTrace', path, output),
  cliCheck: () => ipcRenderer.invoke('cli:check'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  saveFile: (defaultName: string) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  pickFile: (filters?: { name: string; extensions: string[] }[]) => ipcRenderer.invoke('dialog:pickFile', filters),
  openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p),
  onAgentUpdated: (cb: (s: any) => void) => sub('agent:updated', cb),
  onAgentsChanged: (cb: () => void) => sub('agents:changed', cb),
  onAgentLog: (cb: (l: { path: string; line: string }) => void) => sub('agent:log', cb),
  // Sessions — capture existing sessions across providers (discover + read; claude live-tail)
  sessionsDiscover: () => ipcRenderer.invoke('sessions:discover'),
  sessionBacklog: (opts: { file?: string; provider?: string; id?: string; cwd?: string }) => ipcRenderer.invoke('sessions:backlog', opts),
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
  // Reachability probe for a candidate Server URL (Test connection) — no
  // credentials are sent and the live session is never mutated.
  officePing: (baseUrl: string): Promise<{ ok: true } | { error: string }> =>
    ipcRenderer.invoke('office:ping', baseUrl),
  officeLogout: () => ipcRenderer.invoke('office:logout'),
  officeAgents: () => ipcRenderer.invoke('office:agents'),
  officeOperate: (officeSlug: string, agentId: string, agentSlug: string) => ipcRenderer.invoke('office:operate', officeSlug, agentId, agentSlug),
  // Spawn an office as TRACKED loops. `overrides` sets a per-agent provider (the
  // office view's per-row dropdown); each returned `path` is the tracked workspace
  // to subscribe to via the `agent:log` stream.
  officeSpawnOffice: (
    officeSlug: string,
    overrides?: Array<{ agentId: string; provider?: string }>
  ): Promise<
    { ok: true; agents: Array<{ agentId: string; agentSlug: string; name: string; path: string; provider: string; officeSlug: string }> }
    | { error: string; online?: string[] }
  > => ipcRenderer.invoke('office:spawnOffice', officeSlug, overrides),
  officeStopOffice: (officeSlug: string): Promise<{ ok: true; stopped: number } | { error: string }> =>
    ipcRenderer.invoke('office:stopOffice', officeSlug),
  // Per-account provider key usage/limits from the connected office's deployer
  // vault (Claude 5h+weekly, OpenRouter credit, Copilot). Fails soft to [].
  officeKeyUsage: (): Promise<KeyUsage[]> => ipcRenderer.invoke('office:keyUsage'),
  officeSteer: (agentId: string, text: string) => ipcRenderer.invoke('office:steer', agentId, text),
  officeMessages: (officeSlug: string, agentRef: string) => ipcRenderer.invoke('office:messages', officeSlug, agentRef),
  officeCreateCharacter: (officeId: number, name: string) => ipcRenderer.invoke('office:createCharacter', officeId, name),
  officeOffices: () => ipcRenderer.invoke('office:offices'),
  officeSetupUrl: (officeSlug: string, agentId: string) => ipcRenderer.invoke('office:setupUrl', officeSlug, agentId),
  officeConnectSession: (officeSlug: string, officeId: number, cwd: string, sessionId: string, name: string) => ipcRenderer.invoke('office:connectSession', officeSlug, officeId, cwd, sessionId, name),
  officeCreateOffice: (name: string, description: string) => ipcRenderer.invoke('office:createOffice', name, description),
  officeGenerateTeam: (officeId: number, prompt: string, count: number) => ipcRenderer.invoke('office:generateTeam', officeId, prompt, count),
  officeWriteSharedMcp: (folder: string, officeSlug: string, agents: Array<{ id?: string; slug?: string; name?: string }>, fileBrowser?: boolean) => ipcRenderer.invoke('office:writeSharedMcp', folder, officeSlug, agents, fileBrowser),
  officeBindWorkspace: (cwd: string, officeSlug: string, want: { id?: string; slug?: string; name?: string }, fileBrowser?: boolean) => ipcRenderer.invoke('office:bindWorkspace', cwd, officeSlug, want, fileBrowser),
  officeDeleteAgent: (officeSlug: string, agentId: string) => ipcRenderer.invoke('office:deleteAgent', officeSlug, agentId),
  // Update an office character's owner-editable settings (provider/model/name/file-browser).
  officeUpdateCharacter: (
    agentId: string,
    patch: { provider?: string; model?: string; name?: string; fileBrowserEnabled?: boolean }
  ): Promise<{ ok: true; provider?: string; model?: string; name?: string } | { error: string }> =>
    ipcRenderer.invoke('office:updateCharacter', agentId, patch),
  // App preferences (non-secret; persisted in userData/app-settings.json)
  getSettings: (): Promise<{ officeBaseUrl: string }> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: { officeBaseUrl?: string }): Promise<{ ok: true; officeBaseUrl: string } | { error: string }> => ipcRenderer.invoke('settings:set', patch),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
}

function sub(channel: string, cb: (...a: any[]) => void): () => void {
  const h = (_e: unknown, payload: any) => cb(payload)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
