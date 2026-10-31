#!/usr/bin/env node
// Distribute an already-staged desktop-app release to the PROD /download dir and
// the autoaidev.com release MIRROR, then verify both serve the expected version.
//
// WHY THIS EXISTS: scripts/publish.mjs builds + stages artifacts into the DEV
// download dir, re-pins the launcher sha and prunes DEV — then just PRINTED the
// manual "Next" steps for getting that build to prod + the mirror (an rsync/ssh
// sequence + a remote alias refresh + two prunes). Doing that by hand is
// error-prone (a forgotten alias refresh once served the PREVIOUS build to fresh
// installs, 0.3.82 → 0.3.83). This codifies that exact flow as one idempotent,
// re-runnable command.
//
// It is SAFE TO RE-RUN for an already-distributed version: rsync re-syncs
// harmlessly, the alias refresh only copies when the newest versioned file
// differs, and the prunes keep the newest-N versions. Re-running the current
// version is a no-op/update, not a destructive action.
//
// Usage:
//   node scripts/distribute.mjs           # distribute the app's current version
//   npm run distribute                    # same
//   SSHPASS=… node scripts/distribute.mjs # supply the mirror password via env
//
// It does NOT build, bump versions, npm-publish or git-commit — it only moves the
// already-staged artifacts outward and verifies the result.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneDownloads } from './prune-downloads.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Paths / hosts (top-of-file constants, env-overridable; match the
//    autoaidev.com/scripts/deploy-site.sh conventions) ─────────────────────────
const KEEP_RELEASES = 2;

// DEV download dir publish.mjs stages into — the source of this distribution.
const DEV_DOWNLOAD_DIR = process.env.AUTODEV_DOWNLOAD_DIR
  || path.resolve(ROOT, '..', 'pixel-office', 'public', 'download');

// PROD /download dir on this same box (no SSH — a local rsync).
const PROD_DOWNLOAD_DIR = process.env.AUTODEV_PROD_DOWNLOAD_DIR
  || '/home/autodev/domains/app.pixeloffice.org/pixel-office/public/download';

// autoaidev.com release mirror (SSH).
const HOST = process.env.AUTODEV_MIRROR_HOST || 'autoaidev.com';
const PORT = process.env.AUTODEV_MIRROR_PORT || '22339';
const USER = process.env.AUTODEV_MIRROR_USER || 'autoaidev';
const REMOTE_RELEASES = process.env.AUTODEV_MIRROR_RELEASES || '~/public_html/releases';
// Remote helper that repoints the stable AutoAIDev-desktop-latest.* aliases to
// the newest versioned files (lives on the release server; repo:
// autoaidev.com/scripts/refresh-latest-aliases.sh).
const REMOTE_ALIAS_REFRESH = process.env.AUTODEV_MIRROR_ALIAS_REFRESH || '~/refresh-latest-aliases.sh';

// repo-root-sibling CREDENTIALS.md (autodev-app's sibling in the GitHub dir).
const CREDENTIALS_FILE = process.env.AUTODEV_CREDENTIALS
  || path.resolve(ROOT, '..', 'CREDENTIALS.md');

// Public URLs to verify after distribution.
const PROD_URL = process.env.AUTODEV_PROD_URL || 'https://app.pixeloffice.org/download';
const MIRROR_URL = process.env.AUTODEV_MIRROR_URL || 'https://autoaidev.com/releases';

// The three auto-update feeds that travel with the artifacts.
const YML_FEEDS = ['latest-linux.yml', 'latest.yml', 'latest-mac.yml'];

const appPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = appPkg.version;
const APPIMAGE = `AutoDev-${VERSION}-x86_64.AppImage`; // canonical name, HEAD-checked

const say = (m) => process.stdout.write(`${m}\n`);
const die = (m) => { process.stderr.write(`\ndistribute: ${m}\n`); process.exit(1); };

