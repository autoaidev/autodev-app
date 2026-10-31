#!/usr/bin/env node
// Publish the desktop app: build → stage artifacts under the office's /download →
// re-pin the launcher's sha256 → sync versions → write SHA256SUMS.
//
// WHY THIS EXISTS: the release version and the AppImage sha256 are referenced in
// several places (the launcher pins the sha; the launcher and the connect card
// build download URLs from the version). Those were hand-maintained and the
// artifacts were hand-copied with a rename, so any `npm run dist` silently drifted
// them — the launcher would then 404 or reject its own build. This regenerates all
// of it from one fresh build, so the pins can never lag the artifact.
//
// Usage:
//   node scripts/publish.mjs              # build, then stage + re-pin
//   node scripts/publish.mjs --skip-build # stage + re-pin from the existing dist/
//   node scripts/publish.mjs --distribute # also push to PROD + the autoaidev mirror
//   AUTODEV_DOWNLOAD_DIR=/path node scripts/publish.mjs   # override download dir
//
// It does NOT git-commit or `npm publish` — it prints exactly what to run next, so
// a human stays in the loop for the two irreversible steps.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneDownloads } from './prune-downloads.mjs';

// How many past release versions to retain in a /download dir. Older versioned
// AutoDev-* binaries are pruned after staging so the dir can't balloon (it hit
// 18 GB × 47 versions before this existed). latest*.yml + *.vsix are never touched.
const KEEP_RELEASES = 2;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipBuild = process.argv.includes('--skip-build');
const runDistribute = process.argv.includes('--distribute');

const say = (m) => process.stdout.write(`${m}\n`);
const die = (m) => { process.stderr.write(`\npublish: ${m}\n`); process.exit(1); };

const appPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = appPkg.version;

// Canonical names the launcher (npm/bin/autodev-app.js) and the connect card
// (pixel-office AgentConnectCommands.vue) both construct from the version. These
// MUST stay in lockstep with those two — the test suite asserts it.
//
// NAME COHERENCE: electron-builder now BUILDS artifacts with exactly these names
// (see artifactName in electron-builder.yml), so the emitted latest*.yml points
// at the served filenames and auto-update never 404s. Staging is a plain COPY —
// no rename — which keeps the yml's `path:`/`url:` valid against the served files.
const CANON = {
  appimage: `AutoDev-${VERSION}-x86_64.AppImage`,
  deb: `AutoDev-${VERSION}-amd64.deb`,
  winSetup: `AutoDev-${VERSION}-setup.exe`,
  winPortable: `AutoDev-${VERSION}-portable.exe`,
};

const downloadDir = process.env.AUTODEV_DOWNLOAD_DIR
  || path.resolve(ROOT, '..', 'pixel-office', 'public', 'download');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Find exactly one dist artifact by extension — electron-builder's own names
// (AutoDev-<v>.AppImage, autodev-app_<v>_amd64.deb) differ from the canonical
// download names, so match on suffix rather than hard-coding either spelling.
function findDist(suffix) {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) die(`no dist/ — run a build first (omit --skip-build)`);
  const hits = fs.readdirSync(dist).filter((f) => f.endsWith(suffix));
  if (hits.length === 0) die(`no ${suffix} in dist/ — did the build produce one?`);
  if (hits.length > 1) die(`ambiguous ${suffix} in dist/: ${hits.join(', ')} — clean dist/ and rebuild`);
  return path.join(dist, hits[0]);
}

// ── 1. Build ────────────────────────────────────────────────────────────────
if (skipBuild) {
  say('• skipping build (--skip-build); staging the existing dist/');
} else {
  say('• building (npm run dist)…');
  execFileSync('npm', ['run', 'dist'], { cwd: ROOT, stdio: 'inherit' });
}

// ── 2. Stage artifacts under the download dir (built name == served name) ─────
fs.mkdirSync(downloadDir, { recursive: true });
const appimageSrc = findDist('.AppImage');
const debSrc = findDist('.deb');
const appimageDst = path.join(downloadDir, CANON.appimage);
const debDst = path.join(downloadDir, CANON.deb);
fs.copyFileSync(appimageSrc, appimageDst);
fs.copyFileSync(debSrc, debDst);
say(`• staged ${path.basename(appimageSrc)} → ${CANON.appimage}`);
say(`• staged ${path.basename(debSrc)} → ${CANON.deb}`);

const appimageSha = sha256(appimageDst);
const debSha = sha256(debDst);

// Windows artifacts only exist if a `dist:win` build has run into the same dist/.
// Copy what's there; log what's missing (a Linux-only publish is still valid).
const dist = path.join(ROOT, 'dist');
function copyIfExists(name, label) {
  const src = path.join(dist, name);
  if (!fs.existsSync(src)) { say(`• (skip) no ${label} in dist/ (${name})`); return null; }
  const dst = path.join(downloadDir, name);
  fs.copyFileSync(src, dst);
  say(`• staged ${name}`);
  return dst;
}
const winSetupDst = copyIfExists(CANON.winSetup, 'Windows setup.exe');
const winPortableDst = copyIfExists(CANON.winPortable, 'Windows portable.exe');

