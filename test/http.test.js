'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createState } = require('../server/lib/state');
const { createApp } = require('../server/lib/httpServer');
const { sessionPaths, writeAtomic } = require('../server/lib/session');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prr-http-'));
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
    issueComments: [],
  };
}

function replyPayload() {
  const p = triagePayload();
  p.reviewThreads[0].draft = 'fixed';
  p.reviewThreads[0].fixedIn = 'abc1234';
  p.reviewThreads[0].resolveDefault = true;
  return p;
}

function fakeGithub(overrides) {
  return Object.assign({
    async postReviewReply() { return { ok: true, url: 'https://gh/c/1' }; },
    async postIssueComment() { return { ok: true, url: 'https://gh/c/2' }; },
    async resolveThread() { return { ok: true }; },
  }, overrides || {});
}

function boot(opts) {
  opts = opts || {};
  const dir = tmpDir();
  const paths = sessionPaths(dir);
  writeAtomic(paths.triagePayload, triagePayload());
  if (opts.reply) writeAtomic(paths.replyPayload, replyPayload());
  const shutdownSpy = { called: 0 };
  const state = createState({
    sessionDir: dir,
    flags: { noPost: false, repoDir: null },
    config: {},
    github: opts.github || fakeGithub(),
    git: { getFixCommit: async () => null },
    log() {},
  });
  return state.init({ startPhase: opts.reply ? 'reply' : 'triage' }).then(() => {
    const app = createApp({
      state, token: 'tok', html: () => '<html>ok</html>',
      onShutdown: () => { shutdownSpy.called++; },
      log() {},
    });
    return new Promise((resolve) => {
      app.server.listen(0, '127.0.0.1', () => {
        resolve({ dir, paths, state, server: app.server, port: app.server.address().port, shutdownSpy });
      });
    });
  });
}

function req(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: Object.assign(
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        headers || {}),
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(out); } catch (_) { parsed = out; }
        resolve({ status: res.statusCode, body: parsed, raw: out });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('GET / serves html; wrong token 404; bad Host 400', async () => {
  const s = await boot();
  try {
    const ok = await req(s.port, 'GET', '/tok/');
    assert.equal(ok.status, 200);
    assert.match(ok.raw, /<html>ok<\/html>/);
    const wrong = await req(s.port, 'GET', '/nope/');
    assert.equal(wrong.status, 404);
    const badHost = await req(s.port, 'GET', '/tok/state', null, { Host: 'evil.com:80' });
    assert.equal(badHost.status, 400);
  } finally { s.server.close(); }
});

test('GET /state returns a snapshot', async () => {
  const s = await boot();
  try {
    const res = await req(s.port, 'GET', '/tok/state');
    assert.equal(res.status, 200);
    assert.equal(res.body.phase, 'triage');
    assert.equal(typeof res.body.lastSeq, 'number');
    assert.equal(res.body.triage.payload.reviewThreads.length, 1);
  } finally { s.server.close(); }
});

test('triage submit: 200, then 409; bad body 400', async () => {
  const s = await boot();
  try {
    const bad = await req(s.port, 'POST', '/tok/triage/submit', {});
    assert.equal(bad.status, 400);
    const ok = await req(s.port, 'POST', '/tok/triage/submit', { decisions: [] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: true });
    const again = await req(s.port, 'POST', '/tok/triage/submit', { decisions: [] });
    assert.equal(again.status, 409);
  } finally { s.server.close(); }
});

test('control/event returns abort flag', async () => {
  const s = await boot();
  try {
    await req(s.port, 'POST', '/tok/triage/submit', { decisions: [] });
    const res = await req(s.port, 'POST', '/tok/control/event', { type: 'fix_done', item: 'k', sha: 'x' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, abort: false });
  } finally { s.server.close(); }
});

test('control/advance: happy 200; broken payload 400 with errors', async () => {
  const s = await boot();
  try {
    await req(s.port, 'POST', '/tok/triage/submit', { decisions: [] });
    // overwrite reply payload with an invalid one
    fs.writeFileSync(s.paths.replyPayload, JSON.stringify({ version: 1 }));
    const bad = await req(s.port, 'POST', '/tok/control/advance', { phase: 'reply' });
    assert.equal(bad.status, 400);
    assert.ok(Array.isArray(bad.body.errors) && bad.body.errors.length > 0);
    // now a valid one
    writeAtomic(s.paths.replyPayload, replyPayload());
    const ok = await req(s.port, 'POST', '/tok/control/advance', { phase: 'reply' });
    assert.equal(ok.status, 200);
    const state = await req(s.port, 'GET', '/tok/state');
    assert.equal(state.body.phase, 'reply');
  } finally { s.server.close(); }
});

test('SSE replays recorded events and streams live ones', async () => {
  const s = await boot();
  try {
    await req(s.port, 'POST', '/tok/triage/submit', { decisions: [] }); // records a phase event
    await req(s.port, 'POST', '/tok/control/event', { type: 'note', text: 'before' });

    const frames = await new Promise((resolve, reject) => {
      const got = [];
      const r = http.request({ host: '127.0.0.1', port: s.port, path: '/tok/events?after=0', method: 'GET' }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          got.push(chunk);
          const joined = got.join('');
          if (joined.includes('"text":"after"')) { res.destroy(); resolve(joined); }
        });
        res.on('close', () => resolve(got.join('')));
      });
      r.on('error', reject);
      r.end();
      // emit a live event shortly after connecting
      setTimeout(() => { req(s.port, 'POST', '/tok/control/event', { type: 'note', text: 'after' }); }, 150);
      setTimeout(() => reject(new Error('sse timeout')), 4000);
    });

    assert.match(frames, /"type":"hello"/);
    assert.match(frames, /"text":"before"/);      // replayed
    assert.match(frames, /"text":"after"/);        // live
    assert.match(frames, /id: \d+/);               // monotonic id present
  } finally { s.server.close(); }
});

test('reply/submit: 202; double submit while posting 409; eventual post_done', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const github = fakeGithub({
    async postReviewReply() { await gate; return { ok: true, url: 'https://gh/c/9' }; },
  });
  const s = await boot({ reply: true, github });
  try {
    const body = {
      replies: [{ kind: 'review', key: 'review:PRRT_1', body: 'hi', threadId: 'PRRT_1', replyToDatabaseId: 111, path: 'src/a.js', line: 5 }],
      skipped: [],
    };
    const first = await req(s.port, 'POST', '/tok/reply/submit', body);
    assert.equal(first.status, 202);
    // posting is gated, so a second submit must 409
    const second = await req(s.port, 'POST', '/tok/reply/submit', body);
    assert.equal(second.status, 409);
    release();
    // wait for finalize
    await new Promise((res, rej) => {
      const started = Date.now();
      (function poll() {
        req(s.port, 'GET', '/tok/state').then((st) => {
          if (st.body.phase === 'done') return res();
          if (Date.now() - started > 4000) return rej(new Error('never finalized'));
          setTimeout(poll, 50);
        });
      })();
    });
    const fin = await req(s.port, 'GET', '/tok/state');
    assert.equal(fin.body.reply.result.posted.length, 1);
  } finally { s.server.close(); }
});

test('control/shutdown calls the onShutdown hook', async () => {
  const s = await boot();
  try {
    const res = await req(s.port, 'POST', '/tok/control/shutdown', {});
    assert.equal(res.status, 200);
    assert.equal(s.shutdownSpy.called, 1);
  } finally { s.server.close(); }
});
