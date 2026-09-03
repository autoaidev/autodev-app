// Stage a self-contained `autodev-cli` (the published npm package + its runtime
// deps) into vendor/autodev-cli, so electron-builder can bundle a runnable CLI
// under resources/autodev-cli (extraResources). The version is taken from this
// app's devDependencies, so bumping the package there is the single source of
// truth. Run automatically before `npm run dist` / `npm run pack`.
import { execSync } from 'node:child_process'
import { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const range = String(pkg.devDependencies?.['autodev-cli'] ?? 'latest')
const dest = join(root, 'vendor', 'autodev-cli')

/**
 * The lowest CLI the product will accept. Mirrors pixel-office's
 * `config/services.php: services.autodev.cli_min_version` — the office flags any
 * agent below it as outdated. Kept as a literal because that value lives in a
 * different repo; if you raise it there, raise it here.
 */
const MIN_VERSION = String(pkg.autodevCliMinVersion ?? '1.4.31')

const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0) }
  return 0
}

// RESOLVE the range against the registry — do NOT strip the caret.
//
// This used to do `.replace(/^[\^~]/, '')`, which turned "^1.4.29" into the EXACT
// "1.4.29" and pinned every build to it. The result shipped for real: the app
// bundled 1.4.29 while npm was on 1.4.40 and the product's own floor was 1.4.31 —
// i.e. the app shipped a CLI BELOW its declared minimum, silently missing features
// it depends on (agent CLI-version telemetry only landed in 1.4.36, so the bundled
// agent could not even report that it was stale). And because the app resolves the
// bundled CLI before anything on PATH, `npm i -g autodev-cli@latest` could not
// rescue it either.
const resolved = execSync(`npm view ${JSON.stringify(`autodev-cli@${range}`)} version --json`, { encoding: 'utf8' })
const versions = JSON.parse(resolved)
const version = Array.isArray(versions) ? versions[versions.length - 1] : versions

if (!version) {
  console.error(`[bundle-cli] FAILED — no published autodev-cli matches "${range}"`)
  process.exit(1)
}

// Fail the BUILD rather than ship a CLI the product would flag as outdated.
if (cmp(version, MIN_VERSION) < 0) {
  console.error(`[bundle-cli] FAILED — resolved autodev-cli@${version} is below the required minimum ${MIN_VERSION}.`)
  console.error(`[bundle-cli] Raise "autodev-cli" in devDependencies (currently "${range}"). Shipping below the floor`)
  console.error('[bundle-cli] means the app bundles a CLI the office flags as outdated, and PATH cannot override it.')
  process.exit(1)
}

console.log(`[bundle-cli] ${range} → resolved autodev-cli@${version} (min ${MIN_VERSION}) → vendor/autodev-cli`)
rmSync(join(root, 'vendor'), { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
const run = (cmd) => execSync(cmd, { cwd: dest, stdio: 'inherit', shell: '/bin/bash' })
run(`npm pack autodev-cli@${version} >/dev/null 2>&1`)
run('tar xzf autodev-cli-*.tgz --strip-components=1 && rm -f autodev-cli-*.tgz')
run('npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1')

if (!existsSync(join(dest, 'bin', 'autodev.js'))) {
  console.error('[bundle-cli] FAILED — vendor/autodev-cli/bin/autodev.js missing')
  process.exit(1)
}

// Verify what actually landed — the pack could have been served from a stale cache.
const staged = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).version
if (staged !== version) {
  console.error(`[bundle-cli] FAILED — staged ${staged} but resolved ${version}`)
  process.exit(1)
}
if (cmp(staged, MIN_VERSION) < 0) {
  console.error(`[bundle-cli] FAILED — staged ${staged} is below the minimum ${MIN_VERSION}`)
  process.exit(1)
}
// Generate a REAL model catalog from the CLI we just staged, and ship it next to
// the bin (extraResources copies vendor/autodev-cli → resources/autodev-cli, so
// this lands at resources/autodev-cli/model-catalog.json). This is the app's
// OFFLINE fallback for the model pickers — main's `models:list` reads it when the
// live `autodev models --json` IPC ever fails. Generating it from the bundled CLI
// (rather than hand-maintaining a list) is what keeps the fallback from drifting
// out of sync with the real catalog — the whole point of this file.
const catalogRaw = execSync(`node ${JSON.stringify(join(dest, 'bin', 'autodev.js'))} models --json`, { encoding: 'utf8' })
let catalog
try {
  catalog = JSON.parse(catalogRaw)
} catch {
  console.error('[bundle-cli] FAILED — `autodev models --json` did not emit valid JSON')
  process.exit(1)
}
if (!Array.isArray(catalog) || catalog.length === 0 || !catalog.every((f) => f && typeof f.family === 'string' && Array.isArray(f.models))) {
  console.error('[bundle-cli] FAILED — generated model catalog is not a non-empty [{ family, default, models[] }] array')
  process.exit(1)
}
writeFileSync(join(dest, 'model-catalog.json'), JSON.stringify(catalog))
console.log(`[bundle-cli] wrote model-catalog.json — ${catalog.length} families (${catalog.map((f) => f.family).join(', ')})`)

console.log(`[bundle-cli] done — staged autodev-cli@${staged}`)
