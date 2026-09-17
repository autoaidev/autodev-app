// Office-rail sort helper — proves the default "Recent" order (most-recently-active
// first) plus the Name / Online / Characters options and their name tiebreak.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortOffices, type OfficeSort } from '../src/renderer/src/components/office/officeTypes.ts'

type G = ReturnType<typeof sortOffices>[number]
const mk = (
  slug: string,
  name: string,
  opts: { last?: string | null; created?: string | null; online?: number; chars?: number } = {}
): G => ({
  slug,
  name,
  agents: Array.from({ length: opts.chars ?? 0 }, (_, i) => ({ id: `${slug}-${i}` }) as G['agents'][number]),
  onlineCount: opts.online ?? 0,
  lastActivityAt: opts.last ?? null,
  createdAt: opts.created ?? null
})

const ids = (gs: G[]): string[] => gs.map((g) => g.slug)
const run = (gs: G[], s: OfficeSort): string[] => ids(sortOffices(gs, s))

test('recent (default) orders by lastActivityAt desc, then createdAt, then name', () => {
  const a = mk('a', 'Alpha', { last: '2026-09-10T00:00:00Z' })
  const b = mk('b', 'Bravo', { last: '2026-09-17T12:00:00Z' })
  const c = mk('c', 'Charlie', { last: null, created: '2026-01-01T00:00:00Z' })
  assert.deepEqual(run([a, c, b], 'recent'), ['b', 'a', 'c'])
})

test('recent falls back to name when there is no recency signal at all', () => {
  const x = mk('x', 'Zeta')
  const y = mk('y', 'Alpha')
  assert.deepEqual(run([x, y], 'recent'), ['y', 'x'])
})

test('name sorts A–Z case-insensitively', () => {
  const gs = [mk('1', 'zebra'), mk('2', 'Apple'), mk('3', 'mango')]
  assert.deepEqual(run(gs, 'name'), ['2', '3', '1'])
})

test('online puts offices with online characters first, then recency', () => {
  const a = mk('a', 'A', { online: 0, last: '2026-09-17T00:00:00Z' })
  const b = mk('b', 'B', { online: 3, last: '2026-09-10T00:00:00Z' })
  const c = mk('c', 'C', { online: 3, last: '2026-09-16T00:00:00Z' })
  // Both online (3) → the more recent (c) leads; the offline one (a) trails.
  assert.deepEqual(run([a, b, c], 'online'), ['c', 'b', 'a'])
})

test('characters sorts by agent count desc, then recency', () => {
  const a = mk('a', 'A', { chars: 1 })
  const b = mk('b', 'B', { chars: 5 })
  const c = mk('c', 'C', { chars: 5, last: '2026-09-17T00:00:00Z' })
  assert.deepEqual(run([a, b, c], 'characters'), ['c', 'b', 'a'])
})

test('sortOffices does not mutate its input', () => {
  const gs = [mk('b', 'B', { last: '2026-01-01T00:00:00Z' }), mk('a', 'A', { last: '2026-09-01T00:00:00Z' })]
  const before = ids(gs)
  sortOffices(gs, 'recent')
  assert.deepEqual(ids(gs), before)
})
