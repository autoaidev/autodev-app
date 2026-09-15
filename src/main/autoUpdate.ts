import { app, dialog, BrowserWindow } from 'electron'
import updater from 'electron-updater'

// electron-updater ships as CJS with a default export carrying autoUpdater; the
// named export is unreliable under electron-vite's bundling, so read it off default.
const { autoUpdater } = updater

// Shared refs so the tray's "Check for Updates" can drive the same updater and
// surface explicit feedback. `manualCheck` marks the in-flight check as user-
// initiated so the (otherwise silent) not-available/error events show a dialog.
let _getWindow: () => BrowserWindow | null = () => null
let _wired = false
let manualCheck = false
const winArg = (): BrowserWindow | undefined => _getWindow() ?? undefined

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
  // Remember the window resolver so a manual check can parent its dialogs even
  // in dev (where the rest of init is skipped).
  _getWindow = getWindow

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
      if (manualCheck) {
        manualCheck = false
        dialog.showMessageBox(winArg() as BrowserWindow, {
          type: 'warning', buttons: ['OK'], defaultId: 0,
          message: 'Could not check for updates',
          detail: String(err?.message || err || 'The update server was unreachable. Please try again later.')
        }).catch(() => {})
      }
    })
    autoUpdater.on('update-available', (info) => {
      console.log(`[autoUpdate] update available: ${info?.version} — downloading in background`)
      if (manualCheck) {
        manualCheck = false
        dialog.showMessageBox(winArg() as BrowserWindow, {
          type: 'info', buttons: ['OK'], defaultId: 0,
          message: `Update available — AutoDev ${info?.version}`,
          detail: 'It’s downloading in the background. You’ll be asked to restart once it’s ready.'
        }).catch(() => {})
      }
    })
    autoUpdater.on('update-not-available', () => {
      console.log('[autoUpdate] up to date')
      if (manualCheck) {
        manualCheck = false
        dialog.showMessageBox(winArg() as BrowserWindow, {
          type: 'info', buttons: ['OK'], defaultId: 0,
          message: 'You’re up to date',
          detail: `AutoDev ${app.getVersion()} is the latest version.`
        }).catch(() => {})
      }
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

    _wired = true

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

/**
 * User-initiated update check (e.g. the tray "Check for Updates" item). Unlike the
 * silent background check, this ALWAYS gives feedback: a dialog for up-to-date /
 * update-found / error, driven by the shared event handlers via `manualCheck`.
 * Safe to call in dev (explains updates are packaged-only) and before init.
 */
export function checkForUpdatesManually(): void {
  if (!app.isPackaged) {
    dialog.showMessageBox(winArg() as BrowserWindow, {
      type: 'info', buttons: ['OK'], defaultId: 0,
      message: 'Updates unavailable in this build',
      detail: 'This is a development build. Automatic updates run only in the installed app.'
    }).catch(() => {})
    return
  }
  if (!_wired) return
  manualCheck = true
  autoUpdater.checkForUpdates().catch((err) => {
    // If the promise rejects without emitting 'error', surface it here so the
    // manual check never leaves the user without feedback.
    if (manualCheck) {
      manualCheck = false
      dialog.showMessageBox(winArg() as BrowserWindow, {
        type: 'warning', buttons: ['OK'], defaultId: 0,
        message: 'Could not check for updates',
        detail: String(err?.message || err || 'The update server was unreachable. Please try again later.')
      }).catch(() => {})
    }
  })
}
