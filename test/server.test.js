'use strict';

// End-to-end coverage for the server.js CLI boot guards and the offline `emit`
// path — the crash/restart edges users actually hit. These spawn the real CLI
// but never start a long-lived listener (each guard exits before `listen`), so
// there is no browser, no port, and nothing to clean up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { sessionPaths, writeAtomic, readEvents, appendEvent } = require('../server/lib/session');

const SERVER = path.join(__dirname, '..', 'server', 'server.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'prr-serve-')); }

// Always point config at a throwaway dir so the suite never reads/writes the
// developer's real ~/.config/pr-replies.
function run(args, env) {
  return new Promise((resolve) => {
    execFile('node', [SERVER, ...args],
      { env: Object.assign({}, process.env, { PR_REPLIES_CONFIG_DIR: tmpDir() }, env || {}) },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

function writeSession(dir, pid, extra) {
  writeAtomic(sessionPaths(dir).sessionFile, Object.assign({
    version: 2, pid, port: 1, token: 't', url: 'http://127.0.0.1:1/t/',
    phase: 'triage', repo: 'o/r', pr: 42,
  }, extra || {}));
}

test('serve: a second serve on a live session dir refuses to start', async () => {
  const dir = tmpDir();
  writeSession(dir, process.pid); // the test runner is alive → looks like a running session
  const r = await run(['serve', '--session', dir, '--no-open']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already running/);
});

test('serve: a used dir without --resume refuses to start', async () => {
  const dir = tmpDir();
  writeAtomic(sessionPaths(dir).triageResult, { status: 'submitted', decisions: [], at: 'now' });
  const r = await run(['serve', '--session', dir, '--no-open']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already used/);
});

test('emit: against a down server saves the event with the next seq', async () => {
  const dir = tmpDir();
  writeSession(dir, 999999999);        // dead pid; port 1 is closed → unreachable
  appendEvent(dir, { seq: 5, at: 'now', type: 'note', text: 'earlier' });

  const r = await run(['emit', '--session', dir, '--type', 'note', '--text', 'offline']);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /server unreachable/);
  const events = readEvents(dir, 0);
  assert.equal(events.length, 2);
  assert.equal(events[1].seq, 6);      // monotonic continuation
  assert.equal(events[1].text, 'offline');
});
