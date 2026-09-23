// ptyShell — proves the cross-platform shell/argv selection (the P0 win32 fix):
// win32 uses cmd.exe (%ComSpec%) so PATH+PATHEXT resolve grok/claude .cmd shims,
// unix keeps the original $SHELL/bash -lc behaviour, and keepShell:false makes the
// command the PTY's final process. Also covers the friendly ENOENT mapping.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPtyInvocation, friendlySpawnError, firstToken } from '../src/main/ptyShell.ts'

const WIN_ENV = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } as NodeJS.ProcessEnv
const NIX_ENV = { SHELL: '/bin/zsh' } as NodeJS.ProcessEnv

test('win32: operate command (keepShell:false) runs via cmd.exe /d /s /c', () => {
  const inv = buildPtyInvocation('grok --always-approve', false, 'win32', WIN_ENV)
  assert.equal(inv.file, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(inv.args, ['/d', '/s', '/c', 'grok --always-approve'])
})

test('win32: keep-shell command drops to interactive cmd.exe via /k', () => {
  const inv = buildPtyInvocation('claude --continue', true, 'win32', WIN_ENV)
  assert.equal(inv.file, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(inv.args, ['/d', '/s', '/k', 'claude --continue'])
})

test('win32: plain terminal (no command) is an interactive cmd.exe', () => {
  const inv = buildPtyInvocation(undefined, undefined, 'win32', WIN_ENV)
  assert.equal(inv.file, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(inv.args, [])
})

test('win32: falls back to cmd.exe when ComSpec is unset', () => {
  const inv = buildPtyInvocation('grok', false, 'win32', {} as NodeJS.ProcessEnv)
  assert.equal(inv.file, 'cmd.exe')
})

test('unix: operate command (keepShell:false) runs via $SHELL -lc, command is final', () => {
  const inv = buildPtyInvocation('grok --always-approve', false, 'linux', NIX_ENV)
  assert.equal(inv.file, '/bin/zsh')
  assert.deepEqual(inv.args, ['-lc', 'grok --always-approve'])
})

test('unix: keep-shell command drops back to an interactive login shell', () => {
  const inv = buildPtyInvocation('claude', true, 'darwin', NIX_ENV)
  assert.equal(inv.file, '/bin/zsh')
  assert.equal(inv.args[0], '-lc')
  assert.match(inv.args[1], /^claude; echo; echo "\[claude exited — shell\]"; exec \/bin\/zsh -l$/)
})

test('unix: plain terminal is an interactive login shell (-il), bash when SHELL unset', () => {
  const inv = buildPtyInvocation(undefined, undefined, 'linux', {} as NodeJS.ProcessEnv)
  assert.equal(inv.file, 'bash')
  assert.deepEqual(inv.args, ['-il'])
})

test('firstToken extracts the provider binary from a command', () => {
  assert.equal(firstToken('grok --resume abc --always-approve'), 'grok')
  assert.equal(firstToken('claude --continue'), 'claude')
  assert.equal(firstToken('"C:\\path\\grok.cmd" --x'), 'C:\\path\\grok.cmd')
  assert.equal(firstToken(''), '')
})

test('friendlySpawnError names the missing binary on an ENOENT', () => {
  const msg = friendlySpawnError(new Error('spawn bash ENOENT'), 'grok --always-approve', 'win32')
  assert.match(msg, /grok/)
  assert.match(msg, /PATH/)
})

test('friendlySpawnError maps "File not found" (node-pty win32) to a clear reason', () => {
  const msg = friendlySpawnError(new Error('File not found'), 'claude --continue', 'win32')
  assert.match(msg, /claude/)
})

test('friendlySpawnError passes a non-ENOENT error through unchanged', () => {
  const msg = friendlySpawnError(new Error('EPERM: operation not permitted'), 'grok', 'linux')
  assert.match(msg, /EPERM/)
})
