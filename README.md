# AutoDev App

Desktop app (Electron + React) to manage AutoDev agents — create workspaces,
start/stop the autonomous loop, watch live status, configure providers, connect
to pixel-office, and export/import agents. Orchestrates the `autodev` CLI.

## Dev
```
npm install
npm run dev        # launches the app with HMR
```
Set `AUTODEV_CLI_JS` to the absolute path of `autodev-cli/bin/autodev.js` if the
CLI isn't a sibling folder.

## Build
```
npm run build      # compile main/preload/renderer → out/
npm run dist       # package via electron-builder → dist/
```

See `PLAN.md` for the roadmap.
