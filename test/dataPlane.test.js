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

test('prs() parses injected gh JSON and caches within the TTL', async () => {
  freshConfig();
  let calls = 0;
  let clock = 1000;
  const exec = async () => {
    calls++;
    return JSON.stringify([
      { number: 7, title: 'A', author: { login: 'bob' }, reviewDecision: 'CHANGES_REQUESTED', updatedAt: '2026-01-01T00:00:00Z', url: 'u7' },
    ]);
  };
  const dp = createDataPlane({ repoDir: '/x', config: { dashboardListPrs: true }, exec, now: () => clock });

  const a = await dp.prs(false);
  assert.equal(a.available, true);
  assert.equal(a.items[0].author, 'bob');
  assert.equal(a.items[0].number, 7);
  await dp.prs(false);                 // cached
  assert.equal(calls, 1);
  clock += 61 * 1000;                  // past the 60s TTL
  await dp.prs(false);
  assert.equal(calls, 2);
});

test('prs() unavailable without a repo dir or when disabled', async () => {
  freshConfig();
  const noRepo = createDataPlane({ repoDir: null, exec: async () => '[]' });
  assert.equal((await noRepo.prs(false)).available, false);
  const disabled = createDataPlane({ repoDir: '/x', config: { dashboardListPrs: false }, exec: async () => '[]' });
  assert.equal((await disabled.prs(false)).available, false);
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

test('dashboard() composes sessions + history (+ prs when enabled)', async () => {
  freshConfig();
  const sessionsDir = seedSessions();
  store.writeHistory({ version: 1, id: 'o-r-pr9-900', repo: 'o/r', pr: 9, status: 'submitted', endedAt: '2026-01-01T00:00:00Z', counts: { posted: 2 } });
  const dp = createDataPlane({
    sessionsDir, mode: 'home', repoDir: '/x', config: { dashboardListPrs: true },
    alive: () => true, exec: async () => '[]',
  });
  const d = await dp.dashboard({});
  assert.equal(d.mode, 'home');
  assert.equal(d.sessions.length, 2);
  assert.equal(d.history.length, 1);
  assert.equal(d.prs.available, true);
});