// ── Credentials: $SSHPASS, else the `SSH password:` line following the
//    `release mirror` marker in CREDENTIALS.md. NEVER printed; NEVER hardcoded.
//    (JS equivalent of the awk one-liner used for the release mirror elsewhere.)
function mirrorPassword() {
  if (process.env.SSHPASS) return process.env.SSHPASS;
  let text;
  try {
    text = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
  } catch {
    die(`no mirror password: $SSHPASS unset and can't read ${CREDENTIALS_FILE}`);
  }
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    if (/release mirror/i.test(line)) { inBlock = true; continue; }
    if (inBlock) {
      const m = /SSH password:\s*(.+?)\s*$/.exec(line);
      if (m) return m[1];
      // Stop at the next block header so we never bleed into another section.
      if (/^\S.*:\s*$/.test(line) && !/SSH /.test(line)) break;
    }
  }
  die(`no mirror password: no "SSH password:" under the "release mirror" block in ${CREDENTIALS_FILE} and $SSHPASS unset`);
}

function commandExists(cmd) {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Current-version files to distribute: every AutoDev-<ver>-* artifact present in
// the DEV dir (AppImage/deb/exe + blockmaps, and any mac zip if one was staged)
// plus whichever of the three yml feeds exist.
function filesToDistribute() {
  if (!fs.existsSync(DEV_DOWNLOAD_DIR)) die(`DEV download dir not found: ${DEV_DOWNLOAD_DIR} — run scripts/publish.mjs first`);
  const all = fs.readdirSync(DEV_DOWNLOAD_DIR);
  const verPrefix = `AutoDev-${VERSION}-`;
  const artifacts = all.filter((f) => f.startsWith(verPrefix));
  if (!artifacts.includes(APPIMAGE)) {
    die(`DEV dir ${DEV_DOWNLOAD_DIR} has no ${APPIMAGE} — current version is ${VERSION}; stage it first (scripts/publish.mjs)`);
  }
  const feeds = YML_FEEDS.filter((f) => all.includes(f));
  if (feeds.length === 0) die(`DEV dir ${DEV_DOWNLOAD_DIR} has none of ${YML_FEEDS.join(', ')} — nothing to distribute`);
  return [...artifacts, ...feeds].map((f) => path.join(DEV_DOWNLOAD_DIR, f));
}

// ── 1. PROD /download (local rsync, no SSH) ───────────────────────────────────
function distributeProd(files) {
  say(`\n• PROD → ${PROD_DOWNLOAD_DIR}`);
  fs.mkdirSync(PROD_DOWNLOAD_DIR, { recursive: true });
  execFileSync('rsync', ['-a', '--itemize-changes', ...files, `${PROD_DOWNLOAD_DIR}/`], { stdio: 'inherit' });
  say(`• pruning PROD (keep newest ${KEEP_RELEASES}, mac zips preserved)`);
  pruneDownloads(PROD_DOWNLOAD_DIR, KEEP_RELEASES, say, { preserveMacZips: true });
}

// ── 2. autoaidev mirror (SSH) ─────────────────────────────────────────────────
function distributeMirror(files, pw) {
  const env = { ...process.env, SSHPASS: pw };
  const sshOpt = `ssh -p ${PORT} -o StrictHostKeyChecking=no -o ConnectTimeout=20`;
  say(`\n• MIRROR → ${USER}@${HOST}:${REMOTE_RELEASES} (port ${PORT})`);

  // rsync the current version's artifacts + feeds up.
  execFileSync('sshpass', ['-e', 'rsync', '-az', '--itemize-changes', '-e', sshOpt,
    ...files, `${USER}@${HOST}:${REMOTE_RELEASES}/`], { stdio: 'inherit', env });

  // Repoint the stable aliases to the newest versioned files.
  say(`• refreshing stable aliases (${REMOTE_ALIAS_REFRESH} ${REMOTE_RELEASES})`);
  execFileSync('sshpass', ['-e', 'ssh', '-p', PORT, '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=20', `${USER}@${HOST}`,
    `${REMOTE_ALIAS_REFRESH} ${REMOTE_RELEASES}`], { stdio: 'inherit', env });

  // Prune the mirror to newest-N AutoDev-<ver>-* versions. Never touches *.vsix
  // or the AutoAIDev-desktop-latest.* aliases (they don't match AutoDev-<ver>-),
  // and explicitly keeps any *-mac.zip so the mac feed can't 404.
  say(`• pruning MIRROR (keep newest ${KEEP_RELEASES}, mac zips preserved)`);
  const remotePrune = [
    `cd ${REMOTE_RELEASES} || { echo "distribute(mirror): no releases dir ${REMOTE_RELEASES}" >&2; exit 1; }`,
    `versions=$(ls -1 2>/dev/null | sed -nE 's/^AutoDev-([0-9]+\\.[0-9]+\\.[0-9]+)-.*/\\1/p' | sort -V -u)`,
    `keep=$(printf '%s\\n' "$versions" | tail -${KEEP_RELEASES})`,
    `for v in $versions; do`,
    `  printf '%s\\n' "$keep" | grep -qx "$v" && continue`,
    `  for f in AutoDev-$v-*; do`,
    `    [ -e "$f" ] || continue`,
    `    case "$f" in *-mac.zip|*-mac.zip.blockmap) echo "  (keep mac) $f"; continue;; esac`,
    `    rm -f "$f" && echo "  deleted $f"`,
    `  done`,
    `done`,
    `echo "• mirror kept version(s): $(printf '%s ' $keep)"`,
  ].join('\n');
  execFileSync('sshpass', ['-e', 'ssh', '-p', PORT, '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=20', `${USER}@${HOST}`, remotePrune], { stdio: 'inherit', env });
}

// ── 3. Verify both endpoints serve the expected version ───────────────────────
function curlText(url) {
  try {
    return execFileSync('curl', ['-fsS', '--max-time', '30', url], { encoding: 'utf8' });
  } catch { return null; }
}
function curlStatus(url) {
  try {
    return execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}',
      '--max-time', '30', '-I', url], { encoding: 'utf8' }).trim();
  } catch { return '000'; }
}
function ymlVersion(text) {
  const m = text && /^version:\s*([^\s]+)/m.exec(text);
  return m ? m[1] : null;
}

