'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildSuggestions } = require('../server/lib/suggest');
const store = require('../server/lib/store');

function freshConfig() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-suggest-'));
  process.env.PR_REPLIES_CONFIG_DIR = d;
  return d;
}

function rec(id, repo, decisions, over) {
  return Object.assign({ version: 1, id, repo, pr: 1, status: 'submitted', endedAt: '2026-03-0' + id + 'T00:00:00Z', decisions }, over);
}

test('buildSuggestions: action priors + category priors from this repo only', () => {
  freshConfig();
  store.writeHistory(rec('1', 'o/r', [
    { kind: 'review', action: 'fix', category: 'error-handling' },
    { kind: 'review', action: 'fix', category: 'error-handling' },
    { kind: 'review', action: 'reply', category: 'docs' },
  ]));
  store.writeHistory(rec('2', 'o/r', [
    { kind: 'issue', action: 'skip' },
    { kind: 'review', action: 'fix', category: 'error-handling' },
  ]));
  store.writeHistory(rec('3', 'other/repo', [{ kind: 'review', action: 'reply', category: 'tests' }]));

  const out = buildSuggestions({ repo: 'o/r' });
  assert.equal(out.sessions, 2);
  assert.equal(out.decisions, 5);
  // 3 fix / 1 reply / 1 skip of 5
  assert.equal(out.actionPriors.fix, 0.6);
  assert.equal(out.actionPriors.reply, 0.2);
  assert.equal(out.actionPriors.skip, 0.2);
  const eh = out.categoryPriors.find((c) => c.category === 'error-handling');
  assert.equal(eh.total, 3);
  assert.equal(eh.fix, 3);
  assert.equal(eh.rates.fix, 1);
  // the other repo's record is excluded
  assert.ok(!out.categoryPriors.some((c) => c.category === 'tests'));
});

test('buildSuggestions: includes merged reply templates', () => {
  freshConfig();
  store.writeUserTemplates([{ id: 't1', name: 'Ack', scope: 'reply', body: 'thanks {{author}}', tags: ['ack'] }]);
  const out = buildSuggestions({ repo: 'o/r' });
  assert.equal(out.templates.length, 1);
  assert.equal(out.templates[0].id, 't1');
  assert.deepEqual(out.templates[0].tags, ['ack']);
});

test('buildSuggestions: no history yet → zeroed priors, empty categories', () => {
  freshConfig();
  const out = buildSuggestions({ repo: 'o/r' });
  assert.equal(out.sessions, 0);
  assert.deepEqual(out.actionPriors, { fix: 0, reply: 0, skip: 0 });
  assert.deepEqual(out.categoryPriors, []);
});

test('buildSuggestions: provider filter narrows the set', () => {
  freshConfig();
  store.writeHistory(rec('1', 'o/r', [{ kind: 'review', action: 'fix' }], { provider: 'github' }));
  store.writeHistory(rec('2', 'o/r', [{ kind: 'review', action: 'reply' }], { provider: 'gitlab' }));
  assert.equal(buildSuggestions({ repo: 'o/r', provider: 'gitlab' }).sessions, 1);
  assert.equal(buildSuggestions({ repo: 'o/r', provider: 'gitlab' }).actionPriors.reply, 1);
});
