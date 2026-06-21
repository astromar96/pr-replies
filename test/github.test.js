'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGithub, isRetryable } = require('../server/lib/github');

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
  const sleep = (ms) => { delays.push(ms); return Promise.resolve(); };
  return { sleep, delays };
}

const REPLY_REQ = { repo: 'owner/name', pr: 7, threadId: 'T1', replyToDatabaseId: 99, body: 'hi there' };

test('postReviewReply: GraphQL success returns url with one exec call', async () => {
  const { exec, calls } = fakeExec([
    { out: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { url: 'https://github.com/x/1' } } } }) },
  ]);
  const { sleep, delays } = fakeSleep();
  const gh = createGithub({ exec, sleep });

  const res = await gh.postReviewReply(REPLY_REQ);

  assert.deepEqual(res, { ok: true, url: 'https://github.com/x/1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'api');
  assert.equal(calls[0][1], 'graphql');
  assert.ok(calls[0].some((a) => a.startsWith('query=') && a.includes('addPullRequestReviewThreadReply')));
  assert.ok(calls[0].includes('threadId=T1'));
  assert.ok(calls[0].includes('body=hi there'));
  assert.deepEqual(delays, []);
});

test('postReviewReply: REST fallback succeeds after GraphQL failure', async () => {
  const { exec, calls } = fakeExec([
    { err: 'HTTP 404: not found' },
    { out: JSON.stringify({ html_url: 'https://github.com/x/rest' }) },
  ]);
  const gh = createGithub({ exec, sleep: fakeSleep().sleep });

  const res = await gh.postReviewReply(REPLY_REQ);

  assert.deepEqual(res, { ok: true, url: 'https://github.com/x/rest' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [
    'api', '-X', 'POST',
    'repos/owner/name/pulls/7/comments/99/replies',
    '-f', 'body=hi there',
  ]);
});

test('postReviewReply: HTTP 422 on both paths fails after exactly one attempt', async () => {
  const { exec, calls } = fakeExec([
    { err: 'HTTP 422: Validation Failed' },
    { err: 'HTTP 422: Unprocessable' },
  ]);
  const { sleep, delays } = fakeSleep();
  const onAttempts = [];
  const gh = createGithub({ exec, sleep });

  const res = await gh.postReviewReply(REPLY_REQ, (n, msg) => onAttempts.push([n, msg]));

  assert.deepEqual(res, { ok: false, error: 'HTTP 422: Validation Failed | REST fallback: HTTP 422: Unprocessable' });
  assert.equal(calls.length, 2); // one attempt = GraphQL + REST fallback
  assert.deepEqual(delays, []);
  assert.deepEqual(onAttempts, []);
});

test('postReviewReply: GraphQL 200 with errors body falls back to REST (no false success)', async () => {
  const { exec, calls } = fakeExec([
    { out: JSON.stringify({ data: null, errors: [{ message: 'Could not resolve to a node' }] }) },
    { out: JSON.stringify({ html_url: 'https://github.com/x/rest' }) },
  ]);
  const gh = createGithub({ exec, sleep: fakeSleep().sleep });

  const res = await gh.postReviewReply(REPLY_REQ);

  // The errored GraphQL body must NOT be read as success; REST fallback wins.
  assert.deepEqual(res, { ok: true, url: 'https://github.com/x/rest' });
  assert.equal(calls.length, 2);
});

test('postReviewReply: GraphQL body missing comment url is not a success', async () => {
  const { exec } = fakeExec([
    { out: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: {} } } }) },
    { err: 'HTTP 422: Unprocessable' },
  ]);
  const gh = createGithub({ exec, sleep: fakeSleep().sleep });

  const res = await gh.postReviewReply(REPLY_REQ);
  assert.equal(res.ok, false);
  assert.match(res.error, /missing comment url \| REST fallback/);
});

test('postIssueComment: 200 body missing html_url reports failure, not ok', async () => {
  const { exec } = fakeExec([
    { out: JSON.stringify({ message: 'Validation Failed', errors: [{ field: 'body' }] }) },
  ]);
  const gh = createGithub({ exec, sleep: fakeSleep().sleep });

  const res = await gh.postIssueComment({ repo: 'owner/name', pr: 7, body: 'hi' });
  assert.equal(res.ok, false);
  assert.match(res.error, /issue comment/);
});

test('resolveThread: 200 body with errors is a failure, not a false success', async () => {
  const { exec } = fakeExec([
    { out: JSON.stringify({ data: null, errors: [{ message: 'Resolve not permitted' }] }) },
  ]);
  const gh = createGithub({ exec, sleep: fakeSleep().sleep });

  const res = await gh.resolveThread({ threadId: 'T9' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Resolve not permitted/);
});

test('resolveThread: thread.isResolved false is a failure', async () => {
  const { exec } = fakeExec([
    { out: JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: false } } } }) },
  ]);
  const gh = createGithub({ exec, sleep: fakeSleep().sleep });

  const res = await gh.resolveThread({ threadId: 'T9' });
  assert.equal(res.ok, false);
  assert.match(res.error, /not resolved/);
});

