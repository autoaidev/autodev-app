/**
 * Unit tests for the connect-field URL extractor: given a pasted `autodev`
 * command or a bare URL, pull out just the URL.
 * Run: `npm test` (node's built-in test runner + TS type-stripping).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractFlagUrl, extractSetupUrl } from '../src/renderer/src/urlExtract.ts'

const SETUP = 'https://autodev.code.aioffice.works/api/cli/setup/80080e1234abcd'
const WS = 'wss://host/ws?token=abc123&endpoint=xyz'

test('extractSetupUrl pulls the URL out of a full copied command', () => {
  assert.equal(extractSetupUrl(`autodev --setup-url='${SETUP}'`), SETUP)
  assert.equal(extractSetupUrl(`autodev --setup-url="${SETUP}"`), SETUP)
  assert.equal(extractSetupUrl(`autodev --setup-url=${SETUP}`), SETUP)
  assert.equal(extractSetupUrl(`autodev start --setup-url="${SETUP}"`), SETUP)
  // extra flags before/after must be ignored
  assert.equal(extractSetupUrl(`autodev connect --file-browser --setup-url='${SETUP}' --verbose`), SETUP)
})

test('extractSetupUrl accepts a bare URL and trims whitespace/quotes', () => {
  assert.equal(extractSetupUrl(SETUP), SETUP)
  assert.equal(extractSetupUrl(`   ${SETUP}   `), SETUP)
  assert.equal(extractSetupUrl(`'${SETUP}'`), SETUP)
})

test('extractSetupUrl returns null when there is no URL', () => {
  assert.equal(extractSetupUrl(''), null)
  assert.equal(extractSetupUrl('   '), null)
  assert.equal(extractSetupUrl('just some words'), null)
  assert.equal(extractSetupUrl('autodev --help'), null)
  assert.equal(extractSetupUrl(undefined as unknown as string), null)
})

test('extractFlagUrl handles the --url / ws variants', () => {
  assert.equal(extractFlagUrl(`autodev connect --url="${WS}"`, '--url'), WS)
  assert.equal(extractFlagUrl(`autodev connect --url ${WS}`, '--url'), WS)
  assert.equal(extractFlagUrl(WS, '--url'), WS)
})

test('extractFlagUrl falls back to the first URL token when the flag is absent', () => {
  // a bare setup URL asked for under the --url flag still resolves via the URL fallback
  assert.equal(extractFlagUrl(SETUP, '--url'), SETUP)
  assert.equal(extractFlagUrl('nonsense with no link', '--url'), null)
})
