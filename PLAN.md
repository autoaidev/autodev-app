# AutoDev App — desktop agent manager (Electron)

A cross-platform desktop app to **manage AutoDev agents**: create/configure
workspaces, start/stop the autonomous loop, watch live status, connect to
pixel-office, and export/import agents. It orchestrates the existing `autodev`
CLI (no logic duplication) and reads the workspace state files.

## Architecture
- **Main process** (`src/main`): `AgentManager` — registry of agent workspaces,
  spawns/tracks `autodev start` child processes, reads `.autodev/*` state, file-watches
  for live updates, exposes typed IPC. Shells out to the CLI for init/config/connect/
  export/import (single source of truth = `autodev-cli`).
- **Preload** (`src/preload`): `contextBridge` → typed `window.api`.
- **Renderer** (`src/renderer`, React + Vite): dashboard — agent list + agent detail
  (status badge, TODO, live output, config, controls).

## Model
An **agent** = a workspace folder with `.autodev/settings.json`. State surfaced from:
`settings.json` (provider/model/sessionName/wsUrl), `loop-state.json`, `TODO.md`
(task counts), `hooks-events.jsonl` (working/idle activity), `output/*` (latest stdout).

## Milestones
_M1–M9 complete + Sessions tab. App runs end-to-end: start/stop loops, live output, sessions, config, connect, export/import._
- [x] M1 Scaffold: electron-vite + React + TS, window launches, IPC ping
- [x] M2 AgentManager: add/list/remove agents (persisted registry), read workspace state
- [x] M3 Agent dashboard UI: list (status badges) + detail panel
- [x] M4 Controls: start/stop loop (spawn `autodev start`), live status from file-watch
- [x] M5 Config: edit provider/model/session-name/todo from the UI (via `autodev config`)
- [x] M6 Create agent: `autodev init` wizard (provider, name, path)
- [x] M7 pixel-office: connect via `--setup-url`/`--connect`; show online state
- [x] M8 Live output + TODO viewer; hooks-events activity stream
- [x] M9 Export/Import agent (backup ZIP) from the UI
- [ ] M10 Packaging: electron-builder (AppImage/deb), app icon, auto-update later
- [ ] M11 Polish: theming, multi-agent run, settings, logs

## Rules
- Reuse `autodev-cli` — never reimplement loop/provider logic.
- Commit each milestone. Keep it building. TypeScript strict.