function verify() {
  say(`\n• verifying both endpoints report ${VERSION}`);
  const checks = [];

  const prodYml = ymlVersion(curlText(`${PROD_URL}/latest.yml`));
  checks.push([`prod   latest.yml        = ${prodYml ?? '(unreachable)'}`, prodYml === VERSION]);

  const mirrorYml = ymlVersion(curlText(`${MIRROR_URL}/latest-linux.yml`));
  checks.push([`mirror latest-linux.yml  = ${mirrorYml ?? '(unreachable)'}`, mirrorYml === VERSION]);

  const prodHead = curlStatus(`${PROD_URL}/${APPIMAGE}`);
  checks.push([`prod   ${APPIMAGE} → HTTP ${prodHead}`, prodHead === '200']);

  const mirrorHead = curlStatus(`${MIRROR_URL}/${APPIMAGE}`);
  checks.push([`mirror ${APPIMAGE} → HTTP ${mirrorHead}`, mirrorHead === '200']);

  say('');
  let ok = true;
  for (const [label, pass] of checks) {
    say(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) ok = false;
  }
  return ok;
}

// ── Orchestrate ───────────────────────────────────────────────────────────────
export function distribute() {
  say(`distribute v${VERSION}`);

  if (!commandExists('sshpass')) {
    die(`'sshpass' not found — install it (apt-get install sshpass); needed for the mirror.`);
  }
  if (!commandExists('rsync')) die(`'rsync' not found — install it (apt-get install rsync).`);

  const files = filesToDistribute();
  say(`• distributing ${files.length} file(s) for v${VERSION} from ${DEV_DOWNLOAD_DIR}`);
  for (const f of files) say(`    ${path.basename(f)}`);

  // Resolve the mirror password up front so we fail early (never hang) if the
  // mirror can't be reached — rather than doing PROD and then dying on SSH.
  const pw = mirrorPassword();

  distributeProd(files);
  distributeMirror(files, pw);

  const ok = verify();
  if (ok) {
    say(`\n✓ distributed v${VERSION} — prod + mirror both serve ${VERSION}`);
  } else {
    die(`verification FAILED — prod and/or mirror do not report ${VERSION} (see ✗ above)`);
  }
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  distribute();
}