// Copy the update feeds + every blockmap so electron-updater can resolve deltas.
// These sit NEXT TO the artifacts they reference; their `path:`/`url:` are the
// canonical names above (built == served), so no rewriting is needed.
// latest-mac.yml + the mac zips are staged here too so the mac auto-update feed
// is complete without a manual copy step (they used to be hand-staged each release).
for (const f of fs.readdirSync(dist)) {
  if (f === 'latest.yml' || f === 'latest-linux.yml' || f === 'latest-mac.yml'
      || f.endsWith('.blockmap') || f.endsWith('-mac.zip')) {
    fs.copyFileSync(path.join(dist, f), path.join(downloadDir, f));
    say(`• staged ${f}`);
  }
}

// Prune old versioned binaries so the download dir keeps only the newest N
// releases (current + one prior for rollback). Runs AFTER all current-version
// files are staged, so it never removes what we just wrote.
pruneDownloads(downloadDir, KEEP_RELEASES, say);

// ── 3. Re-pin the launcher's sha256 (it fetches + verifies the AppImage) ──────
const launcherPath = path.join(ROOT, 'npm', 'bin', 'autodev-app.js');
let launcher = fs.readFileSync(launcherPath, 'utf8');
const pinRe = /const SHA256 = '([a-f0-9]{64})';/;
const curPin = pinRe.exec(launcher)?.[1];
if (!curPin) die(`could not find the SHA256 pin in ${launcherPath}`);
if (curPin === appimageSha) {
  say(`• launcher pin already current (${appimageSha.slice(0, 12)}…)`);
} else {
  launcher = launcher.replace(pinRe, `const SHA256 = '${appimageSha}';`);
  fs.writeFileSync(launcherPath, launcher);
  say(`• re-pinned launcher sha256 ${curPin.slice(0, 12)}… → ${appimageSha.slice(0, 12)}…`);
}

// ── 4. Keep the launcher package version in lockstep with the app ─────────────
const npmPkgPath = path.join(ROOT, 'npm', 'package.json');
const npmPkg = JSON.parse(fs.readFileSync(npmPkgPath, 'utf8'));
if (npmPkg.version !== VERSION) {
  const was = npmPkg.version;
  npmPkg.version = VERSION;
  fs.writeFileSync(npmPkgPath, JSON.stringify(npmPkg, null, 2) + '\n');
  say(`• synced npm/package.json version ${was} → ${VERSION}`);
}

// ── 5. SHA256SUMS (every staged artifact) ─────────────────────────────────────
let sums = `${appimageSha}  ${CANON.appimage}\n${debSha}  ${CANON.deb}\n`;
if (winSetupDst) sums += `${sha256(winSetupDst)}  ${CANON.winSetup}\n`;
if (winPortableDst) sums += `${sha256(winPortableDst)}  ${CANON.winPortable}\n`;
fs.writeFileSync(path.join(downloadDir, 'SHA256SUMS'), sums);
say('• wrote SHA256SUMS');

// ── 6. Warn if the connect card's version lags (it lives in the other repo) ───
const cardPath = path.resolve(ROOT, '..', 'pixel-office', 'resources', 'js', 'components', 'AgentConnectCommands.vue');
if (fs.existsSync(cardPath)) {
  const card = fs.readFileSync(cardPath, 'utf8');
  const cardVer = /const APP_VERSION = '([^']+)'/.exec(card)?.[1];
  if (cardVer && cardVer !== VERSION) {
    say(`\n⚠ connect card APP_VERSION is ${cardVer}, app is ${VERSION}.`);
    say(`  Bump it in ${path.relative(process.cwd(), cardPath)} and rebuild pixel-office assets.`);
  }
}

// ── Done: leave the irreversible steps to a human ─────────────────────────────
say(`\n✓ staged v${VERSION}`);
say(`    AppImage  ${appimageSha}`);
say(`    deb       ${debSha}`);
say(`\nNext (review, then run):`);
say(`  (autodev-app)  npm test && git add npm dist/*.yml && git commit`);
say(`  (npm publish)  cd npm && npm publish --access public`);
say(`  (pixel-office) git add public/download && git commit   # if /download is tracked`);
say(`  (prod + mirror) npm run distribute   (or re-run this with --distribute):`);
say(`                  rsync v${VERSION} → the prod /download dir + the autoaidev`);
say(`                  release mirror, refresh the stable download-button aliases`);
say(`                  (${'~/refresh-latest-aliases.sh'}), prune both to keep-${KEEP_RELEASES}, then verify`);
say(`                  prod + mirror both serve ${VERSION}. See scripts/distribute.mjs.`);

// ── 7. Optionally push the staged build outward (--distribute) ────────────────
if (runDistribute) {
  say(`\n• --distribute: pushing v${VERSION} to PROD + the autoaidev mirror…`);
  const { distribute } = await import('./distribute.mjs');
  distribute();
}