test('postIssueComment: retries on HTTP 429 with backoff then succeeds', async () => {
  const { exec, calls } = fakeExec([
    { err: 'HTTP 429: too many requests' },
    { err: 'HTTP 429: too many requests' },
    { out: JSON.stringify({ html_url: 'https://github.com/x/comment' }) },
  ]);
  const { sleep, delays } = fakeSleep();
  const onAttempts = [];
  const gh = createGithub({ exec, sleep });

  const res = await gh.postIssueComment({ repo: 'owner/name', pr: 7, body: 'hi' }, (n, msg) => onAttempts.push([n, msg]));

  assert.deepEqual(res, { ok: true, url: 'https://github.com/x/comment' });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ['api', '-X', 'POST', 'repos/owner/name/issues/7/comments', '-f', 'body=hi']);
  assert.equal(delays.length, 2);
  assert.ok(delays[0] >= 1000 && delays[0] <= 1250, `delay 1 was ${delays[0]}`);
  assert.ok(delays[1] >= 2000 && delays[1] <= 2250, `delay 2 was ${delays[1]}`);
  assert.deepEqual(onAttempts, [
    [2, 'HTTP 429: too many requests'],
    [3, 'HTTP 429: too many requests'],
  ]);
});

test('postIssueComment: a secondary rate limit backs off at least 30s (primary 429 stays fast)', async () => {
  const { exec, calls } = fakeExec([
    { err: 'You have exceeded a secondary rate limit and have been temporarily blocked from content creation' },
    { out: JSON.stringify({ html_url: 'https://github.com/x/comment' }) },
  ]);
  const { sleep, delays } = fakeSleep();
  const gh = createGithub({ exec, sleep });

  const res = await gh.postIssueComment({ repo: 'owner/name', pr: 7, body: 'hi' });

  assert.deepEqual(res, { ok: true, url: 'https://github.com/x/comment' });
  assert.equal(calls.length, 2);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 30000, `secondary-limit delay was ${delays[0]}, expected >= 30000`);
});

test('postIssueComment: gives up after 4 attempts on HTTP 503', async () => {
  let calls = 0;
  const exec = () => { calls++; return Promise.reject(new Error('HTTP 503: unavailable')); };
  const { sleep, delays } = fakeSleep();
  const gh = createGithub({ exec, sleep });

  const res = await gh.postIssueComment({ repo: 'owner/name', pr: 7, body: 'hi' });

  assert.deepEqual(res, { ok: false, error: 'HTTP 503: unavailable' });
  assert.equal(calls, 4);
  assert.equal(delays.length, 3);
});

test('resolveThread: success', async () => {
  const { exec, calls } = fakeExec([
    { out: JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }) },
  ]);
  const gh = createGithub({ exec, sleep: fakeSleep().sleep });

  const res = await gh.resolveThread({ threadId: 'T9' });

  assert.deepEqual(res, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'api');
  assert.equal(calls[0][1], 'graphql');
  assert.ok(calls[0].some((a) => a.startsWith('query=') && a.includes('resolveReviewThread')));
  assert.ok(calls[0].includes('threadId=T9'));
});

test('resolveThread: failure surfaces error', async () => {
  const { exec } = fakeExec([{ err: 'HTTP 403: forbidden' }]);
  const gh = createGithub({ exec, sleep: fakeSleep().sleep });

  const res = await gh.resolveThread({ threadId: 'T9' });

  assert.deepEqual(res, { ok: false, error: 'HTTP 403: forbidden' });
});

test('noPost: all methods dry-run without calling exec', async () => {
  let calls = 0;
  const exec = () => { calls++; return Promise.resolve('{}'); };
  const gh = createGithub({ exec, sleep: fakeSleep().sleep, noPost: true });

  assert.deepEqual(await gh.postReviewReply(REPLY_REQ), { ok: true, url: '(dry-run)' });
  assert.deepEqual(await gh.postIssueComment({ repo: 'owner/name', pr: 7, body: 'hi' }), { ok: true, url: '(dry-run)' });
  assert.deepEqual(await gh.resolveThread({ threadId: 'T1' }), { ok: true });
  assert.equal(calls, 0);
});

test('isRetryable: classifies error messages', () => {
  assert.equal(isRetryable('HTTP 429: too many requests'), true);
  assert.equal(isRetryable('HTTP 503: service unavailable'), true);
  assert.equal(isRetryable('HTTP 422: Validation Failed'), false);
  assert.equal(isRetryable('HTTP 404: not found'), false);
  assert.equal(isRetryable('read ECONNRESET'), true);
  assert.equal(isRetryable('You have exceeded a secondary rate limit'), true);
});
