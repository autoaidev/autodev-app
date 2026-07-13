/**
 * Unit tests for the pixel-office cookie jar.
 * Run: `npm test` (uses node's built-in test runner + TS type-stripping).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Jar, splitSetCookie } from '../src/main/cookieJar.ts'

// Real Laravel Set-Cookie lines observed from https://autodev.code.aioffice.works/api/csrf-token
const XSRF_LINE =
  'XSRF-TOKEN=eyJpdiI6ImFiYyI%3D; expires=Mon, 13 Jul 2026 20:22:49 GMT; Max-Age=7200; path=/; secure; samesite=lax'
const SESSION_LINE =
  'autodevoffice-session=eyJpdiI6InNlc3MifQ%3D%3D; expires=Mon, 13 Jul 2026 20:22:49 GMT; Max-Age=7200; path=/; secure; httponly; samesite=lax'
const REMEMBER_LINE =
  'remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d=12|abcdef|hashed; expires=Sat, 13 Jul 2027 20:22:49 GMT; Max-Age=31536000; path=/; secure; httponly; samesite=lax'

function headersWithGetSetCookie(lines: string[]): { headers: { getSetCookie: () => string[] } } {
  return { headers: { getSetCookie: () => lines } }
}
function headersCombinedOnly(lines: string[]): { headers: { get: (n: string) => string | null } } {
  const combined = lines.join(', ')
  return { headers: { get: (n: string) => (n.toLowerCase() === 'set-cookie' ? combined : null) } }
}

test('captures all cookies across multiple Set-Cookie headers (getSetCookie path)', () => {
  const jar = new Jar()
  jar.store(headersWithGetSetCookie([XSRF_LINE, SESSION_LINE, REMEMBER_LINE]))
  assert.equal(jar.size(), 3)
  assert.ok(jar.has('XSRF-TOKEN'))
  assert.ok(jar.has('autodevoffice-session'))
  assert.ok(jar.has('remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d'))
})

test('XSRF header value is url-decoded; cookie header keeps raw value', () => {
  const jar = new Jar()
  jar.store(headersWithGetSetCookie([XSRF_LINE, SESSION_LINE]))
  // header() sends the raw (still %3D-encoded) value back
  assert.match(jar.header(), /XSRF-TOKEN=eyJpdiI6ImFiYyI%3D/)
  assert.match(jar.header(), /autodevoffice-session=/)
  // xsrf() decodes for the X-XSRF-TOKEN header
  assert.equal(jar.xsrf(), 'eyJpdiI6ImFiYyI=')
})

test('splitSetCookie handles the comma inside Expires dates', () => {
  const combined = [XSRF_LINE, SESSION_LINE, REMEMBER_LINE].join(', ')
  const parts = splitSetCookie(combined)
  assert.equal(parts.length, 3)
  assert.ok(parts[0].startsWith('XSRF-TOKEN='))
  assert.ok(parts[1].startsWith('autodevoffice-session='))
  assert.ok(parts[2].startsWith('remember_web_'))
})

test('fallback combined-header path stores the same cookies', () => {
  const jar = new Jar()
  jar.store(headersCombinedOnly([XSRF_LINE, SESSION_LINE, REMEMBER_LINE]))
  assert.equal(jar.size(), 3)
  assert.equal(jar.xsrf(), 'eyJpdiI6ImFiYyI=')
})

test('later Set-Cookie updates a rotated session, but an empty delete does not wipe it', () => {
  const jar = new Jar()
  jar.store(headersWithGetSetCookie([SESSION_LINE]))
  jar.store(headersWithGetSetCookie(['autodevoffice-session=ROTATED; path=/']))
  assert.match(jar.header(), /autodevoffice-session=ROTATED/)
  // A server delete (empty value) must not clobber a good cookie.
  jar.store(headersWithGetSetCookie(['autodevoffice-session=; expires=Thu, 01 Jan 1970 00:00:00 GMT']))
  assert.match(jar.header(), /autodevoffice-session=ROTATED/)
})

test('dump/load round-trips for persistence across launches', () => {
  const jar = new Jar()
  jar.store(headersWithGetSetCookie([XSRF_LINE, SESSION_LINE, REMEMBER_LINE]))
  const dumped = jar.dump()
  const revived = new Jar()
  revived.load(dumped)
  assert.equal(revived.header(), jar.header())
  assert.equal(revived.xsrf(), jar.xsrf())
})
