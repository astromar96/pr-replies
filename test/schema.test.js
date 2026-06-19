'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateTriagePayload, validateReplyPayload, validateTemplates } = require('../server/lib/schema');

// ---------- fixtures ----------
function triagePayload() {
  return {
    version: 2,
    repo: { owner: 'o', name: 'r', nameWithOwner: 'o/r' },
    pr: { number: 42, title: 'T', url: 'https://x', author: 'a' },
    generatedAt: '2026-01-01T00:00:00Z',
    reviewThreads: [{
      id: 'PRRT_1',
      isOutdated: false,
      viewerCanResolve: true,
      path: 'src/a.js',
      startLine: null,
      line: 5,
      replyToDatabaseId: 111,
      diffHunk: '@@ -1 +1 @@',
      comments: [{ author: 'rev', createdAt: '2026-01-01T00:00:00Z', body: 'hm' }],
      suggestedAction: 'fix',
      confidence: 'high',
      fixPlan: 'do it',
      proposedDiff: null,
    }],
    issueComments: [{
      databaseId: 222,
      author: 'rev2',
      createdAt: '2026-01-01T00:00:00Z',
      url: 'https://x',
      body: 'general',
      suggestedAction: 'reply',
      confidence: 'low',
      fixPlan: null,
      proposedDiff: null,
    }],
  };
}

function replyPayload() {
  const p = triagePayload();
  for (const t of p.reviewThreads) {
    delete t.suggestedAction; delete t.confidence; delete t.fixPlan; delete t.proposedDiff;
    t.draft = 'thanks, fixed';
    t.fixedIn = 'abc1234';
    t.resolveDefault = true;
  }
  for (const c of p.issueComments) {
    delete c.suggestedAction; delete c.confidence; delete c.fixPlan; delete c.proposedDiff;
    c.draft = 'done';
    c.fixedIn = null;
  }
  return p;
}

const hasErrorAt = (errors, prefix) => errors.some((e) => e.startsWith(prefix));

// ---------- valid payloads ----------
test('schema: valid triage payload → no errors', () => {
  assert.deepEqual(validateTriagePayload(triagePayload()), []);
});

test('schema: valid reply payload → no errors', () => {
  assert.deepEqual(validateReplyPayload(replyPayload()), []);
});

// ---------- common (version / repo / pr / arrays) ----------
test('schema: version 1 is rejected with an error mentioning version', () => {
  const t = triagePayload();
  t.version = 1;
  const tErrors = validateTriagePayload(t);
  assert.ok(tErrors.length > 0);
  assert.ok(tErrors.some((e) => /version/.test(e)), tErrors.join('; '));

  const r = replyPayload();
  r.version = 1;
  const rErrors = validateReplyPayload(r);
  assert.ok(rErrors.some((e) => /version/.test(e)), rErrors.join('; '));
});

test('schema: missing repo.nameWithOwner → path-specific error', () => {
  const p = triagePayload();
  delete p.repo.nameWithOwner;
  const errors = validateTriagePayload(p);
  assert.ok(hasErrorAt(errors, 'repo.nameWithOwner'), errors.join('; '));
});

test('schema: missing pr.number → path-specific error', () => {
  const p = triagePayload();
  delete p.pr.number;
  const errors = validateTriagePayload(p);
  assert.ok(hasErrorAt(errors, 'pr.number'), errors.join('; '));
});

test('schema: missing reviewThreads/issueComments arrays → path-specific errors', () => {
  const p = triagePayload();
  delete p.reviewThreads;
  delete p.issueComments;
  const errors = validateTriagePayload(p);
  assert.ok(hasErrorAt(errors, 'reviewThreads'), errors.join('; '));
  assert.ok(hasErrorAt(errors, 'issueComments'), errors.join('; '));
});

// ---------- per-item triage checks ----------
test("schema: suggestedAction 'skip' is not valid in a payload", () => {
  const p = triagePayload();
  p.reviewThreads[0].suggestedAction = 'skip';
  p.issueComments[0].suggestedAction = 'skip';
  const errors = validateTriagePayload(p);
  assert.ok(hasErrorAt(errors, 'reviewThreads[0].suggestedAction'), errors.join('; '));
  assert.ok(hasErrorAt(errors, 'issueComments[0].suggestedAction'), errors.join('; '));
});

test('schema: bad confidence enum → indexed error', () => {
  const p = triagePayload();
  p.reviewThreads[0].confidence = 'certain';
  p.issueComments[0].confidence = 'sure';
  const errors = validateTriagePayload(p);
  assert.ok(hasErrorAt(errors, 'reviewThreads[0].confidence'), errors.join('; '));
  assert.ok(hasErrorAt(errors, 'issueComments[0].confidence'), errors.join('; '));
});

test('schema: non-boolean viewerCanResolve → indexed error', () => {
  const p = triagePayload();
  p.reviewThreads[0].viewerCanResolve = 'yes';
  const errors = validateTriagePayload(p);
  assert.ok(hasErrorAt(errors, 'reviewThreads[0].viewerCanResolve'), errors.join('; '));
});

test('schema: thread with empty comments[] → indexed error', () => {
  const t = triagePayload();
  t.reviewThreads[0].comments = [];
  const tErrors = validateTriagePayload(t);
  assert.ok(hasErrorAt(tErrors, 'reviewThreads[0].comments'), tErrors.join('; '));

  const r = replyPayload();
  r.reviewThreads[0].comments = [];
  const rErrors = validateReplyPayload(r);
  assert.ok(hasErrorAt(rErrors, 'reviewThreads[0].comments'), rErrors.join('; '));
});

