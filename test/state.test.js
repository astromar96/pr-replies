'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createState, httpError } = require('../server/lib/state');
const { sessionPaths, readJson, readEvents } = require('../server/lib/session');

// ---------- fixtures ----------
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prr-test-'));
}

function triagePayload() {
  return {
    version: 2,
    repo: { owner: 'o', name: 'r', nameWithOwner: 'o/r' },
    pr: { number: 42, title: 'T', url: 'https://x', author: 'a' },
    generatedAt: '2026-01-01T00:00:00Z',
    reviewThreads: [{
      id: 'PRRT_1', isOutdated: false, viewerCanResolve: true, path: 'src/a.js',
      startLine: null, line: 5, replyToDatabaseId: 111, diffHunk: '@@ -1 +1 @@',
      comments: [{ author: 'rev', createdAt: '2026-01-01T00:00:00Z', body: 'hm' }],
      suggestedAction: 'fix', confidence: 'high', fixPlan: 'do it', proposedDiff: null,
    }],
    issueComments: [{
      databaseId: 222, author: 'rev2', createdAt: '2026-01-01T00:00:00Z', url: 'https://x',
      body: 'general', suggestedAction: 'reply', confidence: 'low', fixPlan: null, proposedDiff: null,
    }],
  };
}

function replyPayload() {
  const p = triagePayload();
  for (const t of p.reviewThreads) {
    delete t.suggestedAction; delete t.confidence; delete t.fixPlan; delete t.proposedDiff;
    t.draft = 'thanks, fixed'; t.fixedIn = 'abc1234'; t.resolveDefault = true;
  }
  for (const c of p.issueComments) {
    delete c.suggestedAction; delete c.confidence; delete c.fixPlan; delete c.proposedDiff;
    c.draft = 'done'; c.fixedIn = null;
  }
  return p;
}

function writeTriage(dir, payload = triagePayload()) {
  fs.writeFileSync(path.join(dir, 'triage.payload.json'), JSON.stringify(payload));
}

function writeReply(dir, payload = replyPayload()) {
  fs.writeFileSync(path.join(dir, 'reply.payload.json'), JSON.stringify(payload));
}

// Fake github: per-method result factories; every call is recorded.
function makeGithub({ review, issue, resolve } = {}) {
  const calls = { review: [], issue: [], resolve: [] };
  return {
    calls,
    async postReviewReply(req) { calls.review.push(req); return review ? review(req) : { ok: true, url: 'u' }; },
    async postIssueComment(req) { calls.issue.push(req); return issue ? issue(req) : { ok: true, url: 'u' }; },
    async resolveThread(req) { calls.resolve.push(req); return resolve ? resolve(req) : { ok: true }; },
  };
}

function makeState(dir, { github = makeGithub(), config = {}, history = null } = {}) {
  return createState({
    sessionDir: dir,
    flags: { noPost: true, repoDir: null },
    config,
    github,
    git: { getFixCommit: async () => null },
    history,
    log() {},
  });
}

function spyHistory() {
  const records = [];
  return { records, record(r) { records.push(r); return r; } };
}

const REVIEW_REPLY = {
  key: 'review:PRRT_1', kind: 'review', threadId: 'PRRT_1', replyToDatabaseId: 111,
  path: 'src/a.js', line: 5, body: 'fixed, thanks', resolve: true, variant: 'humanized',
};
const ISSUE_REPLY = { key: 'issue:222', kind: 'issue', body: 'done' };

// ---------- httpError ----------
test('httpError: attaches statusCode and optional errors array', () => {
  const e = httpError(418, 'msg', ['a']);
  assert.ok(e instanceof Error);
  assert.equal(e.statusCode, 418);
  assert.deepEqual(e.errors, ['a']);
  assert.equal(httpError(500, 'm').errors, undefined);
});

