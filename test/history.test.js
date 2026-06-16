'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHistory, computeCounts } = require('../server/lib/history');
const store = require('../server/lib/store');

function freshConfig() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-cfg-'));
  process.env.PR_REPLIES_CONFIG_DIR = d;
  return d;
}

test('computeCounts derives counts from decisions + results', () => {
  const c = computeCounts({
    decisions: [{ action: 'fix' }, { action: 'fix' }, { action: 'reply' }, { action: 'skip' }],
    posted: [{}, {}], errors: [{}], resolved: [{}],
  });
  assert.deepEqual(c, { fix: 2, reply: 1, skip: 1, posted: 2, failed: 1, resolved: 1 });
});

test('record() writes a well-formed file with injected id/startedAt/dryRun', () => {
  freshConfig();
  const h = createHistory({ id: 'o-r-pr42-1', startedAt: '2026-06-15T10:00:00Z', dryRun: true, historyMax: 200 });
  const rec = h.record({
    repo: 'o/r', pr: 42, prTitle: 'T', prUrl: 'u', endedAt: '2026-06-15T10:42:00Z', status: 'submitted',
    decisions: [{ action: 'reply' }], posted: [{ key: 'k' }], errors: [], skipped: [], resolved: [], resolveErrors: [], fixCommits: [],
  });
  assert.equal(rec.version, 1);
  assert.equal(rec.id, 'o-r-pr42-1');
  assert.equal(rec.startedAt, '2026-06-15T10:00:00Z');
  assert.equal(rec.dryRun, true);
  assert.deepEqual(rec.counts, { fix: 0, reply: 1, skip: 0, posted: 1, failed: 0, resolved: 0 });

  const onDisk = JSON.parse(fs.readFileSync(store.historyPath('o-r-pr42-1'), 'utf8'));
  assert.equal(onDisk.pr, 42);
  assert.equal(onDisk.prTitle, 'T');
  assert.equal(store.listHistory()[0].id, 'o-r-pr42-1');
});

test('record() prunes beyond historyMax', () => {
  freshConfig();
  const h = createHistory({ historyMax: 3 });
  for (let i = 0; i < 6; i++) {
    h.record({ id: 'rec-' + i, repo: 'o/r', pr: i, endedAt: '2026-01-0' + (i + 1) + 'T00:00:00Z', status: 'submitted', decisions: [], posted: [] });
    const f = store.historyPath('rec-' + i);
    const t = 1000 + i;                     // strictly increasing mtimes
    fs.utimesSync(f, t, t);
  }
  assert.equal(store.historyIds().length, 3);
  assert.deepEqual(store.historyIds().sort(), ['rec-3', 'rec-4', 'rec-5']);
});
