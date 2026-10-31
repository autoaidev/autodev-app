#!/usr/bin/env node
// Prune old versioned release binaries from a /download dir, keeping only the N
// newest versions. Without this, every release stages a new ~0.75 GB set of
// per-platform binaries (AppImage/exe/mac-zip/deb + blockmaps) and NOTHING removes
// the old ones — 47 versions once piled up to 18 GB per download dir (dev + prod).
//
// Preserves everything that is NOT a versioned AutoDev-* binary: latest*.yml (the
// auto-update feeds — always kept so updates keep resolving), *.vsix (the VS Code
// extension), SHA256SUMS, and any other file. Only `AutoDev-<x.y.z>-*` files for
// versions outside the newest `keep` are removed.
//
// Usage: node scripts/prune-downloads.mjs <dir> [keep=2]
import fs from 'node:fs';
import path from 'node:path';

const RE = /^AutoDev-(\d+\.\d+\.\d+)-/;

function cmpSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// Mac zips ship on a different cadence than linux/win (built rarely via
// `dist:mac`), so the newest-2 *linux/win* versions are almost never the
// versions whose mac zip the live latest-mac.yml still points at. A blunt
// semver prune that matched a `AutoDev-<old>-*-mac.zip` would therefore 404 the
// mac auto-update feed. `preserveMacZips` keeps any `*-mac.zip`(+`.blockmap`)
// regardless of version — a no-op for the current `AutoAIDev-desktop-*-mac.zip`
// naming (which already falls outside the AutoDev- regex), but defense-in-depth
// if a future build ever emits mac zips under the canonical AutoDev- name.
const MAC_ZIP_RE = /-mac\.zip(\.blockmap)?$/;

export function pruneDownloads(dir, keep = 2, log = () => {}, opts = {}) {
  const { preserveMacZips = false } = opts;
  if (!fs.existsSync(dir)) return { kept: [], deleted: 0, dir };
  const files = fs.readdirSync(dir);
  const versions = new Set();
  for (const f of files) {
    const m = RE.exec(f);
    if (m) versions.add(m[1]);
  }
  const ordered = [...versions].sort(cmpSemver).reverse(); // newest first
  const keepSet = new Set(ordered.slice(0, keep));
  let deleted = 0;
  for (const f of files) {
    const m = RE.exec(f);
    if (m && !keepSet.has(m[1])) {
      if (preserveMacZips && MAC_ZIP_RE.test(f)) continue;
      fs.rmSync(path.join(dir, f), { force: true });
      deleted++;
    }
  }
  const dropped = ordered.length - keepSet.size;
  log(`• pruned ${dir} — kept ${[...keepSet].join(', ') || '(none)'}, deleted ${deleted} file(s) from ${dropped} old version(s)`);
  return { kept: [...keepSet], deleted, dir };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  const keep = Number(process.argv[3] || 2);
  if (!dir) {
    process.stderr.write('usage: node scripts/prune-downloads.mjs <dir> [keep=2]\n');
    process.exit(1);
  }
  const r = pruneDownloads(dir, keep, (m) => process.stdout.write(m + '\n'));
  process.stdout.write(`done: kept [${r.kept.join(', ')}], deleted ${r.deleted}\n`);
}
