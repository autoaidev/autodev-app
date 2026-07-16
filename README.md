# AutoDev App

A cross-platform **desktop app** (Electron + React + TypeScript) for running
autonomous AI coding agents from a GUI instead of a terminal.

AutoDev agents appear as characters in a live **office**
([pixel-office](https://autodev.code.aioffice.works), the product hub). This app is
one of the ways to drive them: it bundles the [`autodev`
CLI](https://www.npmjs.com/package/autodev-cli) (the single source of truth for all
loop/provider logic — nothing is reimplemented here), spawns one agent loop per
workspace, and surfaces each agent's live state, sessions, and terminal in a window.

> **This repo contains two packages.**
>
> | Path | npm name | What it is |
> |------|----------|------------|
> | **repo root** | `autodev-app` *(private, `"private": true`)* | Builds the **Electron desktop app**. Not published — it has no `out/` on install and lists `electron` only as a devDependency, so shipping it would install-and-do-nothing. |
> | **[`npm/`](npm/)** | **`autodev-app`** *(published)* | The **launcher**. `npx autodev-app` downloads the sha256-pinned release artifact and runs it. See [`npm/README.md`](npm/README.md). |
>
> They deliberately share the name `autodev-app`: what npm serves is the launcher;
> what the launcher fetches is the build produced from this repo root.

---

## Install (end users)

The fastest path — no account, no sudo, no `.deb`:

```bash
npx autodev-app
```

First run downloads the app (~126 MB) into `~/.cache/autodev-app/<version>/` and
unpacks it (no libfuse2 required); later runs start instantly. To keep it on PATH:

```bash
npm install -g autodev-app
autodev-app
```

Prefer a real system install (desktop menu entry, icon, and a properly `setuid`
Chromium sandbox that an unpacked AppImage can't provide):

```bash
wget https://autodev.code.aioffice.works/download/AutoDev-0.1.0-amd64.deb
sudo apt install ./AutoDev-0.1.0-amd64.deb
```

Currently built for **Linux x64** only. See [`npm/README.md`](npm/README.md) for the
full launcher story (integrity checks, self-hosting, why it's a launcher).

---

## What the app does

- **Multi-agent dashboard** — sidebar of agent workspaces with live status, a detail
  panel, and start/stop controls; one `autodev start` child process per running agent.
- **Live output** — streams each loop's stdout and hooks-events activity as it runs.
- **Sessions** — discover existing `claude` / `opencode` sessions and reopen them.
- **Terminal** — an embedded `xterm` + `node-pty` shell scoped to an agent's folder.
- **Office integration** — log in to a [pixel-office](https://autodev.code.aioffice.works),
  list your agents/offices, connect an agent, and operate a character.
- **Make an app** — create an office and generate a team from a prompt (the
  describe-→-team funnel), all from the GUI.
- **Per-agent MCP config** — read/write the agent's MCP file.
- **Create / add / export / import** agents (portable backup ZIPs), **open folder**,
  and a banner when the bundled CLI can't be found.

Everything that mutates agent state shells out to the `autodev` CLI
(`init` / `config` / `status` / `sessions` / `connect` / `export` / `import` …).

---

## Architecture

Standard Electron three-layer split (electron-vite + React):

- **[`src/main`](src/main)** — the privileged process.
  - [`agentManager.ts`](src/main/agentManager.ts): persisted registry of agent
    workspaces; spawns/tracks loops; reads each agent's `.autodev/*` state; file-watches
    for live updates; passes CLI commands through.
  - [`cli.ts`](src/main/cli.ts): locates `bin/autodev.js` and chooses the Node to run it
    with (see below).
  - [`pixelOffice.ts`](src/main/pixelOffice.ts) / [`cookieJar.ts`](src/main/cookieJar.ts):
    office login + session and the office API bridge.
  - [`sessionManager.ts`](src/main/sessionManager.ts), [`ptyManager.ts`](src/main/ptyManager.ts):
    session discovery and the embedded terminal.
- **[`src/preload`](src/preload)** — a typed `window.api` exposed via `contextBridge`.
- **[`src/renderer`](src/renderer)** — the React dashboard (`App.tsx`, plus the
  Sessions / PixelOffice / MakeApp views).

### CLI resolution & the Node it runs on

[`resolveCliJs()`](src/main/cli.ts) looks for `bin/autodev.js` in order:

1. `AUTODEV_CLI_JS` env override
2. the bundled copy at `<resourcesPath>/autodev-cli` (shipped via electron-builder
   `extraResources`)
3. a sibling `autodev-cli` repo (dev / monorepo layout), searching a few parents up

The CLI is run with a **system Node ≥ 22** when one is found, because Electron's
bundled Node 20 lacks `node:sqlite` (Node 22.5+) that opencode session/export features
need. Override the Node binary with `AUTODEV_NODE`; if no suitable system Node exists
it falls back to Electron's Node (claude/copilot still work, opencode portability
degrades).

---

## Configuration (env vars)

| Variable | Used by | Effect |
|----------|---------|--------|
| `AUTODEV_CLI_JS` | app | Absolute path to `autodev-cli/bin/autodev.js`; overrides all other resolution (handy in dev when the CLI isn't a sibling). |
| `AUTODEV_NODE` | app | Path to the Node ≥ 22 binary used to run the CLI. |
| `AUTODEV_APP_DOWNLOAD_BASE` | launcher (`npm/`) | Base URL to fetch the release artifact from (self-hosted office). The pinned sha256 still applies. |
| `AUTODEV_DOWNLOAD_DIR` | `publish.mjs` | Where `publish:app` stages artifacts (defaults to `../pixel-office/public/download`). |

---

## Development

```bash
npm install
npm run dev          # electron-vite dev, HMR
```

If the CLI isn't a sibling folder, point the app at it:
`export AUTODEV_CLI_JS=…/autodev-cli/bin/autodev.js`.

### Type-check & test

```bash
npm run typecheck    # tsc strict, both tsconfigs (node + web)
npm run test         # node --test test/*.test.mts
```

Tests live in [`test/`](test) (cookie jar, fetch-error humanizing, office
sanitization, session confinement). The launcher has its own suite:
`cd npm && npm test`.

---

## Build & package

```bash
npm run build        # compile main/preload/renderer → out/
npm run pack         # bundle:cli + build + electron-builder --dir  (unpacked, no installer)
npm run dist         # bundle:cli + build + electron-builder → dist/ (AppImage + deb)
```

`bundle:cli` ([`scripts/bundle-cli.mjs`](scripts/bundle-cli.mjs)) stages a
self-contained `autodev-cli` into `vendor/autodev-cli` so the build can bundle a
runnable CLI. The version is **resolved from the registry** against the range in
`devDependencies` (never caret-stripped), and must be ≥ `autodevCliMinVersion`
(`1.4.31`, mirroring the office's `services.autodev.cli_min_version`).

### Windows installer

`electron-builder.yml` targets `win: nsis`. On native Windows/CI just `npm run dist`.
To cross-build from Linux/macOS:

```bash
npm run dist:win     # → "dist/AutoDev Setup <version>.exe"
```

This runs [`scripts/build-win.sh`](scripts/build-win.sh), which packages inside the
official `electronuserland/builder:wine` Docker image (the host can't run the 32-bit
`rcedit` step without `wine32`). **Requires Docker.**

### Publishing

```bash
npm run publish:app  # node scripts/publish.mjs
```

[`scripts/publish.mjs`](scripts/publish.mjs) builds, stages the artifacts under the
office's `/download`, **re-pins the launcher's sha256**, and writes `SHA256SUMS` — so
the launcher's pinned checksum and download URLs can never drift from the artifact. It
does **not** git-commit or `npm publish`; it prints the exact next commands so a human
stays in the loop for the irreversible steps. (`--skip-build` reuses the existing
`dist/`.)

---

## Where this sits in AutoDev

- **[pixel-office](https://autodev.code.aioffice.works)** — the product hub: office UI,
  WebSocket presence, and MCP endpoints. Agents run *here* as characters.
- **[autodev-cli](https://www.npmjs.com/package/autodev-cli)** (`autodev-cli`) — the
  agent loop + `autodev` CLI this app bundles and drives.
- **autodev-vscode-extension** — the same tasks/chat/sessions views inside VS Code.
- **agent-vm-deployer** ([deployer.code.aioffice.works](https://deployer.code.aioffice.works))
  — spawns agents on SSH / Docker / K8s with managed auth.

## License

MIT
