// Offline tests for the npx launcher.
//
// The launcher downloads a 126 MB binary and executes it, so the checks that
// matter are: does it refuse a file that fails its checksum, and do the version
// and hash it is pinned to actually match the artifact we publish? A drifted
// version silently builds a 404 URL; a drifted hash bricks every install.
//
// Run: node test/launcher.test.mjs
import assert from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'autodev-app.js');
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
const SRC = fs.readFileSync(BIN, 'utf8');
const PINNED = /const SHA256 = '([a-f0-9]{64})'/.exec(SRC)?.[1];

// MUST be async. spawnSync blocks this process's event loop, so an in-process
// test server can never answer the child and both sides hang until the timeout.
function run(env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN], { env: { ...process.env, ...env } });
    let stderr = '';
    c.stderr.on('data', (d) => { stderr += d; });
    c.stdout.on('data', () => {});
    c.on('exit', (status) => resolve({ status, stderr }));
  });
}

// A port nothing is listening on. Port 1 does NOT work: fetch rejects it as a
// "bad port" without ever connecting, so we'd never see a connection error.
async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('the pinned version matches the app it downloads', () => {
  // ASSET is built from this version. Drift => a 404 on every first run.
  const app = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8'));
  assert.strictEqual(
    PKG.version, app.version,
    'npm/package.json version must track the desktop app version — the download URL is built from it'
  );
});

test('the pinned sha256 matches the published artifact', (t) => {
  const sums = path.join(HERE, '..', '..', '..', 'pixel-office', 'public', 'download', 'SHA256SUMS');
  if (!fs.existsSync(sums)) return t.skip('SHA256SUMS not present in this checkout');
  const want = new Map(
    fs.readFileSync(sums, 'utf8').trim().split('\n')
      .map((l) => l.trim().split(/\s+/)).map(([h, f]) => [f, h])
  );
  const asset = `AutoDev-${PKG.version}-x86_64.AppImage`;
  assert.ok(want.has(asset), `${asset} must exist in SHA256SUMS`);
  assert.strictEqual(PINNED, want.get(asset), `pinned SHA256 must equal the published ${asset}`);
});

test('a file that fails the checksum is refused, not executed', async () => {
  // Serve something that is NOT the app. The launcher must notice and abort.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-length': '9' });
    res.end('not-a-app');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-launcher-'));
  try {
    const r = await run({ AUTODEV_APP_DOWNLOAD_BASE: base, XDG_CACHE_HOME: cache });
    assert.strictEqual(r.status, 1, 'must exit non-zero on a checksum mismatch');
    assert.match(r.stderr, /checksum mismatch/i, 'must say why it refused');
    assert.ok(
      !fs.existsSync(path.join(cache, 'autodev-app', PKG.version, `AutoDev-${PKG.version}-x86_64.AppImage`)),
      'the rejected file must not be left behind where a later run could execute it'
    );
  } finally {
    server.close();
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test('an unreachable host explains itself instead of saying "fetch failed"', async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-launcher-'));
  try {
    const port = await closedPort();
    const r = await run({ AUTODEV_APP_DOWNLOAD_BASE: `http://127.0.0.1:${port}`, XDG_CACHE_HOME: cache });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /could not reach/i, 'must name the failure');
    assert.match(r.stderr, /ECONNREFUSED/, 'must surface the underlying cause, not just "fetch failed"');
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test('ELECTRON_RUN_AS_NODE is stripped from the child environment', () => {
  // Verified empirically: with this set, Electron runs as plain Node and the app
  // exits 0 with no window and no error. Claude Code and some Electron-hosted
  // terminals export it, so a user in one would see "nothing happened".
  assert.match(SRC, /delete env\.ELECTRON_RUN_AS_NODE/, 'the launcher must delete it');
  assert.match(SRC, /env: cleanEnv\(\)/, 'and must use the cleaned env when spawning');
  assert.ok(
    !/env: \{ \.\.\.process\.env, ELECTRON_RUN_AS_NODE: undefined \}/.test(SRC),
    'assigning undefined into an env object is not a reliable delete'
  );
});

test('non-linux/x64 is refused with a clear message, not a broken download', () => {
  assert.match(SRC, /process\.platform !== 'linux' \|\| process\.arch !== 'x64'/);
  assert.strictEqual(PKG.os?.[0], 'linux', 'package os field must gate installs too');
  assert.strictEqual(PKG.cpu?.[0], 'x64');
});
