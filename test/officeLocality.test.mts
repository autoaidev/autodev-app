// Office-rail locality bucket decision — proves classifyOfficeLocality splits an
// office whose ONLY same-host loops run under another Linux account into a "foreign"
// bucket (labelled by the predominant owner), while any current-account signal
// (a tracked workspace OR a non-foreign loop, incl. one whose owner was unreadable)
// keeps it in the current "On this machine" bucket.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyOfficeLocality,
  type LocalLoopOwner,
  type OfficeAgent
} from '../src/renderer/src/components/office/officeTypes.ts'

const agent = (id: string): OfficeAgent => ({ id, slug: id } as OfficeAgent)
const group = (...ids: string[]): { agents: OfficeAgent[] } => ({ agents: ids.map(agent) })

// Build the two signal lookups the classifier reads, keyed by agent id/slug.
const tracked = (...ids: string[]) => (a: OfficeAgent): boolean => ids.includes(a.id)
const owners =
  (m: Record<string, LocalLoopOwner>) =>
  (a: OfficeAgent): LocalLoopOwner | undefined =>
    m[a.id]

test('tracked workspace → current account', () => {
  const loc = classifyOfficeLocality(group('a'), tracked('a'), owners({}))
  assert.deepEqual(loc, { kind: 'current' })
})

test('only a foreign loop → foreign, labelled by owner', () => {
  const loc = classifyOfficeLocality(
    group('a'),
    tracked(),
    owners({ a: { ownerUid: 1001, ownerUser: 'chunkfs', foreign: true } })
  )
  assert.deepEqual(loc, { kind: 'foreign', user: 'chunkfs' })
})

test('a current-account loop alongside a foreign one keeps it current', () => {
  const loc = classifyOfficeLocality(
    group('a', 'b'),
    tracked(),
    owners({
      a: { ownerUid: 1001, ownerUser: 'chunkfs', foreign: true },
      b: { ownerUid: 1000, ownerUser: 'autodev', foreign: false }
    })
  )
  assert.deepEqual(loc, { kind: 'current' })
})

test('owner unreadable (foreign:false) counts as current — pre-existing behavior', () => {
  const loc = classifyOfficeLocality(
    group('a'),
    tracked(),
    owners({ a: { foreign: false } })
  )
  assert.deepEqual(loc, { kind: 'current' })
})

test('multiple foreign users → predominant wins (mode)', () => {
  const loc = classifyOfficeLocality(
    group('a', 'b', 'c'),
    tracked(),
    owners({
      a: { ownerUser: 'chunkfs', foreign: true },
      b: { ownerUser: 'chunkfs', foreign: true },
      c: { ownerUser: 'bob', foreign: true }
    })
  )
  assert.deepEqual(loc, { kind: 'foreign', user: 'chunkfs' })
})

test('foreign owner with no username falls back to uid:<n>', () => {
  const loc = classifyOfficeLocality(
    group('a'),
    tracked(),
    owners({ a: { ownerUid: 1234, foreign: true } })
  )
  assert.deepEqual(loc, { kind: 'foreign', user: 'uid:1234' })
})

test('no local signal → none', () => {
  const loc = classifyOfficeLocality(group('a'), tracked(), owners({}))
  assert.deepEqual(loc, { kind: 'none' })
})