// ---------- init ----------
test('init: loads triage payload and enters triage phase', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  const state = makeState(dir);
  await state.init({ startPhase: 'triage' });
  assert.equal(state.phase, 'triage');
  const snap = state.snapshot();
  assert.equal(snap.triage.payload.pr.number, 42);
  assert.equal(snap.repo.nameWithOwner, 'o/r');
  assert.equal(snap.lastSeq, 0);
});

test('init: invalid triage payload throws 400 with errors array', () => {
  const dir = tmpDir();
  writeTriage(dir, { version: 1 });
  const state = makeState(dir);
  assert.throws(
    () => state.init({ startPhase: 'triage' }),
    (e) => e.statusCode === 400 && Array.isArray(e.errors) && e.errors.length > 0,
  );
});

test('init: missing triage payload file throws 400 with errors array', () => {
  const state = makeState(tmpDir());
  assert.throws(
    () => state.init({ startPhase: 'triage' }),
    (e) => e.statusCode === 400 && Array.isArray(e.errors),
  );
});

// ---------- submitTriage ----------
test('submitTriage: writes result, moves to fixing, rejects a second submit with 409', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  const state = makeState(dir);
  await state.init({ startPhase: 'triage' });

  const decisions = [{ key: 'review:PRRT_1', action: 'fix' }, { key: 'issue:222', action: 'reply' }];
  state.submitTriage(decisions);

  const result = readJson(sessionPaths(dir).triageResult);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(result.decisions, decisions);
  assert.equal(state.phase, 'fixing');

  assert.throws(() => state.submitTriage([]), (e) => e.statusCode === 409);
});

test('submitTriage: non-array decisions → 400', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  const state = makeState(dir);
  await state.init({ startPhase: 'triage' });
  assert.throws(() => state.submitTriage(undefined), (e) => e.statusCode === 400);
  assert.equal(state.phase, 'triage');
});

// ---------- cancel ----------
test('cancel(triage): result cancelled, phase cancelled, onTerminal(cancelled)', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  const state = makeState(dir);
  const reasons = [];
  state.onTerminal((r) => reasons.push(r));
  await state.init({ startPhase: 'triage' });

  state.cancel('triage');

  assert.equal(readJson(sessionPaths(dir).triageResult).status, 'cancelled');
  assert.equal(state.phase, 'cancelled');
  assert.deepEqual(reasons, ['cancelled']);
});

// ---------- requestAbort / controlEvent ----------
test('requestAbort: only valid in fixing; controlEvent reflects the abort flag', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  const state = makeState(dir);
  await state.init({ startPhase: 'triage' });

  assert.throws(() => state.requestAbort(), (e) => e.statusCode === 409);

  state.submitTriage([]);
  assert.deepEqual(state.controlEvent({ type: 'fix_done', item: 'k', sha: 'abc' }), { ok: true, abort: false });

  state.requestAbort();
  assert.equal(state.abortRequested, true);
  assert.deepEqual(state.controlEvent({ type: 'fix_done', item: 'k2' }), { ok: true, abort: true });

  const ev = state.eventsSince(0).find((e) => e.type === 'fix_done');
  assert.equal(ev.item, 'k');
  assert.equal(ev.sha, 'abc');
});

test('controlEvent: bad type → 400', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  const state = makeState(dir);
  await state.init({ startPhase: 'triage' });
  assert.throws(() => state.controlEvent({ type: 'nope' }), (e) => e.statusCode === 400);
  assert.throws(() => state.controlEvent(null), (e) => e.statusCode === 400);
});

test('controlEvent: terminal phase → 409', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  const state = makeState(dir);
  await state.init({ startPhase: 'triage' });
  state.cancel('triage');
  assert.throws(() => state.controlEvent({ type: 'note', text: 'x' }), (e) => e.statusCode === 409);
});

// ---------- advanceToReply ----------
test('advanceToReply: loads reply payload and enters reply phase', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  writeReply(dir);
  const state = makeState(dir);
  await state.init({ startPhase: 'triage' });
  state.submitTriage([]);

  await state.advanceToReply();

  assert.equal(state.phase, 'reply');
  const snap = state.snapshot();
  assert.equal(snap.reply.payload.reviewThreads[0].draft, 'thanks, fixed');
  assert.deepEqual(snap.reply.itemStatus, {});
});

