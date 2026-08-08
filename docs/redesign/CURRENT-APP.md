# AutoDev App — Current Architecture (map for the v2 redesign)

Purpose: so the redesign (mockup-v2.html, screens 2a–2h) wires to **real** data and IPC
instead of mocks. Every screen below already has a data source in the running app —
this document names the exact `window.api` method, the state shape, and the gotchas.

Repo: `/home/autodev/Documents/GitHub/autodev-app` (electron-vite, React/TSX).
Key files:
- `src/preload/index.ts` — the `window.api` contextBridge surface (the ONLY renderer↔main channel).
- `src/main/agentManager.ts` — `AgentState` shape + the `changed`/`log`/`agentUpdated` events.
- `src/renderer/src/App.tsx` — routing, agent selection, sidebar, fleet lifecycle, all agent-detail tabs + modals.
- Views: `PixelOfficeView.tsx`, `SessionsBrowser.tsx`, `SettingsView.tsx`, `MakeAppView.tsx`, `TerminalTabs.tsx` / `TerminalPane.tsx`, `OfficeSelector.tsx`.

---

## 1. The full `window.api` surface

Every method is `ipcRenderer.invoke(...)` (returns a Promise) except the `onX` subscribers,
which take a callback and **return an unsubscribe function**. Grouped by concern.

### 1a. Local agent registry & lifecycle (AgentManager)
| Method | Signature | Returns |
|---|---|---|
| `listAgents()` | `() => Promise<AgentState[]>` | the whole fleet (readState per path) |
| `addAgent(path)` | `(path: string)` | `AgentState \| {error}` — registers an existing workspace |
| `workspaceInfo(path)` | `(path)` | `{exists, provider?, sessionName?}` — probe BEFORE create so init never clobbers |
| `removeAgent(path)` | `(path)` | unregister only (keeps folder) |
| `removeAgentFolder(path)` | `(path)` | unregister **and** `rm -rf` the folder (guarded) |
| `agentState(path)` | `(path)` | single `AgentState` |
| `startAgent(path, provider?)` | `(path, provider?)` | `{ok, alreadyRunning?} \| {error}` — spawns `autodev start` child |
| `stopAgent(path)` | `(path)` | void (SIGINT→SIGKILL; kills our child OR external pids) |
| `sendAgentMessage(path, text)` | `(path, text)` | `{ok} \| {error}` — **appends `- [ ] text` to TODO.md** (a queued task, NOT a live chat) |
| `exportTrace(path, output)` | `(path, output)` | `{ok, output, note?} \| {error}` — grok native trace / backup zip for others |

### 1b. Per-agent MCP config
| Method | Signature | Returns |
|---|---|---|
| `readAgentMcp(path)` | `(path)` | `{content} \| {error}` — raw `.mcp.json` |
| `writeAgentMcp(path, content)` | `(path, content)` | `{ok} \| {error}` — validates JSON first |
| `agentMcpStatus(path)` | `(path)` | `{servers: McpServerStatus[]} \| {error}` — **live** probe (remote: MCP `initialize` handshake; stdio: runner on PATH) |

`McpServerStatus = { name, kind:'remote'|'stdio', detail, builtin, enabled, status:'connected'|'unreachable'|'ready'|'missing'|'disabled', latencyMs?, error? }`

### 1c. CLI passthrough & dialogs
| Method | Signature | Notes |
|---|---|---|
| `runCli(args, cwd?)` | `(string[], cwd?)` → `{stdout, stderr, code}` | the workhorse. Used for `init`, `config get/set`, `status`, `sessions`, `resume`, `export`, `import`, `connect` |
| `cliCheck()` | `()` → `{found: boolean}` | drives the blocking CliSetup screen |
| `confirmDialog(msg, detail?)` | native confirm (use for destructive; renderer `window.confirm` is a sandbox no-op) |
| `pickFolder()` / `pickFile(filters?)` / `saveFile(defaultName)` | native dialogs → path or null |
| `openPath(p)` / `openExternal(url)` | shell open |

