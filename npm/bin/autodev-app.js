#!/usr/bin/env node
'use strict';

/**
 * `npx autodev-app` — fetch and run the AutoDev desktop app.
 *
 * Why this package ships a launcher instead of the app itself:
 *
 *   The app depends on node-pty, a NATIVE module. electron-builder rebuilds it
 *   against Electron's ABI when it produces the release artifact. An npm-installed
 *   copy would be compiled for the host Node's ABI instead and abort on load, so
 *   "just publish the sources" produces a package that installs cleanly and then
 *   never runs. The release artifact already has that solved — so we fetch it.
 *
 * The AppImage is extracted once rather than run directly: AppImages need libfuse2,
 * which Ubuntu has not shipped by default since 22.04. Extracting sidesteps FUSE
 * entirely and makes every launch after the first one instant.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const APP_VERSION = require('../package.json').version;
const ASSET = `AutoDev-${APP_VERSION}-x86_64.AppImage`;

// sha256 of ASSET, pinned at publish time. The download is verified against this
// before anything is executed — a truncated or tampered file must never run.
const SHA256 = 'a3cf32cd6ebf418b8da6bf73272cce74a91eefc223529e2be13537ec3e61a2df';

// Overridable so a self-hosted office can serve its own build.
const BASE = (process.env.AUTODEV_APP_DOWNLOAD_BASE || 'https://autodev.code.aioffice.works/download').replace(/\/+$/, '');

const CACHE = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
  'autodev-app',
  APP_VERSION
);
const ROOT = path.join(CACHE, 'squashfs-root');
const APPRUN = path.join(ROOT, 'AppRun');

const say = (m) => process.stderr.write(`${m}\n`);
const die = (m) => { say(`\nautodev-app: ${m}`); process.exit(1); };

/**
 * VERIFIED THE HARD WAY: with ELECTRON_RUN_AS_NODE set, Electron runs as plain
 * Node — the app exits 0 immediately with no window and no error. Some
 * Electron-hosted terminals and agent runtimes export it, so a user inside one
 * would just see "nothing happened". Strip it from anything we launch.
 *
 * (Assigning `undefined` into an env object is NOT reliable — delete the key.)
 */
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function checkPlatform() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    die(
      `no build for ${process.platform}-${process.arch} yet — only linux-x64.\n` +
      `See ${BASE.replace(/\/download$/, '')} for other options.`
    );
  }
}

async function download(dest) {
  const url = `${BASE}/${ASSET}`;
  say(`autodev-app ${APP_VERSION} — first run, fetching the app (~126 MB)`);
  say(`  from ${url}`);

  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    // Node's fetch collapses DNS/TLS/connection failures into "fetch failed".
    // Surface the cause, or the user gets two useless words.
    const cause = err && err.cause ? ` (${err.cause.code || err.cause.message})` : '';
    die(`could not reach ${BASE}${cause}\n  ${err.message}\n  Check your connection, then retry.`);
  }
  if (!res.ok) die(`download failed — HTTP ${res.status} ${res.statusText}\n  ${url}`);

  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  const hash = crypto.createHash('sha256');
  let got = 0;
  let lastPct = -1;

  for await (const chunk of res.body) {
    hash.update(chunk);
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (total && process.stderr.isTTY) {
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stderr.write(`\r  ${pct}%  ${(got / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB`);
      }
    }
  }
  await new Promise((r, j) => { out.end(); out.on('finish', r); out.on('error', j); });
  if (process.stderr.isTTY && total) process.stderr.write('\n');

  const got256 = hash.digest('hex');
  if (got256 !== SHA256) {
    fs.unlinkSync(tmp);
    die(`checksum mismatch — refusing to run this file.\n  expected ${SHA256}\n  got      ${got256}`);
  }
  fs.renameSync(tmp, dest);
  say('  checksum ok');
}

function extract(appimage) {
  say('  unpacking…');
  fs.chmodSync(appimage, 0o755);
  const r = spawnSync(appimage, ['--appimage-extract'], {
    cwd: CACHE,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: cleanEnv(),
  });
  if (r.status !== 0 || !fs.existsSync(APPRUN)) {
    die(`could not unpack the app.\n  ${String(r.stderr || '').trim().split('\n').slice(0, 3).join('\n  ')}`);
  }
  // The 126 MB archive is dead weight once unpacked.
  try { fs.unlinkSync(appimage); } catch { /* not fatal */ }
}

/**
 * Electron's SUID sandbox helper is not setuid inside an extracted AppImage (only
 * the .deb's postinst can chmod 4755 it). Electron then falls back to the
 * unprivileged-userns sandbox — which Ubuntu 24.04+ restricts via AppArmor. Where
 * that restriction is active, the app would abort with a Chromium "Operation not
 * permitted" crash, so drop the sandbox there rather than fail to start.
 */
function sandboxArgs() {
  let restricted = false;
  try {
    restricted = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1';
  } catch { /* file absent → no restriction */ }
  if (!restricted) return [];
  let suid = false;
  try { suid = (fs.statSync(path.join(ROOT, 'chrome-sandbox')).mode & 0o4000) !== 0; } catch { /* ignore */ }
  if (suid) return [];
  say('  note: this kernel restricts unprivileged user namespaces — starting with --no-sandbox.');
  say('        For the sandboxed build, install the .deb instead: ' + `${BASE}/AutoDev-${APP_VERSION}-amd64.deb`);
  return ['--no-sandbox'];
}

async function main() {
  checkPlatform();

  if (!fs.existsSync(APPRUN)) {
    fs.mkdirSync(CACHE, { recursive: true });
    const appimage = path.join(CACHE, ASSET);
    if (!fs.existsSync(appimage)) await download(appimage);
    extract(appimage);
    say(`  installed to ${ROOT}`);
  }

  const args = process.argv.slice(2).concat(sandboxArgs());
  const child = spawn(APPRUN, args, { stdio: 'inherit', env: cleanEnv() });
  child.on('error', (err) => die(`could not start the app: ${err.message}`));
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
}

main().catch((err) => die(err && err.stack ? err.stack : String(err)));