test('advanceToReply: 409 from triage phase', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  writeReply(dir);
  const state = makeState(dir);
  await state.init({ startPhase: 'triage' });
  await assert.rejects(state.advanceToReply(), (e) => e.statusCode === 409);
  assert.equal(state.phase, 'triage');
});

test('advanceToReply: invalid reply payload → 400 with errors, phase unchanged', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  writeReply(dir, { version: 1 });
  const state = makeState(dir);
  await state.init({ startPhase: 'triage' });
  state.submitTriage([]);
  await assert.rejects(
    state.advanceToReply(),
    (e) => e.statusCode === 400 && Array.isArray(e.errors) && e.errors.length > 0,
  );
  assert.equal(state.phase, 'fixing');
});

// ---------- submitReplies ----------
test('submitReplies: happy path posts, resolves, finalizes to done', async () => {
  const dir = tmpDir();
  writeReply(dir);
  const gh = makeGithub();
  const state = makeState(dir, { github: gh });
  const reasons = [];
  state.onTerminal((r) => reasons.push(r));
  await state.init({ startPhase: 'reply' });

  await state.submitReplies({ replies: [REVIEW_REPLY, ISSUE_REPLY] });

  // github received both posts and the resolve, with repo/pr from the payload
  assert.equal(gh.calls.review.length, 1);
  assert.equal(gh.calls.review[0].repo, 'o/r');
  assert.equal(gh.calls.review[0].pr, 42);
  assert.equal(gh.calls.review[0].threadId, 'PRRT_1');
  assert.equal(gh.calls.review[0].replyToDatabaseId, 111);
  assert.equal(gh.calls.issue.length, 1);
  assert.deepEqual(gh.calls.resolve, [{ repo: 'o/r', pr: 42, threadId: 'PRRT_1', replyToDatabaseId: 111 }]);

  // events: posting → posted per key, resolve, post_done with failed 0
  const events = state.eventsSince(0);
  const itemEv = events.filter((e) => e.type === 'post_item');
  assert.deepEqual(itemEv.filter((e) => e.key === 'review:PRRT_1').map((e) => e.status), ['posting', 'posted']);
  assert.deepEqual(itemEv.filter((e) => e.key === 'issue:222').map((e) => e.status), ['posting', 'posted']);
  const resolveEv = events.filter((e) => e.type === 'resolve_item');
  assert.equal(resolveEv.length, 1);
  assert.equal(resolveEv[0].status, 'resolved');
  assert.equal(resolveEv[0].key, 'review:PRRT_1');
  const done = events.find((e) => e.type === 'post_done');
  assert.equal(done.posted, 2);
  assert.equal(done.failed, 0);

  // cumulative result file + terminal transition
  const result = readJson(sessionPaths(dir).replyResult);
  assert.equal(result.status, 'submitted');
  assert.equal(result.posted.length, 2);
  // the chosen draft variant is recorded on the posted entry (for history)
  assert.equal(result.posted.find((p) => p.key === 'review:PRRT_1').variant, 'humanized');
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].key, 'review:PRRT_1');
  assert.deepEqual(result.errors, []);
  assert.equal(state.phase, 'done');
  assert.deepEqual(reasons, ['done']);
});

test('submitReplies: 409 outside reply phase, 400 without a replies array', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  writeReply(dir);
  const state = makeState(dir);
  await state.init({ startPhase: 'triage' });
  assert.throws(() => state.submitReplies({ replies: [] }), (e) => e.statusCode === 409);

  const dir2 = tmpDir();
  writeReply(dir2);
  const state2 = makeState(dir2);
  await state2.init({ startPhase: 'reply' });
  assert.throws(() => state2.submitReplies({}), (e) => e.statusCode === 400);
});