### 1d. Live subscriptions (return unsubscribe fn)
| Method | Callback payload | Fired when |
|---|---|---|
| `onAgentUpdated(cb)` | `(s: AgentState)` | a single agent's state changed (watch tick / stream state / sendMessage) |
| `onAgentsChanged(cb)` | `()` | registry changed / a child spawned or exited → caller does full `refresh()` |
| `onAgentLog(cb)` | `({path, line})` | stdout/stderr chunk from our child OR tail of an external loop's output file |
| `onSessionData(cb)` | `({file, msgs})` | live-tail of a claude transcript opened via `sessionOpen` |
| `onPtyData(cb)` | `({id, data})` | PTY output for an interactive terminal |
| `onPtyExit(cb)` | `({id, exitCode})` | PTY provider process exited |

### 1e. Sessions (cross-provider discovery + reader)
| Method | Signature | Notes |
|---|---|---|
| `sessionsDiscover()` | `() => Promise<SessionMeta[]>` | global scan across claude/grok/opencode/copilot |
| `sessionBacklog(opts)` | `({file?, provider?, id?, cwd?})` → `SessionMsg[]` | one-shot transcript read |
| `sessionOpen(file)` / `sessionClose(file)` | claude-only live tail (emits `onSessionData`) |

`SessionMeta = { id, provider, file, project, cwd, title, mtime, sizeKb, msgs, live }`
`SessionMsg = { role:'user'|'assistant'|'tool'|'system', text, ts? }`

### 1f. Interactive PTY panes
| Method | Signature |
|---|---|
| `ptySpawn(id, {cwd, command?, cols?, rows?, keepShell?})` | `{ok} \| {error}` |
| `ptyWrite(id, data)` / `ptyResize(id, cols, rows)` / `ptyKill(id)` | control |

**A mounted `TerminalPane` === a live PTY. Unmounting it calls `ptyKill` → SIGKILL.** (see gotchas)

### 1g. Remote pixel-office (connect / list / operate / spawn)
| Method | Signature | Returns |
|---|---|---|
| `officeLogin(baseUrl, email, password)` | | `{ok} \| {error}` — stores durable token |
| `officeAutoConnect()` | `()` | `boolean` — silent reconnect via durable token |
| `officeStatus()` | `()` | `{connected, base, email?}` (base resolves to the Settings base when no session) |
| `officeLogout()` | `()` | void |
| `officeAgents()` | `()` | `OfficeAgent[]` — **throws** on dead session (not `{error}`) |
| `officeOffices()` | `()` | `{slug, id, name}[]` — **throws** on dead session |
| `officeOperate(officeSlug, agentId, agentSlug)` | | `{ok, cwd, mcpUrl} \| {error}` — preps a scratch workspace to run a character as an interactive PTY |
| `officeSpawnOffice(officeSlug, overrides?)` | `overrides: {agentId, provider?}[]` | `{ok, agents:[{agentId, agentSlug, name, path, provider, officeSlug}]} \| {error, online?}` — starts EVERY character as a tracked loop (block-if-any-online) |
| `officeStopOffice(officeSlug)` | | `{ok, stopped} \| {error}` |
| `officeSteer(agentId, text)` | | `{ok} \| {error}` — **live** instant-message/steer (POST /steer), NOT a TODO task |
| `officeMessages(officeSlug, agentRef)` | | `{ok, agentId, agentName, messages: ChatMessage[]} \| {error}` — a character's live conversation |
| `officeCreateCharacter(officeId, name)` | | `{ok, id} \| {error}` |
| `officeSetupUrl(officeSlug, agentId)` | | `{ok, setupUrl} \| {error}` |
| `officeConnectSession(officeSlug, officeId, cwd, sessionId, name)` | | `{ok, cwd, sessionId, agentName} \| {error}` — resume a claude session AS a character |
| `officeCreateOffice(name, description)` | | `{ok, office:{slug,id,name}} \| {error}` |
| `officeGenerateTeam(officeId, prompt, count)` | | `{ok, agents: RosterAgent[]} \| {error}` — AI team blueprint |
| `officeWriteSharedMcp(folder, officeSlug, agents[], fileBrowser?)` | | `{ok, wired, missing?} \| {error}` — one `.mcp.json`, N `pixel-office-<slug>` servers |
| `officeBindWorkspace(cwd, officeSlug, want{id?,slug?,name?}, fileBrowser?)` | | `{ok} \| {error}` — write presence + office-MCP into an existing workspace |
| `officeDeleteAgent(officeSlug, agentId)` | | `{ok} \| {error}` |

