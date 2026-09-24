// grokTrust — the Windows unescaped-backslash TOML bug that blocks grok Operate.
//
// The app pre-trusts an operate dir in ~/.grok/trusted_folders.toml by writing a
// DOUBLE-QUOTED TOML header `[folders."<path>"]`. The old code wrote the raw OS
// path, so on Windows `C:\Users\…` landed with LONE backslashes → invalid TOML
// escapes (\U,\u,\a,\.,\t,\d) → grok "trust store could not be read" → falls back
// to the interactive trust prompt and `grok --always-approve` can't launch.
//
// Locks: (1) fresh store → ESCAPED key, valid TOML, round-trips to the exact
// Windows path, (2) a store corrupted by the old bug is REPAIRED (all entries
// preserved + escaped, no lone backslash), (3) idempotent.
// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { markGrokFolderTrusted, escapeTomlKey, recoverPath, storeNeedsRepair } from '../src/main/grokTrust.ts'

// A tiny grok-style TOML folders-key reader: throws on an INVALID escape exactly
// as grok's real parser does, so a store with the old bug fails to parse here.
function parseFolderKeys(text: string): string[] {
  const keys: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\[folders\."(.*)"\]\s*$/)
    if (!m) continue
    const inner = m[1]
    let decoded = ''
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i]
      if (c === '\\') {
        const n = inner[i + 1]
        if (n === '\\') { decoded += '\\'; i++ }
        else if (n === '"') { decoded += '"'; i++ }
        else throw new Error('invalid TOML escape \\' + n)
      } else decoded += c
    }
    keys.push(decoded)
  }
  return keys
}

const WIN = 'C:\\Users\\user\\.autodev-app\\offices\\o\\a-1'
// markGrokFolderTrusted calls resolve(): on Windows it keeps `C:\…`; on the Linux
// CI host resolve() prepends cwd. The ESCAPING + REPAIR we prove is
// platform-independent — assert the new entry against the same resolve the code
// uses. On the real Windows target EXP === WIN.
const EXP = path.resolve(WIN)

// The user's ACTUAL corrupt store — three offices, unescaped backslashes.
const CORRUPT = [
  '[folders."C:\\Users\\user\\.autodev-app\\offices\\test-fakturi\\accountant-a22ef"]',
  'trusted = true',
  'decided_at = 1790173797',
  '',
  '[folders."C:\\Users\\user\\.autodev-app\\offices\\railroad-reseach\\society-analyst-8d03d"]',
  'trusted = true',
  'decided_at = 1790246856',
  '',
  '[folders."C:\\Users\\user\\.autodev-app\\offices\\railroad-reseach\\data-engineer-42e57"]',
  'trusted = true',
  'decided_at = 1790246886',
  ''
].join('\n')

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-trust-app-'))
  process.env.GROK_HOME = dir
  return dir
}

test('escapeTomlKey doubles backslashes and escapes quotes', () => {
  assert.equal(escapeTomlKey(WIN), 'C:\\\\Users\\\\user\\\\.autodev-app\\\\offices\\\\o\\\\a-1')
  assert.equal(escapeTomlKey('a"b'), 'a\\"b')
})

test('recoverPath round-trips both escaped and raw forms to the same OS path', () => {
  assert.equal(recoverPath(escapeTomlKey(WIN)), WIN)
  assert.equal(recoverPath(WIN), WIN)
})

test('the OLD raw fixture proves the bug: grok-style parser rejects it', () => {
  assert.throws(() => parseFolderKeys(CORRUPT), /invalid TOML escape/)
  assert.equal(storeNeedsRepair(CORRUPT), true)
})

test('fresh store: escaped key, valid TOML, round-trips to the exact Windows path', () => {
  const home = tmpHome()
  markGrokFolderTrusted(WIN)
  const tf = path.join(home, '.grok', 'trusted_folders.toml')
  const text = fs.readFileSync(tf, 'utf8')
  // the Windows tail is escaped (doubled backslashes) as a substring of the key
  assert.ok(text.includes('C:\\\\Users\\\\user\\\\.autodev-app\\\\offices\\\\o\\\\a-1'))
  const keys = parseFolderKeys(text) // does not throw => valid
  assert.deepEqual(keys, [EXP])
  assert.equal(storeNeedsRepair(text), false)
})

test('corrupt store is REPAIRED: valid TOML, 3 originals preserved + new added once', () => {
  const home = tmpHome()
  const gdir = path.join(home, '.grok')
  fs.mkdirSync(gdir, { recursive: true })
  const tf = path.join(gdir, 'trusted_folders.toml')
  fs.writeFileSync(tf, CORRUPT, 'utf8')

  markGrokFolderTrusted(WIN)

  const text = fs.readFileSync(tf, 'utf8')
  const keys = parseFolderKeys(text) // must NOT throw now
  assert.ok(keys.includes('C:\\Users\\user\\.autodev-app\\offices\\test-fakturi\\accountant-a22ef'))
  assert.ok(keys.includes('C:\\Users\\user\\.autodev-app\\offices\\railroad-reseach\\society-analyst-8d03d'))
  assert.ok(keys.includes('C:\\Users\\user\\.autodev-app\\offices\\railroad-reseach\\data-engineer-42e57'))
  assert.ok(keys.includes(EXP))
  assert.equal(keys.length, 4)
  // decided_at values preserved
  assert.ok(text.includes('decided_at = 1790173797'))
  assert.ok(text.includes('decided_at = 1790246856'))
  assert.ok(text.includes('decided_at = 1790246886'))
  // no unescaped backslash remains in any folders key
  assert.equal(storeNeedsRepair(text), false)
  // broken original backed up
  assert.ok(fs.readdirSync(gdir).some((f) => f.startsWith('trusted_folders.toml.bak-')))
})

test('idempotent: calling twice does not duplicate the entry', () => {
  const home = tmpHome()
  markGrokFolderTrusted(WIN)
  markGrokFolderTrusted(WIN)
  const text = fs.readFileSync(path.join(home, '.grok', 'trusted_folders.toml'), 'utf8')
  const keys = parseFolderKeys(text)
  assert.equal(keys.filter((k) => k === EXP).length, 1)
  assert.equal(keys.length, 1)
})
