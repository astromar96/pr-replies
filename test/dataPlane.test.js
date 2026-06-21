'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDataPlane } = require('../server/lib/dataPlane');
const store = require('../server/lib/store');

function freshConfig() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-cfg-'));
  process.env.PR_REPLIES_CONFIG_DIR = d;
  return d;
}

// A fake /tmp/pr-replies with two session dirs.
function seedSessions() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-sess-'));
  function write(name, obj) {
    fs.mkdirSync(path.join(base, name), { recursive: true });
    fs.writeFileSync(path.join(base, name, 'session.json'), JSON.stringify(obj));
  }
  write('o-r-pr1-100', { pid: 1001, port: 5001, token: 't1', url: 'http://127.0.0.1:5001/t1/', phase: 'reply', repo: 'o/r', pr: 1, startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T01:00:00Z' });
  write('o-r-pr2-200', { pid: 1002, port: 5002, token: 't2', url: 'http://127.0.0.1:5002/t2/', phase: 'triage', repo: 'o/r', pr: 2, startedAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T01:00:00Z' });
  return base;
}

test('sessions() reports liveness via injected isPidAlive, live-first', () => {
  freshConfig();
  const sessionsDir = seedSessions();
  const dp = createDataPlane({ sessionsDir, alive: (pid) => pid === 1002 });
  const sessions = dp.sessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].alive, true);     // pid 1002 sorted first
  assert.equal(sessions[0].pr, 2);
  assert.equal(sessions[1].alive, false);
});

test('pruneStale removes dead+old dirs, keeps live, recent, and bootstrapping dirs', () => {
  freshConfig();
  const base = seedSessions(); // pr1 (pid 1001) + pr2 (pid 1002), both updatedAt Jan 2026 (old)
  // a recently-touched but dead session
  fs.mkdirSync(path.join(base, 'o-r-pr3-300'));
  fs.writeFileSync(path.join(base, 'o-r-pr3-300', 'session.json'),
    JSON.stringify({ pid: 1003, phase: 'reply', repo: 'o/r', pr: 3, updatedAt: new Date(Date.now() - 60000).toISOString() }));
  // a dir mid-boot: no session.json yet
  fs.mkdirSync(path.join(base, 'o-r-pr4-400'));

  const dp = createDataPlane({ sessionsDir: base, alive: (pid) => pid === 1002 });
  const { removed } = dp.pruneStale();

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(path.join(base, 'o-r-pr1-100')), false); // dead + old → pruned
  assert.equal(fs.existsSync(path.join(base, 'o-r-pr2-200')), true);  // live → kept
  assert.equal(fs.existsSync(path.join(base, 'o-r-pr3-300')), true);  // dead but recent → kept
  assert.equal(fs.existsSync(path.join(base, 'o-r-pr4-400')), true);  // no session.json → kept
});

test('prs() lists open PRs via the provider, and degrades gracefully', async () => {
  freshConfig();
  // No provider/repoDir → tagged error, never throws.
  const bare = createDataPlane({});
  const none = await bare.prs();
  assert.deepEqual(none.prs, []);
  assert.match(none.error, /no repository context/);

  // With a provider + repoDir → the listed PRs, error null.
  const provider = { name: 'github', listPrs: async () => [{ number: 7, title: 'Fix', author: 'a', url: 'u' }] };
  const dp = createDataPlane({ provider, repo: 'o/r', repoDir: '/tmp/x' });
  const ok = await dp.prs();
  assert.equal(ok.repo, 'o/r');
  assert.equal(ok.provider, 'github');
  assert.equal(ok.prs.length, 1);
  assert.equal(ok.prs[0].number, 7);
  assert.equal(ok.error, null);

  // A provider failure surfaces as a tagged error, not a throw.
  const boom = createDataPlane({ provider: { name: 'github', listPrs: async () => { throw new Error('gh down'); } }, repo: 'o/r', repoDir: '/tmp/x' });
  const failed = await boom.prs();
  assert.deepEqual(failed.prs, []);
  assert.match(failed.error, /gh down/);
});

test('templates() and saveTemplates() round-trip through the store', () => {
  freshConfig();
  const dp = createDataPlane({});
  assert.deepEqual(dp.templates(), []);
  const merged = dp.saveTemplates([{ id: 't', name: 'T', scope: 'reply', body: 'hi' }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 't');
  assert.equal(dp.templates()[0].body, 'hi');
});

test('historyDetail() only returns ids present in the listing', () => {
  freshConfig();
  store.writeHistory({ version: 1, id: 'o-r-pr1-100', repo: 'o/r', pr: 1, status: 'submitted', endedAt: '2026-01-01T00:00:00Z', counts: {} });
  const dp = createDataPlane({});
  assert.equal(dp.historyDetail('o-r-pr1-100').pr, 1);
  assert.equal(dp.historyDetail('missing'), null);
  assert.equal(dp.historyDetail('../escape'), null);
});

test('history() returns the newest-first session summaries', () => {
  freshConfig();
  store.writeHistory({ version: 1, id: 'o-r-pr1-1', repo: 'o/r', pr: 1, status: 'submitted', endedAt: '2026-03-01T10:20:00Z', counts: { posted: 1 } });
  store.writeHistory({ version: 1, id: 'o-r-pr2-2', repo: 'o/r', pr: 2, status: 'submitted', endedAt: '2026-03-02T10:40:00Z', counts: { posted: 2 } });
  const dp = createDataPlane({});
  const h = dp.history();
  assert.equal(h.length, 2);
  assert.equal(h[0].pr, 2); // newest by endedAt first
});
