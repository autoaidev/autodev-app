// electron-builder afterPack hook.
//
// node-pty's darwin prebuild ships `spawn-helper` WITHOUT the executable bit
// (mode rw-r--r--). On macOS node-pty exec()s that helper to open a PTY, so
// without +x the app's integrated terminal silently fails on every Mac. The
// prebuilt binary is copied verbatim into the packaged .app, so we restore the
// exec bit here — after pack, before the zip is made.
//
// We also cover the (rebuilt) app.asar.unpacked/.../node-pty/build/Release path
// in case a spawn-helper lands there too. node-pty is asar-UNPACKED (see
// electron-builder.yml asarUnpack), so these files exist on disk to be exec'd.
//
// Guarded to the darwin target only; robust (walks, skips-if-absent, no throw).

const fs = require('node:fs');
const path = require('node:path');

/** Recursively collect every file named `spawn-helper` under `dir`. */
function findSpawnHelpers(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable / missing — skip quietly
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        findSpawnHelpers(full, out);
      } else if (ent.isFile() && ent.name === 'spawn-helper') {
        out.push(full);
      }
    } catch {
      // ignore per-entry errors and keep walking
    }
  }
  return out;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appOutDir = context.appOutDir;
  const helpers = findSpawnHelpers(appOutDir);
  if (helpers.length === 0) {
    console.warn('[afterPack] no darwin spawn-helper found under ' + appOutDir + ' (node-pty terminal may not work)');
    return;
  }
  for (const f of helpers) {
    try {
      fs.chmodSync(f, 0o755);
      console.log('[afterPack] chmod +x ' + path.relative(appOutDir, f));
    } catch (err) {
      console.warn('[afterPack] could not chmod ' + f + ': ' + (err && err.message));
    }
  }
};
