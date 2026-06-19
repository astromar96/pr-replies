'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitlabProvider, encProject, noteUrl } = require('../server/lib/providers/gitlab');

// Fake exec consuming scripted results in order: { out } resolves, { err } rejects.
function fakeExec(results) {
  const calls = [];
  const exec = (argv) => {
    calls.push(argv);
    const r = results.shift();
    if (!r) return Promise.reject(new Error('unexpected exec call'));
    return r.err ? Promise.reject(new Error(r.err)) : Promise.resolve(r.out);
  };
  return { exec, calls };
}

function fakeSleep() {
  const delays = [];
  return { sleep: (ms) => { delays.push(ms); return Promise.resolve(); }, delays };
}

const REPLY_REQ = { repo: 'group/proj', pr: 7, threadId: 'disc123', replyToDatabaseId: 99, body: 'hi there' };

test('encProject: URL-encodes nested group paths', () => {
  assert.equal(encProject('group/proj'), 'group%2Fproj');
  assert.equal(encProject('group/sub/proj'), 'group%2Fsub%2Fproj');
});

test('noteUrl: builds the canonical MR note anchor from host/path/iid/id', () => {
  assert.equal(noteUrl('gitlab.com', 'group/proj', 7, 55), 'https://gitlab.com/group/proj/-/merge_requests/7#note_55');
  assert.equal(noteUrl('gl.acme.dev', 'g/p', 3, null), 'https://gl.acme.dev/g/p/-/merge_requests/3');
});

test('postReviewReply: POSTs to the discussion notes endpoint and builds the note url', async () => {
  const { exec, calls } = fakeExec([{ out: JSON.stringify({ id: 555 }) }]);
  const gl = createGitlabProvider({ exec, sleep: fakeSleep().sleep, host: 'gitlab.com' });

  const res = await gl.postReviewReply(REPLY_REQ);

  assert.deepEqual(res, { ok: true, url: 'https://gitlab.com/group/proj/-/merge_requests/7#note_555' });
  assert.deepEqual(calls[0], [
    'api', '-X', 'POST',
    'projects/group%2Fproj/merge_requests/7/discussions/disc123/notes',
    '-f', 'body=hi there',
  ]);
});

test('postReviewReply: a self-managed host is reflected in the note url', async () => {
  const { exec } = fakeExec([{ out: JSON.stringify({ id: 9 }) }]);
  const gl = createGitlabProvider({ exec, sleep: fakeSleep().sleep, host: 'gl.acme.dev' });
  const res = await gl.postReviewReply(REPLY_REQ);
  assert.equal(res.url, 'https://gl.acme.dev/group/proj/-/merge_requests/7#note_9');
});

test('postReviewReply: a response missing the note id is a failure', async () => {
  const { exec } = fakeExec([{ out: JSON.stringify({ message: '404 Not found' }) }]);
  const gl = createGitlabProvider({ exec, sleep: fakeSleep().sleep });
  const res = await gl.postReviewReply(REPLY_REQ);
  assert.equal(res.ok, false);
  assert.match(res.error, /missing note id/);
});

test('postIssueComment: POSTs a top-level MR note', async () => {
  const { exec, calls } = fakeExec([{ out: JSON.stringify({ id: 42 }) }]);
  const gl = createGitlabProvider({ exec, sleep: fakeSleep().sleep });
  const res = await gl.postIssueComment({ repo: 'group/proj', pr: 7, body: 'hello' });
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], [
    'api', '-X', 'POST',
    'projects/group%2Fproj/merge_requests/7/notes',
    '-f', 'body=hello',
  ]);
});

test('resolveThread: PUTs resolved=true and verifies a note came back resolved', async () => {
  const { exec, calls } = fakeExec([{ out: JSON.stringify({ id: 'disc123', notes: [{ id: 1, resolved: true }] }) }]);
  const gl = createGitlabProvider({ exec, sleep: fakeSleep().sleep });
  const res = await gl.resolveThread({ repo: 'group/proj', pr: 7, threadId: 'disc123' });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls[0], [
    'api', '-X', 'PUT',
    'projects/group%2Fproj/merge_requests/7/discussions/disc123?resolved=true',
  ]);
});

test('resolveThread: an unresolved response is a failure', async () => {
  const { exec } = fakeExec([{ out: JSON.stringify({ notes: [{ resolved: false }] }) }]);
  const gl = createGitlabProvider({ exec, sleep: fakeSleep().sleep });
  const res = await gl.resolveThread({ repo: 'group/proj', pr: 7, threadId: 'disc123' });
  assert.equal(res.ok, false);
  assert.match(res.error, /not resolved/);
});

test('retries on HTTP 429 with backoff then succeeds', async () => {
  const { exec, calls } = fakeExec([
    { err: 'HTTP 429: too many requests' },
    { out: JSON.stringify({ id: 7 }) },
  ]);
  const { sleep, delays } = fakeSleep();
  const onAttempts = [];
  const gl = createGitlabProvider({ exec, sleep });
  const res = await gl.postIssueComment({ repo: 'g/p', pr: 1, body: 'x' }, (n, msg) => onAttempts.push([n, msg]));
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(delays.length, 1);
  assert.deepEqual(onAttempts, [[2, 'HTTP 429: too many requests']]);
});

test('noPost: all write methods dry-run without calling exec', async () => {
  let calls = 0;
  const exec = () => { calls++; return Promise.resolve('{}'); };
  const gl = createGitlabProvider({ exec, sleep: fakeSleep().sleep, noPost: true });
  assert.deepEqual(await gl.postReviewReply(REPLY_REQ), { ok: true, url: '(dry-run)' });
  assert.deepEqual(await gl.postIssueComment({ repo: 'g/p', pr: 1, body: 'x' }), { ok: true, url: '(dry-run)' });
  assert.deepEqual(await gl.resolveThread({ repo: 'g/p', pr: 1, threadId: 'd' }), { ok: true });
  assert.equal(calls, 0);
});
