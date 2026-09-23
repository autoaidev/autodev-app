// stripAnsi — proves the read-only loop pane no longer renders ANSI escape codes
// as □ squares (the reported "□[90m[5:44:37 PM]□[0m" artifact).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripAnsi } from '../src/renderer/src/lib/ansi.ts'

const ESC = '\x1b'

test('strips SGR colour codes (the reported timestamp artifact)', () => {
  const raw = `${ESC}[90m[5:44:37 PM]${ESC}[0m building the movie`
  assert.equal(stripAnsi(raw), '[5:44:37 PM] building the movie')
})

test('leaves no ESC byte behind', () => {
  const raw = `${ESC}[1;32mDONE${ESC}[0m\n${ESC}[31merror${ESC}[0m`
  const out = stripAnsi(raw)
  assert.equal(out.includes(ESC), false)
  assert.equal(out, 'DONE\nerror')
})

test('strips cursor-move / erase (CSI non-m) and OSC title sequences', () => {
  const raw = `${ESC}[2J${ESC}[H${ESC}]0;my title${ESC}\\hello${ESC}[K`
  assert.equal(stripAnsi(raw), 'hello')
})

test('keeps tabs and newlines, drops other control bytes', () => {
  const raw = `a\tb\nc\x00\x07d`
  assert.equal(stripAnsi(raw), 'a\tb\ncd')
})

test('returns clean text unchanged (fast path)', () => {
  const clean = 'no escapes here'
  assert.equal(stripAnsi(clean), clean)
})
