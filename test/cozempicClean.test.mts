/**
 * cozempicClean — proves the operate-path hook reconcile strips ONLY cozempic
 * SessionStart hooks and leaves every other hook/setting intact, and never throws
 * on missing/malformed files. Mirrors autodev-cli/src/cozempicHooks.ts behavior.
 * Run: `npm test` (node's built-in runner + TS type-stripping).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isCozempicCommand,
  removeCozempicHooksFromFile
} from '../src/main/cozempicClean.ts'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'cozempic-clean-'))
}

test('isCozempicCommand matches the three install shapes, not lookalikes', () => {
  assert.equal(isCozempicCommand('python3 -m cozempic prune # cozempic-hook-schema=v1'), true)
  assert.equal(isCozempicCommand('cozempic guard --session'), true)
  assert.equal(isCozempicCommand('python3 -m cozempic prune'), true)
  // Lookalikes must NOT be stripped.
  assert.equal(isCozempicCommand('echo not-cozempic'), false)
  assert.equal(isCozempicCommand('echo cozempic-lookalike-word'), false)
  assert.equal(isCozempicCommand(undefined), false)
  assert.equal(isCozempicCommand(42), false)
})

test('global settings: cozempic SessionStart hook removed, unrelated hook kept', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'settings.json')
    const settings = {
      model: 'sonnet',
      hooks: {
        SessionStart: [
          { matcher: '', hooks: [{ type: 'command', command: 'python3 -m cozempic guard # cozempic-hook-schema=v1' }] }
        ],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo audit-tool-use' }] }
        ]
      }
    }
    writeFileSync(file, JSON.stringify(settings, null, 2))

    const changed = removeCozempicHooksFromFile(file)
    assert.equal(changed, true)

    const out = JSON.parse(readFileSync(file, 'utf8'))
    // Non-hook setting preserved.
    assert.equal(out.model, 'sonnet')
    // The cozempic-only SessionStart event was pruned entirely.
    assert.equal(out.hooks.SessionStart, undefined)
    // The unrelated PreToolUse hook is untouched.
    assert.equal(out.hooks.PreToolUse[0].hooks[0].command, 'echo audit-tool-use')

    // Idempotent: a second pass changes nothing.
    assert.equal(removeCozempicHooksFromFile(file), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('keeps a non-cozempic leaf inside a mixed matcher group', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: '', hooks: [
            { type: 'command', command: 'cozempic guard' },
            { type: 'command', command: 'echo keep-me' }
          ] }
        ]
      }
    }, null, 2))

    assert.equal(removeCozempicHooksFromFile(file), true)
    const out = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(out.hooks.SessionStart[0].hooks.length, 1)
    assert.equal(out.hooks.SessionStart[0].hooks[0].command, 'echo keep-me')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing file → no throw, returns false', () => {
  assert.equal(removeCozempicHooksFromFile(join(tmpdir(), 'does-not-exist-cozempic', 'settings.json')), false)
})

test('malformed JSON → no throw, file left untouched', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'settings.json')
    const junk = '{ this is not: valid json, cozempic }'
    writeFileSync(file, junk)
    assert.equal(removeCozempicHooksFromFile(file), false)
    assert.equal(readFileSync(file, 'utf8'), junk) // untouched
    assert.equal(existsSync(file), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file without cozempic → fast path, no change', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo bye' }] }] } }, null, 2))
    assert.equal(removeCozempicHooksFromFile(file), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