// ---------- reply-specific checks ----------
test('schema: reply payload rejects non-boolean resolveDefault and non-string draft', () => {
  const p = replyPayload();
  p.reviewThreads[0].resolveDefault = 'yes';
  p.issueComments[0].draft = 7;
  const errors = validateReplyPayload(p);
  assert.ok(hasErrorAt(errors, 'reviewThreads[0].resolveDefault'), errors.join('; '));
  assert.ok(hasErrorAt(errors, 'issueComments[0].draft'), errors.join('; '));
});

// ---------- templates ----------
test('schema: validateTemplates accepts a well-formed list', () => {
  assert.deepEqual(validateTemplates({ version: 1, templates: [] }), []);
  assert.deepEqual(validateTemplates({ templates: [
    { id: 'a', name: 'Ack', scope: 'reply', body: 'hi' },
    { id: 'b', name: 'Both', scope: 'both', body: 'yo', tags: ['x'] },
  ] }), []);
});

test('schema: validateTemplates flags missing fields, bad scope, and duplicate ids', () => {
  assert.ok(validateTemplates(null).length);
  assert.ok(validateTemplates({}).length);                              // no templates array
  const e1 = validateTemplates({ templates: [{ id: 'x' }] });           // missing name + body
  assert.ok(hasErrorAt(e1, 'templates[0].name'), e1.join('; '));
  assert.ok(hasErrorAt(e1, 'templates[0].body'), e1.join('; '));
  const e2 = validateTemplates({ templates: [{ id: 'x', name: 'X', body: 'b', scope: 'nope' }] });
  assert.ok(hasErrorAt(e2, 'templates[0].scope'), e2.join('; '));
  const e3 = validateTemplates({ templates: [
    { id: 'dup', name: 'A', body: 'a' }, { id: 'dup', name: 'B', body: 'b' },
  ] });
  assert.ok(hasErrorAt(e3, 'templates[1].id'), e3.join('; '));
});

// ---------- provider / host (backward-compatible additions) ----------
test('schema: provider/host are optional — absent ⇒ valid (GitHub back-compat)', () => {
  const p = triagePayload();
  assert.equal(p.provider, undefined);
  assert.deepEqual(validateTriagePayload(p), []);
});

test('schema: provider:gitlab + repo.host validates', () => {
  const t = triagePayload();
  t.provider = 'gitlab';
  t.repo.host = 'gitlab.com';
  assert.deepEqual(validateTriagePayload(t), []);

  const r = replyPayload();
  r.provider = 'gitlab';
  r.repo.host = 'gl.acme.dev';
  assert.deepEqual(validateReplyPayload(r), []);
});

test('schema: an unknown provider and a non-string host are flagged', () => {
  const t = triagePayload();
  t.provider = 'bitbucket';
  t.repo.host = 7;
  const errors = validateTriagePayload(t);
  assert.ok(hasErrorAt(errors, 'provider'), errors.join('; '));
  assert.ok(hasErrorAt(errors, 'repo.host'), errors.join('; '));
});

test('schema: the GitLab example payloads validate', () => {
  const dir = path.join(__dirname, '..', 'examples');
  const triage = JSON.parse(fs.readFileSync(path.join(dir, 'payload.triage.gitlab.json'), 'utf8'));
  const reply = JSON.parse(fs.readFileSync(path.join(dir, 'payload.reply.gitlab.json'), 'utf8'));
  assert.deepEqual(validateTriagePayload(triage), []);
  assert.deepEqual(validateReplyPayload(reply), []);
});

// ---------- dual reply drafts (direct + humanized) ----------
test('schema: reply payload accepts an optional draftHumanized on both item types', () => {
  const p = replyPayload();
  p.reviewThreads[0].draftHumanized = 'Nice catch — fixed it!';
  p.issueComments[0].draftHumanized = 'On it — done!';
  assert.deepEqual(validateReplyPayload(p), []);
});

test('schema: a draft-only reply payload (no draftHumanized) still validates', () => {
  const p = replyPayload();
  for (const t of p.reviewThreads) assert.equal(t.draftHumanized, undefined);
  assert.deepEqual(validateReplyPayload(p), []);
});

test('schema: a non-string draftHumanized is flagged on both item types', () => {
  const p = replyPayload();
  p.reviewThreads[0].draftHumanized = 7;
  p.issueComments[0].draftHumanized = {};
  const errors = validateReplyPayload(p);
  assert.ok(hasErrorAt(errors, 'reviewThreads[0].draftHumanized'), errors.join('; '));
  assert.ok(hasErrorAt(errors, 'issueComments[0].draftHumanized'), errors.join('; '));
});

// ---------- reviewer routing (backward-compatible additions) ----------
test('schema: payloads validate with AND without assignee / assignableUsers', () => {
  // baseline (no new fields) still valid
  assert.deepEqual(validateTriagePayload(triagePayload()), []);
  assert.deepEqual(validateReplyPayload(replyPayload()), []);

  const t = triagePayload();
  t.pr.assignableUsers = ['alice', 'bob'];
  t.reviewThreads[0].assignee = 'alice';
  t.issueComments[0].assignee = 'bob';
  assert.deepEqual(validateTriagePayload(t), []);

  const r = replyPayload();
  r.pr.assignableUsers = ['alice'];
  r.reviewThreads[0].assignee = 'alice';
  assert.deepEqual(validateReplyPayload(r), []);
});

test('schema: malformed assignableUsers / assignee are flagged', () => {
  const t = triagePayload();
  t.pr.assignableUsers = 'alice';                 // not an array
  t.reviewThreads[0].assignee = 7;                // not a string
  const errors = validateTriagePayload(t);
  assert.ok(hasErrorAt(errors, 'pr.assignableUsers'), errors.join('; '));
  assert.ok(hasErrorAt(errors, 'reviewThreads[0].assignee'), errors.join('; '));
});