test('submitReplies: partial failure keeps reply phase; retry finalizes without re-posting', async () => {
  const dir = tmpDir();
  writeReply(dir);
  const reviewResults = [{ ok: false, error: 'boom' }, { ok: true, url: 'u2' }];
  const gh = makeGithub({ review: () => reviewResults.shift() });
  const state = makeState(dir, { github: gh });
  await state.init({ startPhase: 'reply' });
  const review = { ...REVIEW_REPLY, resolve: false };

  await state.submitReplies({ replies: [review, ISSUE_REPLY] });

  assert.equal(state.phase, 'reply');
  assert.equal(fs.existsSync(sessionPaths(dir).replyResult), false);
  const snap = state.snapshot();
  assert.equal(snap.reply.itemStatus['review:PRRT_1'].status, 'failed');
  assert.equal(snap.reply.itemStatus['issue:222'].status, 'posted');
  const done1 = state.eventsSince(0).find((e) => e.type === 'post_done');
  assert.equal(done1.failed, 1);

  // Resubmit everything: the already-posted issue key must not hit github again.
  await state.submitReplies({ replies: [review, ISSUE_REPLY] });

  assert.equal(gh.calls.issue.length, 1, 'posted key was re-posted');
  assert.equal(gh.calls.review.length, 2);
  const result = readJson(sessionPaths(dir).replyResult);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(result.errors, []);
  assert.equal(result.posted.length, 2);
  assert.equal(state.phase, 'done');
});

test('finishReply: after partial failure writes result with remaining errors, phase done', async () => {
  const dir = tmpDir();
  writeReply(dir);
  const gh = makeGithub({ review: () => ({ ok: false, error: 'boom' }) });
  const state = makeState(dir, { github: gh });
  await state.init({ startPhase: 'reply' });

  await state.submitReplies({ replies: [{ ...REVIEW_REPLY, resolve: false }, ISSUE_REPLY] });
  assert.equal(state.phase, 'reply');

  state.finishReply();

  const result = readJson(sessionPaths(dir).replyResult);
  assert.equal(result.status, 'submitted');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].key, 'review:PRRT_1');
  assert.equal(result.posted.length, 1);
  assert.equal(state.phase, 'done');
});

// ---------- stop ----------
test('stop(timeout) during fixing: reply result timeout, phase cancelled, session_end reason timeout', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  const state = makeState(dir);
  const reasons = [];
  state.onTerminal((r) => reasons.push(r));
  await state.init({ startPhase: 'triage' });
  state.submitTriage([]);

  state.stop('timeout');

  assert.equal(readJson(sessionPaths(dir).replyResult).status, 'timeout');
  assert.equal(state.phase, 'cancelled');
  assert.deepEqual(reasons, ['timeout']);
  const events = state.eventsSince(0);
  const last = events[events.length - 1];
  assert.equal(last.type, 'session_end');
  assert.equal(last.reason, 'timeout');
});

// ---------- signature ----------
test('signature: configured signature is appended to outgoing bodies', async () => {
  const dir = tmpDir();
  writeReply(dir);
  const gh = makeGithub();
  const state = makeState(dir, { github: gh, config: { signature: '-- sig' } });
  await state.init({ startPhase: 'reply' });

  await state.submitReplies({ replies: [{ ...REVIEW_REPLY, body: 'fixed ' }, { ...ISSUE_REPLY, body: 'thanks' }] });

  assert.ok(gh.calls.review[0].body.endsWith('\n\n-- sig'), gh.calls.review[0].body);
  assert.ok(gh.calls.review[0].body.startsWith('fixed'));
  assert.ok(gh.calls.issue[0].body.endsWith('\n\n-- sig'), gh.calls.issue[0].body);
});

