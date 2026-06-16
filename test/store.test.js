'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../server/lib/store');

// Each test points the config dir at a fresh temp dir so nothing touches the
// developer's real ~/.config/pr-replies.
function freshConfig() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-cfg-'));
  process.env.PR_REPLIES_CONFIG_DIR = d;
  return d;
}

function freshRepo(templates) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-repo-'));
  if (templates) {
    fs.mkdirSync(path.join(d, '.pr-replies'), { recursive: true });
    fs.writeFileSync(path.join(d, '.pr-replies', 'templates.json'), JSON.stringify({ version: 1, templates }));
  }
  return d;
}

test('templates: missing files read as empty', () => {
  freshConfig();
  assert.deepEqual(store.readMergedTemplates(null), []);
  assert.deepEqual(store.readMergedTemplates(freshRepo(null)), []);
});

test('templates: user overrides repo on id collision; repo rows tagged read-only', () => {
  freshConfig();
  const repo = freshRepo([
    { id: 'ack', name: 'Repo ack', scope: 'reply', body: 'repo body' },
    { id: 'oos', name: 'Out of scope', scope: 'reply', body: 'later' },
  ]);
  store.writeUserTemplates([{ id: 'ack', name: 'User ack', scope: 'reply', body: 'user body' }]);

  const merged = store.readMergedTemplates(repo);
  const byId = Object.fromEntries(merged.map((t) => [t.id, t]));
  assert.equal(merged.length, 2);
  assert.equal(byId.ack.body, 'user body');        // user wins
  assert.equal(byId.ack.source, 'user');
  assert.equal(byId.ack.readonly, false);
  assert.equal(byId.oos.source, 'repo');
  assert.equal(byId.oos.readonly, true);
});

test('templates: writeUserTemplates round-trips and never writes the repo file', () => {
  freshConfig();
  const repo = freshRepo([{ id: 'r', name: 'R', scope: 'reply', body: 'repo' }]);
  const repoFile = path.join(repo, '.pr-replies', 'templates.json');
  const before = fs.readFileSync(repoFile, 'utf8');

  store.writeUserTemplates([{ id: 'u', name: 'U', scope: 'both', body: 'mine', tags: ['x'], source: 'user', readonly: false }]);
  const round = store.readMergedTemplates(null);
  assert.equal(round.length, 1);
  assert.equal(round[0].id, 'u');
  assert.deepEqual(round[0].tags, ['x']);
  // transient tags are stripped from the persisted file
  const onDisk = JSON.parse(fs.readFileSync(store.templatesUserPath(), 'utf8'));
  assert.equal('source' in onDisk.templates[0], false);
  assert.equal(fs.readFileSync(repoFile, 'utf8'), before);   // repo untouched
});

test('history: list is newest-first and bounded; detail validates the id', () => {
  freshConfig();
  for (const [id, ended] of [['o-r-pr1-100', '2026-01-01T00:00:00Z'], ['o-r-pr2-200', '2026-03-01T00:00:00Z'], ['o-r-pr3-300', '2026-02-01T00:00:00Z']]) {
    store.writeHistory({ version: 1, id, repo: 'o/r', pr: Number(id.match(/pr(\d+)/)[1]), status: 'submitted', endedAt: ended, counts: { posted: 1 } });
  }
  const all = store.listHistory(10);
  assert.deepEqual(all.map((h) => h.id), ['o-r-pr2-200', 'o-r-pr3-300', 'o-r-pr1-100']);
  assert.equal(store.listHistory(2).length, 2);
  assert.deepEqual(store.historyIds().sort(), ['o-r-pr1-100', 'o-r-pr2-200', 'o-r-pr3-300']);

  assert.equal(store.readHistory('o-r-pr2-200').pr, 2);
  assert.equal(store.readHistory('../etc/passwd'), null);     // traversal rejected
  assert.equal(store.readHistory('nope'), null);
});

test('history: corrupt file is skipped, not fatal', () => {
  const dir = freshConfig();
  fs.mkdirSync(store.historyDir(), { recursive: true });
  fs.writeFileSync(path.join(store.historyDir(), 'broken.json'), '{not json');
  store.writeHistory({ version: 1, id: 'ok-1', repo: 'o/r', pr: 1, status: 'submitted', endedAt: '2026-01-01T00:00:00Z', counts: {} });
  const list = store.listHistory();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'ok-1');
});

test('history: prune deletes oldest beyond max', () => {
  freshConfig();
  const ids = ['a', 'b', 'c', 'd', 'e'];
  ids.forEach((id, i) => {
    store.writeHistory({ version: 1, id, repo: 'o/r', pr: i, status: 'submitted', endedAt: '2026-01-0' + (i + 1) + 'T00:00:00Z', counts: {} });
    // stagger mtimes so prune ordering is deterministic
    const f = store.historyPath(id);
    const t = new Date(Date.UTC(2026, 0, i + 1)).getTime() / 1000;
    fs.utimesSync(f, t, t);
  });
  store.pruneHistory(2);
  const remaining = store.historyIds().sort();
  assert.deepEqual(remaining, ['d', 'e']);   // two newest by mtime survive
});
