# AutoDev App

A cross-platform **desktop app** (Electron + React + TypeScript) to manage
**AutoDev agents** — autonomous AI coding agents. It orchestrates the `autodev`
CLI (single source of truth — no logic is duplicated) and surfaces each agent's
live state.

## Features
- **Multi-agent dashboard** — sidebar list with live status dots
  (🟢 working · 🟡 idle · ⚪ stopped), per-agent detail panel, `N running` badge.
- **Start / Stop** the autonomous loop per agent, with **live streaming output**.
- **Sessions** — list existing AI sessions (claude / opencode) with their display
  name/title + id, and **▶ Resume** any past session on the next start.
- **Config** — provider, per-provider **model** (e.g. `ollama-cloud/kimi-k2.7-code`),
  and session display name.
- **Create / Add / Import / Export** agents (backup ZIPs, portable across machines).
- **Connect to pixel-office** via a signed setup-URL or a full `ws://` URL.
- **Todo** viewer, **Open folder**, confirm-on-remove, CLI-not-found banner.

## Architecture
- `src/main` — `AgentManager`: persisted registry of agent workspaces, reads each
  agent's `.autodev/*` state, spawns `autodev start` (one child per running agent),
  file-watches for live updates, and passes through CLI commands
  (`init`/`config`/`status`/`sessions`/`resume`/`connect`/`export`/`import`).
- `src/preload` — typed `window.api` via `contextBridge`.
- `src/renderer` — React dashboard.

The CLI is run with a **system Node ≥ 22** (Electron bundles Node 20, which lacks
`node:sqlite` that opencode session features need). Override with `AUTODEV_NODE`.

## Dev
```bash
npm install
npm run dev          # HMR
```
Set `AUTODEV_CLI_JS` to `…/autodev-cli/bin/autodev.js` if the CLI isn't a sibling folder.

## Build & package
```bash
npm run build        # compile main/preload/renderer → out/
npm run typecheck    # tsc strict, both tsconfigs
npm run dist         # electron-builder → dist/ (AppImage + deb, current platform)
```

### Windows installer
`electron-builder.yml` targets `win: nsis`. On a native Windows or CI runner just run
`npm run dist`. To cross-build the Windows installer **from Linux/macOS**:

```bash
npm run dist:win     # → dist/AutoDev Setup <version>.exe  (NSIS installer)
```

This runs `scripts/build-win.sh`, which packages inside the official
`electronuserland/builder:wine` Docker image (reusing the host's electron caches). It's
needed because the host can't run the 32-bit `rcedit` step without `wine32` (i386
multiarch is often unresolvable). Requirement: Docker. Output is a real PE32 NSIS
installer plus `dist/win-unpacked/AutoDev.exe`.

## Roadmap
See `PLAN.md`. M1–M10 complete; M11 polish ongoing.
