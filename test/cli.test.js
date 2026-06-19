'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const store = require('../server/lib/store');

const SERVER = path.join(__dirname, '..', 'server', 'server.js');

function run(args, env) {
  return new Promise((resolve) => {
    execFile('node', [SERVER, ...args], { env: Object.assign({}, process.env, env || {}) },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

function freshConfig() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-cli-'));
  process.env.PR_REPLIES_CONFIG_DIR = d;
  store.writeHistory({
    version: 1, id: 'o-r-pr1-1', repo: 'o/r', pr: 1, provider: 'gitlab',
    status: 'submitted', startedAt: '2026-03-01T10:00:00Z', endedAt: '2026-03-01T10:30:00Z',
    counts: { fix: 2, reply: 1, skip: 0, posted: 3, failed: 0, resolved: 1 },
    decisions: [{ kind: 'review', action: 'fix', category: 'tests' }],
  });
  return d;
}

test('suggest: runs without --session and prints priors JSON', async () => {
  const cfg = freshConfig();
  const r = await run(['suggest', '--repo', 'o/r', '--provider', 'gitlab'], { PR_REPLIES_CONFIG_DIR: cfg });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.repo, 'o/r');
  assert.equal(out.sessions, 1);
  assert.equal(out.actionPriors.fix, 1);
  assert.equal(out.categoryPriors[0].category, 'tests');
});

test('an unknown subcommand exits non-zero with usage', async () => {
  const r = await run(['frobnicate']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /usage: server\.js/);
});
