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

/** One detectable creative app from `autodev mcp detect --json` (mirrors main/agentManager.ts McpDetectApp). */
export interface McpDetectApp {
  id: string
  name: string
  installed: boolean
  path: string | null
  source: string | null
  experimental: boolean
  server: Record<string, unknown>
  serverName: string
  prerequisites: Array<{ id: string; installed: boolean; installHint: string }>
  postSetup: string[]
  notes: string[]
  alreadyEnabled: boolean
}

/** One provider family's model catalog (mirrors main/index.ts + `autodev models`). */
export interface ModelCatalogEntry {
  family: string
  default: string
  models: Array<{ id: string; label: string; contextLimit: number }>
}

/** A raw `.mcp.json` server entry (stdio and/or remote fields), as the CLI writes
 *  it. Mirrors main/agentManager.ts McpJsonEntry. */
export interface McpJsonEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  type?: string
  enabled?: boolean
  alwaysLoad?: boolean
  _meta?: { managedBy?: string; name?: string; kind?: string }
}

/** One pickable server from `autodev mcp catalog --json` (mirrors main). */
export interface McpCatalogServer {
  id: string
  name: string
  kind: 'builtin' | 'common' | 'creative'
  transport: 'stdio' | 'http' | 'sse'
  server: McpJsonEntry
  description?: string
  experimental?: boolean
  requiresApp?: string
}

/** One entry from `autodev mcp list --json` (a raw entry plus its `name`). */
export interface McpListEntry extends McpJsonEntry {
  name: string
}

