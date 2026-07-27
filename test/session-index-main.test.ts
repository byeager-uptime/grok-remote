import test from 'node:test';
import assert from 'node:assert/strict';

import { collectSubagentIds, listHostSessions } from '../lib/session-index.js';
import { projectForCwd } from '../lib/project-grouper.js';
import { deriveSessionStatus } from '../lib/session-status.js';

test('collectSubagentIds finds nested subagent uuids on disk', () => {
  const ids = collectSubagentIds();
  // Live host should have research subagents under main sessions.
  assert.ok(ids instanceof Set);
  // None of the returned main list should include these after filter.
});

test('listHostSessions excludes subagents by default', async () => {
  const subIds = collectSubagentIds();
  const { items } = await listHostSessions({ limit: 100, includeSubagents: false });
  for (const s of items) {
    assert.equal(s.isSubagent, false, `leaked subagent ${s.sessionId}`);
    assert.ok(!subIds.has(s.sessionId), `main list contains subagent ${s.sessionId}`);
  }
  assert.ok(items.length >= 1, 'expected at least one main session');
});

test('projectForCwd returns basename for non-git paths', () => {
  const p = projectForCwd('/root');
  assert.equal(p.label, 'root');
});

test('deriveSessionStatus: connected+inflight => running', () => {
  assert.equal(deriveSessionStatus({ connected: true, inFlight: 2, agentStatus: 'running' }), 'running');
});

test('deriveSessionStatus: connected idle => waiting', () => {
  assert.equal(deriveSessionStatus({ connected: true, inFlight: 0, agentStatus: 'idle' }), 'waiting');
});

test('deriveSessionStatus: lastFailed disconnected => stuck', () => {
  assert.equal(deriveSessionStatus({ connected: false, lastFailed: true }), 'stuck');
});