`OfficeAgent = { office, officeSlug, id, name, slug, status?, online, provider?, model? }`
`ChatMessage = { id, role:'user'|'assistant'|'a2a'|'system', author, text, kind, at }`

### 1h. App preferences
| Method | Returns |
|---|---|
| `getSettings()` | `{officeBaseUrl}` |
| `setSettings({officeBaseUrl?})` | `{ok, officeBaseUrl} \| {error}` (https only; http localhost ok) |

---

## 2. The `AgentState` object (the fleet's core model)

Produced by `AgentManager.readState(path)` from the workspace's `.autodev/*` files + live process/office signals. Emitted whole by `listAgents`, `agentState`, and `onAgentUpdated`.

```ts
interface AgentState {
  path: string                 // absolute workspace path — the STABLE KEY for everything
  name: string                 // settings.sessionName || basename(path)
  provider?: string            // e.g. 'claude-tui','grok-cli','opencode-sdk'
  sessionName?: string
  wsUrl?: string               // office binding present ⇒ this agent is office-bound
  running: boolean             // our child OR an external `autodev start` (matched by /proc cwd) OR office-online
  external?: boolean           // running via a loop this app didn't start (don't spawn a duplicate)
  online?: boolean             // live character in the office (presence WS open)
  activity: Activity           // see below — the TRUTHFUL status
  tasks: { total, remaining, done }  // parsed from TODO.md ([ ]=pending, [~]=in-progress, [x]=done)
  currentTask?: string         // the [~] item, else next [ ] item (≤140 chars)
  lastOutput?: string          // tail (~4KB) of the provider's persisted output file
  error?: string               // human explanation for an attention state
  exitCode?: number | null     // last child exit (non-zero ⇒ crashed)
  officeAgentSlug?: string      // endpoint slug from wsUrl — the ref for office chat
  officeSlug?: string           // resolved once the office presence poll has run
  officeAgentId?: string        // numeric-ish office agent id (needed to steer / delete char)
}

type Activity = 'working' | 'idle' | 'stopped' | 'stalled' | 'needs-auth' | 'rate-limited' | 'crashed'
```

`Activity` truth sources (do NOT collapse these back to working/idle in the redesign):
- `working`/`idle` — newest event in `.autodev/hooks-events.jsonl`.
- `stalled` — a `working` verdict where the hooks file has been silent > 4 min (a hang), but only if `tasks.remaining > 0`.
- `crashed` — a `StopFailure`/`stop_failure` hook event, OR a non-zero exit with no live loop.
- `needs-auth` / `rate-limited` — detected from the child stdout stream (`_detectStreamState`) or a `reauth_required`/`rate_limit` hook event.

`ATTENTION_STATES = {stalled, needs-auth, rate-limited, crashed}` — these float to the top of the list and drive the ⚠ chip. `ACTIVITY_LABEL` maps each to a human string. Both live in `App.tsx` (lines ~39–43) — reuse them.

---

## 3. Routing & selection today

There is **no router**. `App.tsx` holds all top-level state.

