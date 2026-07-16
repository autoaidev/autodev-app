/**
 * The app's first screen is "connect to your office", and its first failure is
 * usually a bad URL or no network. Node's fetch reports every one of those as the
 * two words "fetch failed" with the real reason buried on error.cause.code. These
 * tests lock the mapping to something a person can act on.
 * Run: `npm test`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { humanizeFetchError } from '../src/main/netError.ts'

const fetchFailed = (code?: string): Error => {
  const e = new TypeError('fetch failed') as Error & { cause?: { code?: string } }
  if (code) e.cause = { code }
  return e
}

const URL_ = 'https://office.example.com/api/auth/login'

test('never surfaces the bare "fetch failed"', () => {
  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', undefined]) {
    const msg = humanizeFetchError(fetchFailed(code), URL_).message
    assert.notEqual(msg, 'fetch failed')
    assert.ok(msg.length > 'fetch failed'.length)
  }
})

test('names the host so a typo is obvious', () => {
  const msg = humanizeFetchError(fetchFailed('ENOTFOUND'), URL_).message
  assert.match(msg, /office\.example\.com/)
  assert.doesNotMatch(msg, /\/api\/auth\/login/) // host only, not the full path
})

test('DNS failure reads as "can\'t find <host>"', () => {
  assert.match(humanizeFetchError(fetchFailed('ENOTFOUND'), URL_).message, /can't find/i)
  assert.match(humanizeFetchError(fetchFailed('EAI_AGAIN'), URL_).message, /can't find/i)
})

test('connection refused points at the URL being wrong', () => {
  assert.match(humanizeFetchError(fetchFailed('ECONNREFUSED'), URL_).message, /refused/i)
})

test('TLS problems are called out as certificate errors', () => {
  for (const code of ['CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    assert.match(humanizeFetchError(fetchFailed(code), URL_).message, /certificate/i)
  }
})

test('an unknown cause still includes the code for support', () => {
  assert.match(humanizeFetchError(fetchFailed('EWEIRD'), URL_).message, /EWEIRD/)
})

test('an already-legible error (e.g. our timeout) passes through untouched', () => {
  const legible = new Error('Network timeout — check your connection')
  assert.equal(humanizeFetchError(legible, URL_).message, 'Network timeout — check your connection')
})

test('a malformed URL does not throw — falls back to the raw string', () => {
  const msg = humanizeFetchError(fetchFailed('ENOTFOUND'), 'not a url').message
  assert.ok(msg.includes('not a url'))
})