// ---------- event log ----------
test('event log: every recorded event persists to events.jsonl with monotonic seq', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  writeReply(dir);
  const state = makeState(dir);
  await state.init({ startPhase: 'triage' });
  state.submitTriage([]);
  state.controlEvent({ type: 'fix_done', item: 'k', sha: 'abc' });
  await state.advanceToReply();
  await state.submitReplies({ replies: [REVIEW_REPLY, ISSUE_REPLY] });

  const onDisk = readEvents(dir, 0);
  assert.ok(onDisk.length > 0);
  assert.equal(onDisk.length, state.lastSeq);
  onDisk.forEach((e, i) => assert.equal(e.seq, i + 1));
  const inMemory = state.eventsSince(0);
  assert.deepEqual(onDisk.map((e) => e.seq), inMemory.map((e) => e.seq));
  assert.deepEqual(onDisk.map((e) => e.type), inMemory.map((e) => e.type));
});

// ---------- resume ----------
test('resume: posted keys survive a crash and are never re-posted', async () => {
  const dir = tmpDir();
  writeReply(dir);

  // State A: issue posts fine, review fails — then the process "crashes".
  const ghA = makeGithub({ review: () => ({ ok: false, error: 'boom' }) });
  const a = makeState(dir, { github: ghA });
  await a.init({ startPhase: 'reply' });
  await a.submitReplies({ replies: [{ ...REVIEW_REPLY, resolve: false }, ISSUE_REPLY] });
  assert.equal(a.phase, 'reply');
  assert.equal(ghA.calls.issue.length, 1);

  // State B: fresh process resuming the same session dir.
  const ghB = makeGithub();
  const b = makeState(dir, { github: ghB });
  await b.resume('reply');

  assert.equal(b.phase, 'reply');
  const snap = b.snapshot();
  assert.equal(snap.reply.itemStatus['issue:222'].status, 'posted');
  assert.ok(snap.lastSeq > 0);

  await b.submitReplies({ replies: [{ ...REVIEW_REPLY, resolve: false }, ISSUE_REPLY] });

  assert.equal(ghB.calls.issue.length, 0, 'resumed state re-posted an already-posted key');
  assert.equal(ghB.calls.review.length, 1);
  assert.equal(b.phase, 'done');
  const result = readJson(sessionPaths(dir).replyResult);
  assert.equal(result.status, 'submitted');
  assert.deepEqual(result.errors, []);
  assert.equal(result.posted.length, 2);
});

test('resume: a post interrupted mid-flight is locked and never auto-reposted', async () => {
  const dir = tmpDir();
  writeReply(dir);

  // State A: the review post hangs forever (the process dies mid-attempt), so
  // only the 'posting' event reaches disk — no terminal posted/failed event.
  const ghA = makeGithub({ review: () => new Promise(() => {}) });
  const a = makeState(dir, { github: ghA });
  await a.init({ startPhase: 'reply' });
  a.submitReplies({ replies: [{ ...REVIEW_REPLY, resolve: false }] }); // not awaited
  await new Promise((r) => setImmediate(r));

  // State B resumes the same session dir.
  const ghB = makeGithub();
  const b = makeState(dir, { github: ghB });
  await b.resume('reply');
  assert.equal(b.snapshot().reply.itemStatus['review:PRRT_1'].status, 'interrupted');

  // Resubmitting both: the interrupted review must NOT be re-posted (it may
  // already be on GitHub); the untouched issue posts normally.
  await b.submitReplies({ replies: [{ ...REVIEW_REPLY, resolve: false }, ISSUE_REPLY] });
  assert.equal(ghB.calls.review.length, 0, 'interrupted key was re-posted');
  assert.equal(ghB.calls.issue.length, 1);
  assert.equal(b.phase, 'done');
});

// ---------- history recorder ----------
test('history: finalizeReply records the session once as submitted', async () => {
  const dir = tmpDir();
  writeReply(dir);
  const history = spyHistory();
  const state = makeState(dir, { history });
  await state.init({ startPhase: 'reply' });
  await state.submitReplies({ replies: [REVIEW_REPLY, ISSUE_REPLY] });
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].status, 'submitted');
  assert.equal(history.records[0].repo, 'o/r');
  assert.equal(history.records[0].pr, 42);
  assert.equal(history.records[0].posted.length, 2);
  assert.equal(history.records[0].resolved.length, 1);
  // Absent provider ⇒ GitHub defaults are recorded.
  assert.equal(history.records[0].provider, 'github');
  assert.equal(history.records[0].host, 'github.com');
});

