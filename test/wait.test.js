'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { sessionPaths, writeAtomic } = require('../server/lib/session');

const SERVER = path.join(__dirname, '..', 'server', 'server.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prr-wait-'));
}

function sessionFile(dir, pid) {
  writeAtomic(sessionPaths(dir).sessionFile, {
    version: 2, pid, port: 1, token: 't',
    url: 'http://127.0.0.1:1/t/', phase: 'triage', repo: 'o/r', pr: 42,
  });
}

function runWait(dir, phase, timeoutSecs) {
  return new Promise((resolve) => {
    execFile('node', [SERVER, 'wait', '--session', dir, '--phase', phase, '--timeout-secs', String(timeoutSecs)],
      (err, stdout, stderr) => {
        resolve({ code: err ? err.code : 0, stdout, stderr });
      });
  });
}

function parseSentinel(stdout) {
  const m = stdout.match(/===PR_REPLIES_RESULT===\n([\s\S]*?)\n===END_PR_REPLIES_RESULT===/);
  return m ? JSON.parse(m[1]) : null;
}

test('result already present → immediate exit 0', async () => {
  const dir = tmpDir();
  sessionFile(dir, process.pid);
  writeAtomic(sessionPaths(dir).triageResult, { status: 'submitted', decisions: [], at: 'now' });
  const r = await runWait(dir, 'triage', 5);
  assert.equal(r.code, 0);
  const res = parseSentinel(r.stdout);
  assert.equal(res.status, 'submitted');
  assert.equal(res.phase, 'triage');
  assert.equal(res.repo, 'o/r');
});

test('result appears mid-wait → exit 0 with submitted', async () => {
  const dir = tmpDir();
  sessionFile(dir, process.pid);
  setTimeout(() => {
    writeAtomic(sessionPaths(dir).triageResult, { status: 'submitted', decisions: [{ action: 'fix' }], at: 'now' });
  }, 600);
  const r = await runWait(dir, 'triage', 5);
  assert.equal(r.code, 0);
  assert.equal(parseSentinel(r.stdout).status, 'submitted');
});

test('alive server, no result → exit 2 wait_timeout', async () => {
  const dir = tmpDir();
  sessionFile(dir, process.pid); // this test process is alive
  const r = await runWait(dir, 'triage', 2);
  assert.equal(r.code, 2);
  assert.equal(parseSentinel(r.stdout).status, 'wait_timeout');
});

test('dead server pid → exit 3 server_exited', async () => {
  const dir = tmpDir();
  sessionFile(dir, 999999999);
  const r = await runWait(dir, 'reply', 5);
  assert.equal(r.code, 3);
  const res = parseSentinel(r.stdout);
  assert.equal(res.status, 'server_exited');
  assert.equal(res.phase, 'reply');
});
