/**
 * Unit tests for the sessions file-read confinement guard: backlog()/open() are
 * reachable over IPC with an arbitrary path, so only transcripts under
 * ~/.claude/projects may be read/tailed.
 * Run: `npm test` (node's built-in test runner + TS type-stripping).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { underProjects } from '../src/main/sessionManager.ts'

const root = join(homedir(), '.claude', 'projects')

test('accepts a transcript inside ~/.claude/projects', () => {
  assert.ok(underProjects(join(root, '-home-me-proj', 'abc123.jsonl')))
  assert.ok(underProjects(root)) // the root itself
})

test('rejects paths outside the projects tree', () => {
  for (const bad of [
    '/etc/passwd',
    join(homedir(), '.ssh', 'id_rsa'),
    join(homedir(), '.claude', 'history.jsonl'), // sibling of projects, still out
    join(root, '..', '..', '.ssh', 'id_rsa'),    // traversal back out
    join(root + '-evil', 'x.jsonl'),             // prefix-sibling, not a child
  ]) {
    assert.equal(underProjects(bad), false, bad)
  }
})