test('provider/host: a GitLab payload is reflected in the snapshot and the record', async () => {
  const dir = tmpDir();
  const payload = replyPayload();
  payload.provider = 'gitlab';
  payload.repo.host = 'gl.acme.dev';
  writeReply(dir, payload);
  const history = spyHistory();
  const state = makeState(dir, { history });
  await state.init({ startPhase: 'reply' });

  const snap = state.snapshot();
  assert.equal(snap.provider, 'gitlab');
  assert.equal(snap.host, 'gl.acme.dev');

  await state.submitReplies({ replies: [REVIEW_REPLY, ISSUE_REPLY] });
  assert.equal(history.records[0].provider, 'gitlab');
  assert.equal(history.records[0].host, 'gl.acme.dev');
});

test('history: decisions are enriched with reviewer + category from the triage payload', async () => {
  const dir = tmpDir();
  const payload = triagePayload();
  payload.reviewThreads[0].category = 'error-handling'; // Claude-tagged
  writeTriage(dir, payload);
  writeReply(dir);
  const history = spyHistory();
  const state = makeState(dir, { history });
  await state.init({ startPhase: 'triage' });
  // The browser submits sparse decisions (no author/category).
  state.submitTriage([
    { kind: 'review', threadId: 'PRRT_1', action: 'fix' },
    { kind: 'issue', databaseId: 222, action: 'reply' },
  ]);
  state.stop('cancelled');

  const decisions = history.records[0].decisions;
  const review = decisions.find((d) => d.threadId === 'PRRT_1');
  assert.equal(review.author, 'rev');            // first comment author
  assert.equal(review.category, 'error-handling'); // Claude's tag
  const issue = decisions.find((d) => d.databaseId === 222);
  assert.equal(issue.author, 'rev2');
});

test('history: stop(timeout) records once as timeout', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  const history = spyHistory();
  const state = makeState(dir, { history });
  await state.init({ startPhase: 'triage' });
  state.submitTriage([]);
  state.stop('timeout');
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].status, 'timeout');
});

test('history: cancel records once as cancelled', async () => {
  const dir = tmpDir();
  writeTriage(dir);
  const history = spyHistory();
  const state = makeState(dir, { history });
  await state.init({ startPhase: 'triage' });
  state.cancel('triage');
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].status, 'cancelled');
});

test('history: omitting the recorder is a no-op; a throwing recorder never breaks the terminal transition', async () => {
  const dir = tmpDir();
  writeReply(dir);
  const state = makeState(dir); // no history injected
  await state.init({ startPhase: 'reply' });
  await state.submitReplies({ replies: [REVIEW_REPLY, ISSUE_REPLY] });
  assert.equal(state.phase, 'done');

  const dir2 = tmpDir();
  writeReply(dir2);
  const boom = { record() { throw new Error('disk full'); } };
  const state2 = makeState(dir2, { history: boom });
  await state2.init({ startPhase: 'reply' });
  await state2.submitReplies({ replies: [REVIEW_REPLY, ISSUE_REPLY] });
  assert.equal(state2.phase, 'done'); // transition completed despite the throw
  assert.equal(readJson(sessionPaths(dir2).replyResult).status, 'submitted');
});

test('submitReplies: resolve is skipped server-side when viewerCanResolve is false', async () => {
  const dir = tmpDir();
  const payload = replyPayload();
  payload.reviewThreads[0].viewerCanResolve = false;
  writeReply(dir, payload);
  const gh = makeGithub();
  const state = makeState(dir, { github: gh });
  await state.init({ startPhase: 'reply' });

  // A client asks to resolve despite the thread lacking permission.
  await state.submitReplies({ replies: [{ ...REVIEW_REPLY, resolve: true }] });

  assert.equal(gh.calls.review.length, 1, 'the reply itself still posts');
  assert.equal(gh.calls.resolve.length, 0, 'resolve must not be attempted without permission');
});
