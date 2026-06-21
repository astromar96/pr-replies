'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  sessionPaths, writeAtomic, readJson, appendEvent, readEvents, isPidAlive,
} = require('../server/lib/session');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prr-test-'));
}

// ---------- sessionPaths ----------
test('sessionPaths: well-known files live in the session dir', () => {
  const p = sessionPaths('/d');
  assert.equal(p.dir, '/d');
  assert.equal(p.sessionFile, path.join('/d', 'session.json'));
  assert.equal(p.triagePayload, path.join('/d', 'triage.payload.json'));
  assert.equal(p.triageResult, path.join('/d', 'triage.result.json'));
  assert.equal(p.replyPayload, path.join('/d', 'reply.payload.json'));
  assert.equal(p.replyResult, path.join('/d', 'reply.result.json'));
  assert.equal(p.eventsLog, path.join('/d', 'events.jsonl'));
});

// ---------- writeAtomic / readJson ----------
test('writeAtomic: content round-trips and leaves no .tmp file behind', () => {
  const file = path.join(tmpDir(), 'out.json');
  const obj = { a: 1, nested: { b: ['x', 'y'], n: null } };
  writeAtomic(file, obj);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), obj);
  assert.equal(fs.existsSync(`${file}.tmp`), false);

  writeAtomic(file, { a: 2 }); // overwrite path
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('writeAtomic + appendEvent write owner-only (0600) files', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir();
  const file = path.join(dir, 'secret.json');
  writeAtomic(file, { token: 'abc' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  appendEvent(dir, { seq: 1, type: 'note', text: 'hi' });
  assert.equal(fs.statSync(sessionPaths(dir).eventsLog).mode & 0o777, 0o600);
});

test('readJson: parses valid JSON, returns null on missing or invalid file', () => {
  const file = path.join(tmpDir(), 'x.json');
  assert.equal(readJson(file), null);
  fs.writeFileSync(file, '{"ok":true}');
  assert.deepEqual(readJson(file), { ok: true });
  fs.writeFileSync(file, '{torn');
  assert.equal(readJson(file), null);
});

// ---------- appendEvent / readEvents ----------
test('appendEvent/readEvents: afterSeq filtering and monotonic order', () => {
  const dir = tmpDir();
  appendEvent(dir, { seq: 1, type: 'phase', phase: 'triage' });
  appendEvent(dir, { seq: 2, type: 'note', text: 'a' });
  appendEvent(dir, { seq: 3, type: 'fix_done', item: 'k' });

  const all = readEvents(dir, 0);
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(all.map((e) => e.type), ['phase', 'note', 'fix_done']);
  assert.deepEqual(all[1], { seq: 2, type: 'note', text: 'a' });

  assert.deepEqual(readEvents(dir, 2).map((e) => e.seq), [3]);
  assert.deepEqual(readEvents(dir, 3), []);
  assert.equal(readEvents(dir).length, 3); // afterSeq defaults to 0
});

test('readEvents: torn final line from a crashed writer is ignored', () => {
  const dir = tmpDir();
  appendEvent(dir, { seq: 1, type: 'note' });
  appendEvent(dir, { seq: 2, type: 'note' });
  // Simulate a crash mid-append: garbage with no trailing newline.
  fs.appendFileSync(sessionPaths(dir).eventsLog, '{"seq":3,"type":"no');
  assert.deepEqual(readEvents(dir, 0).map((e) => e.seq), [1, 2]);
});

test('readEvents: missing log file → empty array', () => {
  assert.deepEqual(readEvents(tmpDir(), 0), []);
});

// ---------- isPidAlive ----------
test('isPidAlive: own pid is alive', () => {
  assert.equal(isPidAlive(process.pid), true);
});

test('isPidAlive: absurd and junk pids are dead', () => {
  assert.equal(isPidAlive(999999999), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(null), false);
  assert.equal(isPidAlive(1.5), false);
});
