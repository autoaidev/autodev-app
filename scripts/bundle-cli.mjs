// Stage a self-contained `autodev-cli` (the published npm package + its runtime
// deps) into vendor/autodev-cli, so electron-builder can bundle a runnable CLI
// under resources/autodev-cli (extraResources). The version is taken from this
// app's devDependencies, so bumping the package there is the single source of
// truth. Run automatically before `npm run dist` / `npm run pack`.
import { execSync } from 'node:child_process'
import { rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = String(pkg.devDependencies?.['autodev-cli'] ?? 'latest').replace(/^[\^~]/, '')
const dest = join(root, 'vendor', 'autodev-cli')

console.log(`[bundle-cli] staging autodev-cli@${version} from npm → vendor/autodev-cli`)
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
console.log('[bundle-cli] done')