/** A default MCP server that seeds new agents (mirrors main appSettings.DefaultMcpEntry). */
export interface DefaultMcpEntry {
  id?: string
  name: string
  server: McpJsonEntry
  kind?: 'builtin' | 'common' | 'creative' | 'custom'
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
  // Save a task attachment (picked file / captured photo) into the agent workspace.
  // Returns the workspace-relative path (attachments/<name>) referenced in the task.
  attachmentsSave: (
    agentPath: string,
    filename: string,
    dataBase64: string
  ): Promise<{ ok: true; relPath: string } | { error: string }> =>
    ipcRenderer.invoke('attachments:save', agentPath, filename, dataBase64),
  readAgentMcp: (path: string) => ipcRenderer.invoke('agent:readMcp', path),
  writeAgentMcp: (path: string, content: string) => ipcRenderer.invoke('agent:writeMcp', path, content),
  agentMcpStatus: (path: string) => ipcRenderer.invoke('agent:mcpStatus', path),
  // Detected creative apps → enable-as-MCP. Both go through the bundled CLI
  // (`autodev mcp detect`), so enabling reaches every provider — never writeMcp.
  mcpDetect: (path: string): Promise<{ apps: McpDetectApp[] } | { error: string }> =>
    ipcRenderer.invoke('mcp:detect', path),
  mcpEnableApp: (opts: { path: string; app: string; gimpClient?: string }): Promise<
    { ok: true; stdout: string } | { ok: false; error: string }
  > => ipcRenderer.invoke('mcp:enableApp', opts),
  // ── Layered MCP management (all writes route through `autodev mcp <op>`) ──────
  // The pickable catalog (single source of truth), the workspace's current entries,
  // and a typed mutation so the renderer NEVER hand-writes .mcp.json (that's what
  // writeAgentMcp does, and it skips provider-sync + `_meta`).
  mcpCatalog: (): Promise<{ servers: McpCatalogServer[] } | { error: string }> =>
    ipcRenderer.invoke('mcp:catalog'),
  mcpList: (path: string): Promise<{ servers: McpListEntry[] } | { error: string }> =>
    ipcRenderer.invoke('mcp:list', path),
  mcpApply: (opts: {
    path: string
    op: 'add' | 'remove' | 'enable' | 'disable'
    name: string
    server?: McpJsonEntry
  }): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('mcp:apply', opts),
  confirmDialog: (message: string, detail?: string) => ipcRenderer.invoke('dialog:confirm', message, detail),
  runCli: (args: string[], cwd?: string) => ipcRenderer.invoke('cli:run', args, cwd),
  // The provider model catalog (id/label/contextLimit per family) from the bundled
  // CLI's `autodev models --json`, cached in main. main falls back to the generated
  // model-catalog.json shipped with the CLI, so this is populated even offline;
  // returns [] only when no bundled CLI/catalog is present at all.
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
  officeOperate: (officeSlug: string, agentId: string, agentSlug: string, provider?: string, name?: string) => ipcRenderer.invoke('office:operate', officeSlug, agentId, agentSlug, provider, name),
  // Open a character's working folder (its office loop/operate cwd) in the OS file
  // manager. Creates the scratch dir if it doesn't exist yet, so it never dead-ends.
  officeOpenFolder: (officeSlug: string, agentSlug: string, agentId: string): Promise<{ ok: true; dir: string; created: boolean } | { error: string }> =>
    ipcRenderer.invoke('office:openFolder', officeSlug, agentSlug, agentId),
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
  // Destructive counterpart to stopOffice: stop THEN delete every local scratch
  // workspace under this office (does not delete the office in the pixel-office
  // backend). Surfaced as an explicit "Remove office" action behind a confirm.
  officeRemoveOffice: (officeSlug: string): Promise<{ ok: true; removed: number } | { error: string }> =>
    ipcRenderer.invoke('office:removeOffice', officeSlug),
  // Per-account provider key usage/limits from the connected office's deployer
  // vault (Claude 5h+weekly, OpenRouter credit, Copilot). Fails soft to [].
  officeKeyUsage: (): Promise<KeyUsage[]> => ipcRenderer.invoke('office:keyUsage'),
  officeSteer: (agentId: string, text: string) => ipcRenderer.invoke('office:steer', agentId, text),
  officeMessages: (officeSlug: string, agentRef: string) => ipcRenderer.invoke('office:messages', officeSlug, agentRef),
  officeAgentEvents: (officeSlug: string, agentRef: string, limit?: number, before?: number): Promise<{ ok: true; agentId: string; agentName: string; events: Array<{ id: string; at: number; evt: string; tool?: string; text: string }>; nextBefore: number | null; hasMore: boolean; total: number } | { error: string }> => ipcRenderer.invoke('office:agentEvents', officeSlug, agentRef, limit, before),
  officeEvents: (officeSlug: string, limit?: number, before?: number): Promise<{ ok: true; events: Array<{ id: string; at: number; evt: string; tool?: string; text: string; agentId: string; agentName: string }>; nextBefore: number | null; hasMore: boolean; total: number } | { error: string }> => ipcRenderer.invoke('office:events', officeSlug, limit, before),
  // Ensure a character's Operate/loop scratch workspace exists (+ office-MCP key)
  // and return its path — the per-character MCP editor scopes its edits to this dir.
  officeEnsureWorkspace: (officeSlug: string, agentId: string, agentSlug: string, provider?: string): Promise<{ ok: true; cwd: string } | { error: string }> => ipcRenderer.invoke('office:ensureWorkspace', officeSlug, agentId, agentSlug, provider),
  officeCreateCharacter: (officeId: number, name: string, opts?: { avatarIndex?: number; color?: string; emoji?: string }) => ipcRenderer.invoke('office:createCharacter', officeId, name, opts),
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
  getSettings: (): Promise<{ officeBaseUrl: string; defaultModels: Record<string, string>; defaultMcp: DefaultMcpEntry[]; advancedMode: boolean; theme: 'system' | 'dark' | 'light'; cozempicAutoInit: boolean; desktopNotifications: boolean; shellIntegration: boolean; resetSessionEveryNTurns: number }> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: { officeBaseUrl?: string; defaultModels?: Record<string, string>; defaultMcp?: DefaultMcpEntry[]; advancedMode?: boolean; theme?: 'system' | 'dark' | 'light'; cozempicAutoInit?: boolean; desktopNotifications?: boolean; shellIntegration?: boolean; resetSessionEveryNTurns?: number }): Promise<{ ok: true; officeBaseUrl: string; defaultModels: Record<string, string>; defaultMcp: DefaultMcpEntry[]; advancedMode: boolean; theme: 'system' | 'dark' | 'light'; cozempicAutoInit: boolean; desktopNotifications: boolean; shellIntegration: boolean; resetSessionEveryNTurns: number } | { error: string }> => ipcRenderer.invoke('settings:set', patch),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  // Windows Explorer "Open as AutoDev agent" right-click integration. Status
  // reflects whether the entries are registered AND whether this build can register
  // them (Windows + packaged); set(on) installs/uninstalls + persists the setting.
  shellIntegrationStatus: (): Promise<{ ok: boolean; installed: boolean; available: boolean; windows: boolean; reason?: string }> =>
    ipcRenderer.invoke('shell:integrationStatus'),
  shellIntegrationSet: (on: boolean): Promise<{ ok: boolean; installed: boolean; available: boolean; windows: boolean; reason?: string }> =>
    ipcRenderer.invoke('shell:integrationSet', on),
  // Fires when the integration is toggled anywhere (tray or Settings) so the other
  // surface can update its checkbox/toggle without a re-read.
  onShellIntegrationChanged: (cb: (d: { installed: boolean; on: boolean }) => void) => sub('shell:integrationChanged', cb),
  // A folder passed via `--open-folder` (Explorer right-click). `consumeOpenFolder`
  // pulls a cold-start pending path once (on first mount); `onOpenFolder` receives
  // later (warm) deliveries while the app is already running.
  consumeOpenFolder: (): Promise<string | null> => ipcRenderer.invoke('app:consumeOpenFolder'),
  onOpenFolder: (cb: (path: string) => void) => sub('app:openFolder', cb)
}

function sub(channel: string, cb: (...a: any[]) => void): () => void {
  const h = (_e: unknown, payload: any) => cb(payload)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
