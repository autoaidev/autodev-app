# autodev-app

The **AutoDev desktop app** — run autonomous AI agents from a GUI instead of a terminal.

```bash
npx autodev-app
```

That's it. No account needed to install, no sudo, no `.deb`. The first run downloads
the app (~126 MB) and unpacks it into `~/.cache/autodev-app/`; every run after that
starts straight away.

To keep it on your PATH:

```bash
npm install -g autodev-app
autodev-app
```

## What you get

A window that runs AutoDev agents for you: connect a character from your
[office](https://autodev.code.aioffice.works), point it at a folder, and watch it
work — live output, sessions, and a file browser in one place. The `autodev` CLI is
bundled, so you don't install it separately.

## Requirements

- **Linux x64** — other platforms aren't built yet; the launcher tells you so
  instead of failing strangely.
- **Node.js 18+** (only to run this launcher).
- No libfuse2 needed. The AppImage is unpacked rather than FUSE-mounted, so this
  works on Ubuntu 22.04+ where AppImages otherwise fail out of the box.

## Prefer a real system install?

The `.deb` integrates with your desktop (menu entry, icon) and ships a properly
`setuid` Chromium sandbox, which an unpacked AppImage cannot:

```bash
wget https://autodev.code.aioffice.works/download/AutoDev-0.1.0-amd64.deb
sudo apt install ./AutoDev-0.1.0-amd64.deb
```

## Notes

- **Integrity**: the download is checked against a SHA-256 pinned inside this
  package before anything is executed. A mismatch aborts.
- **Disk**: the unpacked app is ~345 MB under `~/.cache/autodev-app/<version>/`.
  Delete that folder to reclaim it or to force a clean re-download.
- **Self-hosting**: set `AUTODEV_APP_DOWNLOAD_BASE` to serve the artifact from your
  own office (the pinned checksum still applies).

## Why a launcher and not the app itself

The app links `node-pty`, a native module built against **Electron's** ABI. Shipping
the sources to npm would rebuild it against your local **Node** ABI, and the app
would install perfectly and then refuse to start. The release artifact already has
that solved, so this package fetches it rather than trying to recreate it.

## License

MIT