- **Top nav** (`.topbar` / `role=tablist`) switches five surfaces via boolean flags: `showMakeApp`, `showOffice`, `showSessions`, `showSettings` (all false ⇒ the `agents` workspace). `activeView` derives the active one; `showView(v)` sets the flags.
- **`agents` surface** = a two-pane layout: the sidebar agent list (`aside.sidebar`) + the agent-detail `main`. Selecting a row (`selectAgent(path)`) sets `selected` (the path) **and** closes every heavy view. `current = agents.find(a => a.path === selected)`.
- **Heavy-view keep-alive**: once opened, MakeApp / Office / Sessions stay **mounted** and are toggled with CSS `display:none` (guards `openedMakeApp`/`openedOffice`/`openedSessions`). They must NOT unmount on tab switch — a live Operate/Resume PTY inside them would be SIGKILLed. Settings is lightweight (no PTY) and renders directly.
- **Agent-detail tabs** (`tab` state): `overview | chat | output | sessions(label "Resume") | todo | config`. Default is `output`.
- **Data flow**: `refresh()` calls `listAgents()` and seeds `selected`. A 5s safety-net poll re-lists. `onAgentUpdated` patches one agent in place; `onAgentsChanged` triggers a full `refresh()`; `onAgentLog` appends into `logsRef` (a `Map<path,string>`, capped 20k) and notifies **only** the mounted Output pane via a `logListeners` subscription set — never a whole-App re-render (typing-in-composer bug).
- **Selection/data keyed by `path`** everywhere. `logsRef`, `stopping`, `restarting`, `checked` (bulk multi-select) are all `Set<path>` / `Map<path,…>`.
- **Sidebar**: search + status filter (`all|running|attention`) + sort (`folder|name|status|provider`) + group-by-folder; a bulk-action bar appears when `checked.size > 0` (start/stop/restart/connect-office/remove). Fleet buttons: **Start all** (`startAll`), **Stop all** (`stopAll` — also dispatches a `window` `office:stop-all` event to kill Operate PTYs).

---

## 4. Redesign screen → current component + API to reuse

| Redesign screen (mockup-v2.html) | Reuse from current app | Data source |
|---|---|---|
| **2a — Agent detail** (merges Overview+Output+Todo into one) | `App.tsx` `Overview`, `Output`, `TodoTab` components + the `detail-head` action bar (Start/Stop/Restart/Open/Connect) | `current: AgentState`; live output via `onAgentLog`→`logsRef` + `subscribeLog`; task list from `AgentState.tasks`/`currentTask` (or `runCli(['status', path, '--all'])` for the full TODO). Actions: `startAgent`/`stopAgent`; queue a task via `sendAgentMessage` (MessageBar). |
| **2b — Fleet triage** (all 29 at once — NEW) | The sidebar list logic in `App.tsx`: `visibleAgents` (filter+sort+attention-float), `folderCounts`, bulk bar (`bulk()`, `checked`), `startAll`/`stopAll` | `listAgents()` + `onAgentUpdated`/`onAgentsChanged`; per-agent `AgentState` (activity, tasks, currentTask, provider, online). No new API — this is a richer render of the same fleet array. |
| **2c — Office, one stream at a time** | `PixelOfficeView.tsx` + `TerminalTabs.tsx` (one active pane, others `display:none`) | `officeAgents()` grouped client-side into offices; `officeOperate` (PTY) / `officeSpawnOffice` (tracked loops → log panes) / `officeStopOffice`; live steer via `officeSteer`; per-tab online badge from `officeAgents().online`. 8s `pollAgents`. |
| **2d — Sessions, grouped & named** | `SessionsBrowser.tsx` | `sessionsDiscover()` (SessionMeta[]), `sessionBacklog`/`sessionOpen`/`sessionClose` + `onSessionData`; provider filter is client-side; resume-live via `officeConnectSession` (claude only) → PTY. `＋ Spawn Claude` = `ptySpawn`. |
| **2e — Spawn a team + config as a modal** | `MakeAppView.tsx` (team spawn) and `App.tsx` `Config` (make it a modal) | Team: `officeCreateOffice`/`officeGenerateTeam` then per-agent `runCli(['init',…])` + `officeBindWorkspace` (+ `startAgent` for Spawn&Run), or `officeWriteSharedMcp` for one shared folder. Config: `runCli(['config','get'/'set',…])`, `readAgentMcp`/`writeAgentMcp`, `officeBindWorkspace`. Office picker: `OfficeSelector` + `useOfficeSelection`. |
| **2f — Chat & Terminal tabs** | `App.tsx` `ChatTab` (office conversation) + `PixelOfficeView`/`TerminalPane` for the terminal | Chat: `officeMessages(officeSlug, ref)` polled every 4s + `officeSteer` to send; only works when the agent is office-bound (`officeAgentSlug`/`officeAgentId`). Terminal: `ptySpawn`/`ptyWrite`/`onPtyData`. |
| **2g — MCP editor, status first** | `App.tsx` `Config` → the MCP section (`McpRow`, `MCP_STATUS_META`) | `agentMcpStatus(path)` for the live connectivity list (render FIRST), `readAgentMcp`/`writeAgentMcp` for the raw JSON (SECOND). Restart the agent to apply. |
| **2h — Settings, sectioned** | `SettingsView.tsx` | `getSettings()`/`setSettings({officeBaseUrl})`. Currently one section (Pixel Office server URL); the redesign adds sections but the only persisted pref today is `officeBaseUrl`. |

