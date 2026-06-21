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

// Send a raw (possibly invalid / oversized) body — req() always serializes
// valid JSON, so these paths need a hand-built request.
function rawPost(port, p, rawBody, contentType) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': contentType || 'application/json', 'Content-Length': Buffer.byteLength(rawBody) },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { let b = null; try { b = JSON.parse(out); } catch (_) { b = out; } resolve({ status: res.statusCode, body: b, raw: out }); });
    });
    r.on('error', reject);
    r.write(rawBody);
    r.end();
  });
}

test('POST body over the 1MB cap → 413; invalid JSON → 400', async () => {
  const s = await boot();
  try {
    const huge = JSON.stringify({ decisions: ['x'.repeat(1024 * 1024 + 16)] });
    const big = await rawPost(s.port, '/tok/triage/submit', huge);
    assert.equal(big.status, 413);
    const bad = await rawPost(s.port, '/tok/triage/submit', '{ not valid json ');
    assert.equal(bad.status, 400);
  } finally { s.server.close(); }
});

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

// ---------- data plane ----------
function fakeData() {
  let saved = [{ id: 'a', name: 'A', scope: 'reply', body: 'x', source: 'user', readonly: false }];
  return {
    sessions() { return [{ repo: 'o/r', pr: 1, phase: 'reply', url: 'http://127.0.0.1:1/t/', pid: 1, alive: true, startedAt: '', updatedAt: '' }]; },
    async prs() { return { repo: 'o/r', provider: 'github', prs: [{ number: 7, title: 'Fix', author: 'a', url: 'u' }], error: null }; },
    history() { return [{ id: 'h1', repo: 'o/r', pr: 1, status: 'submitted', endedAt: '', counts: {} }]; },
    historyDetail(id) { return id === 'h1' ? { id: 'h1', repo: 'o/r', pr: 1, posted: [] } : null; },
    templates() { return saved; },
    saveTemplates(list) { saved = list.map((t) => Object.assign({ source: 'user', readonly: false }, t)); return saved; },
  };
}

// Boot a session-mode app that also exposes the data plane.
function bootData() {
  const dir = tmpDir();
  writeAtomic(sessionPaths(dir).triagePayload, triagePayload());
  const state = createState({ sessionDir: dir, flags: {}, config: {}, github: fakeGithub(), git: { getFixCommit: async () => null }, log() {} });
  return state.init({ startPhase: 'triage' }).then(() => {
    const app = createApp({ state, data: fakeData(), token: 'tok', html: () => '<html>ok</html>', log() {} });
    return new Promise((resolve) => app.server.listen(0, '127.0.0.1', () => resolve({ dir, server: app.server, port: app.server.address().port })));
  });
}

// Boot a home-mode app: no state, only GET / + the data plane.
function bootHome() {
  const app = createApp({
    state: null, data: fakeData(),
    snapshot: () => ({ mode: 'home', config: { theme: 'system' } }),
    token: 'tok', html: () => '<html>hub</html>', log() {},
  });
  return new Promise((resolve) => app.server.listen(0, '127.0.0.1', () => resolve({ server: app.server, port: app.server.address().port })));
}

test('data plane: GET sessions/history/templates return shapes', async () => {
  const s = await bootData();
  try {
    assert.equal((await req(s.port, 'GET', '/tok/data/sessions')).body.sessions.length, 1);
    const prs = await req(s.port, 'GET', '/tok/data/prs');
    assert.equal(prs.status, 200);
    assert.equal(prs.body.prs[0].number, 7);
    assert.equal((await req(s.port, 'GET', '/tok/data/history')).body.history.length, 1);
    assert.equal((await req(s.port, 'GET', '/tok/data/templates')).body.templates[0].id, 'a');
    const detail = await req(s.port, 'GET', '/tok/data/history/h1');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.pr, 1);
    const missing = await req(s.port, 'GET', '/tok/data/history/nope');
    assert.equal(missing.status, 404);
    // removed routes now 404
    assert.equal((await req(s.port, 'GET', '/tok/data/dashboard')).status, 404);
    assert.equal((await req(s.port, 'GET', '/tok/data/insights')).status, 404);
    // wrong token / bad host still guarded on data routes
    assert.equal((await req(s.port, 'GET', '/bad/data/templates')).status, 404);
    assert.equal((await req(s.port, 'GET', '/tok/data/templates', null, { Host: 'evil.com' })).status, 400);
  } finally { s.server.close(); }
});

test('data plane: POST templates validates then round-trips', async () => {
  const s = await bootData();
  try {
    const bad = await req(s.port, 'POST', '/tok/data/templates', { templates: [{ id: 'x' }] });
    assert.equal(bad.status, 400);
    assert.ok(Array.isArray(bad.body.errors) && bad.body.errors.length > 0);
    const ok = await req(s.port, 'POST', '/tok/data/templates', { templates: [{ id: 'y', name: 'Y', scope: 'reply', body: 'hi' }] });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.templates[0].id, 'y');
    assert.equal((await req(s.port, 'GET', '/tok/data/templates')).body.templates[0].id, 'y');
  } finally { s.server.close(); }
});

test('data plane: POST decisions writes the session sidecar', async () => {
  const s = await bootData();
  try {
    const res = await req(s.port, 'POST', '/tok/data/decisions', { triage: { 'review:PRRT_1': { action: 'fix', assignee: 'alice' } } });
    assert.equal(res.status, 200);
    const sidecar = JSON.parse(fs.readFileSync(sessionPaths(s.dir).decisionsDraft, 'utf8'));
    assert.equal(sidecar.triage['review:PRRT_1'].assignee, 'alice');
    assert.equal(sidecar.version, 1);
  } finally { s.server.close(); }
});

test('home mode: serves html + data plane; phase routes and SSE 404', async () => {
  const s = await bootHome();
  try {
    assert.match((await req(s.port, 'GET', '/tok/')).raw, /hub/);
    assert.equal((await req(s.port, 'GET', '/tok/state')).body.mode, 'home');
    assert.equal((await req(s.port, 'GET', '/tok/data/templates')).status, 200);
    assert.equal((await req(s.port, 'GET', '/tok/events')).status, 404);
    assert.equal((await req(s.port, 'POST', '/tok/triage/submit', { decisions: [] })).status, 404);
    assert.equal((await req(s.port, 'POST', '/tok/control/advance', { phase: 'reply' })).status, 404);
  } finally { s.server.close(); }
});
