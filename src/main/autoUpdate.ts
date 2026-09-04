import { app, dialog, BrowserWindow } from 'electron'
import updater from 'electron-updater'

// electron-updater ships as CJS with a default export carrying autoUpdater; the
// named export is unreliable under electron-vite's bundling, so read it off default.
const { autoUpdater } = updater

/**
 * Wire generic-feed auto-updates (electron-builder `publish: { provider: generic,
 * url: app.pixeloffice.org/download }`). The feed is latest-linux.yml / latest.yml,
 * whose artifact names match what electron-builder BUILT (see artifactName in
 * electron-builder.yml) — the served files carry the identical names, so the
 * download never 404s.
 *
 * Safety contract:
 *   - Runs ONLY in a packaged build (dev has no feed and no real version).
 *   - Every path is wrapped so an unreachable/missing feed can never crash the app
 *     — a failed update check is a no-op, the app keeps running its current build.
 *   - The install is NEVER silent: we download in the background, then ASK before
 *     quitting to install, so a running agent is never yanked out from under a user.
 */
export function initAutoUpdate(getWindow: () => BrowserWindow | null): void {
  // Dev builds point at no feed and report a bogus version — never check.
  if (!app.isPackaged) return

  try {
    autoUpdater.logger = console
    // We drive quitAndInstall from our own dialog; don't let it auto-install on quit.
    autoUpdater.autoInstallOnAppQuit = false

    let promptShown = false

    autoUpdater.on('error', (err) => {
      // A broken/unreachable feed must degrade to "no update", not surface an error.
      console.warn('[autoUpdate] update check failed:', err?.message || err)
    })
    autoUpdater.on('update-available', (info) => {
      console.log(`[autoUpdate] update available: ${info?.version} — downloading in background`)
    })
    autoUpdater.on('update-not-available', () => {
      console.log('[autoUpdate] up to date')
    })
    autoUpdater.on('update-downloaded', (info) => {
      if (promptShown) return
      promptShown = true
      const win = getWindow() ?? undefined
      dialog
        .showMessageBox(win as BrowserWindow, {
          type: 'info',
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          cancelId: 1,
          message: `AutoDev ${info?.version} is ready`,
          detail: 'A new version has been downloaded. Restart the app to apply the update.'
        })
        .then((r) => {
          if (r.response === 0) {
            // isSilent=false shows the installer; forceRunAfter reopens the app.
            try { autoUpdater.quitAndInstall(false, true) } catch (e) {
              console.warn('[autoUpdate] quitAndInstall failed:', e)
            }
          } else {
            // User deferred — let it install on the next explicit quit.
            autoUpdater.autoInstallOnAppQuit = true
          }
        })
        .catch(() => { promptShown = false })
    })

    const check = (): void => {
      autoUpdater.checkForUpdatesAndNotify().catch((err) => {
        console.warn('[autoUpdate] checkForUpdates rejected:', err?.message || err)
      })
    }

    check()
    // Re-check every 6h so a long-lived (backgrounded-to-tray) session still updates.
    setInterval(check, 6 * 60 * 60 * 1000)
  } catch (err) {
    console.warn('[autoUpdate] init failed (non-fatal):', err)
  }
}