---

## 5. Gotchas (load-bearing — the redesign must preserve these)

1. **TerminalTabs keep-alive / PTY SIGKILL.** A mounted `TerminalPane` is a live PTY; its cleanup calls `ptyKill(id)` → SIGKILL. So (a) every open **pty** pane stays mounted, only the active one is `display:block` (`TerminalTabs.tsx`); and (b) the heavy views (`PixelOfficeView`, `SessionsBrowser`) that host PTYs must stay mounted across tab switches — `App.tsx` uses `openedX` + CSS `display` for exactly this. Unmounting to switch tabs kills the office character's Operate session (takes it offline). **`log`-kind panes are read-only** (a tracked AgentManager loop) — closing them is view-only; the loop keeps running.

2. **Office presence ≠ local loop.** `AgentState.running` is true for our child, an external `autodev start` (matched by `/proc/<pid>/cwd`), **or** a character kept online in the office (mcp-operate bridge / remote VM). `external:true` means "don't spawn a duplicate". `online:true` means presence-WS open. The redesign must not paint an office-online agent as "Stopped", and must not offer Start when `external`/`alreadyRunning`.

3. **Log streaming.** All live output flows through the single `onAgentLog({path,line})` IPC — for our children AND (via the external-tail attach in `readState`) for loops we didn't spawn. Buffer it in a `Map<path,string>` capped ~20k and re-render only the visible log pane through a `subscribeLog` listener set. Do **not** re-render the whole tree on each line (it drops keystrokes in any mounted composer/search input). Same pattern is duplicated in `PixelOfficeView` for spawned log panes.

4. **`sendAgentMessage` is a queued TODO task, not a chat.** It appends `- [ ] text` to `TODO.md` (atomic O_APPEND; the loop rewrites TODO.md concurrently). The **live** instant-message path is `officeSteer` (office characters only). Keep these two distinct in the UI — the current app labels them "Add task" vs "⚡ Send / instant-message".

5. **`officeAgents()` / `officeOffices()` THROW on a dead session** (they don't return `{error}`). Callers wrap in try/catch and attempt `officeAutoConnect()` before bouncing to a login form. A routine list-refresh 401 must **not** tear down a live Operate PTY (it authenticates via its own baked-in office key) — show a soft reconnect hint instead.

6. **Never re-init an existing workspace.** Before create/connect, call `workspaceInfo(path)`; if `exists`, register + connect (keep settings) rather than `runCli(['init',…])`, which overwrites provider/office binding.

7. **Config/MCP/provider/binding changes need a loop restart to apply.** The current flows auto-restart a running agent after `connect`/`bindWorkspace`; a plain Config save just toasts "restart to apply". Preserve that.

8. **Destructive confirms need native dialog.** The sandboxed renderer's `window.confirm` silently returns false (no-ops the action). Use `confirmDialog` IPC (or drop the confirm for non-destructive ops like Stop). See `stopAll`.

9. **CLI-missing gate.** `cliCheck()` false ⇒ a blocking `CliSetup` screen; agent create/start/config all route through `runCli`/`startAgent` which need the bundled/`$AUTODEV_CLI_JS` CLI.

---

## 6. Notes for the mock

- The mock is `docs/redesign/mockup-v2.html`; screens are `#2a`…`#2h` (titles in §4).
- App activity dots use CSS classes `dot working|idle|stopped|stalled|needs-auth|rate-limited|crashed` and status pills `status-pill <activity>` — reuse the class vocabulary so the theme (light/dark token system) stays consistent.
- Provider vocabulary + labels: `PROVIDER_GROUPS` in `App.tsx` (claude-tui recommended default; families claude/copilot/opencode/grok each with cli/tui/sdk variants).
