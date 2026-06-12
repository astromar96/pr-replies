#!/usr/bin/env node
/**
 * pr-replies UI server.
 *
 * Blocking process launched by the /pr-replies command. Serves the triage or
 * reply UI on 127.0.0.1, waits for the user to submit in the browser, then
 * (reply mode only) posts the approved replies to GitHub via `gh` and prints
 * a single result JSON block to stdout between sentinels:
 *
 *   ===PR_REPLIES_RESULT===
 *   { ... }
 *   ===END_PR_REPLIES_RESULT===
 *
 * stdout carries ONLY that block; all logging goes to stderr.
 *
 * Usage:
 *   node server.js --payload <path> [--timeout-secs 540] [--no-open] [--no-post]
 *
 * Exit codes: 0 = submitted or cancelled via UI, 2 = timeout, 130 = signal.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const SENTINEL_START = '===PR_REPLIES_RESULT===';
const SENTINEL_END = '===END_PR_REPLIES_RESULT===';
const MAX_BODY_BYTES = 1024 * 1024;

// ---------- args ----------
function parseArgs(argv) {
  const args = { timeoutSecs: 540, noOpen: false, noPost: false, payload: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--payload') args.payload = argv[++i];
    else if (a === '--timeout-secs') args.timeoutSecs = Number(argv[++i]);
    else if (a === '--no-open') args.noOpen = true;
    else if (a === '--no-post') args.noPost = true;
    else die(`unknown argument: ${a}`);
  }
  if (!args.payload) die('missing required --payload <path>');
  if (!Number.isFinite(args.timeoutSecs) || args.timeoutSecs <= 0) die('--timeout-secs must be a positive number');
  // Node's setTimeout overflows past 2^31-1 ms and would fire immediately.
  args.timeoutSecs = Math.min(args.timeoutSecs, 2147483);
  return args;
}

function die(msg) {
  process.stderr.write(`pr-replies: ${msg}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

// ---------- payload ----------
let payload;
try {
  payload = JSON.parse(fs.readFileSync(args.payload, 'utf8'));
} catch (e) {
  die(`cannot read payload ${args.payload}: ${e.message}`);
}
if (payload.version !== 1) die(`unsupported payload version: ${payload.version}`);
if (payload.mode !== 'triage' && payload.mode !== 'reply') die(`payload.mode must be "triage" or "reply", got: ${payload.mode}`);
if (!payload.repo || !payload.repo.nameWithOwner || !payload.pr || !payload.pr.number) die('payload missing repo.nameWithOwner or pr.number');
if (!Array.isArray(payload.reviewThreads) || !Array.isArray(payload.issueComments)) die('payload missing reviewThreads/issueComments arrays');

// ---------- html ----------
function buildHtml() {
  const tpl = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
  const json = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const marker = '"__PAYLOAD_JSON__"';
  if (!tpl.includes(marker)) die('ui.html is missing the payload marker');
  // Function replacement: a plain string here would expand $&, $`, $' patterns
  // occurring in comment bodies and corrupt the injected JSON.
  return tpl.replace(marker, () => json);
}
const html = buildHtml();

// ---------- gh ----------
function gh(argv) {
  return new Promise((resolve, reject) => {
    execFile('gh', argv, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(firstLine(stderr) || firstLine(err.message) || 'gh failed'));
      else resolve(stdout);
    });
  });
}

function firstLine(s) {
  return String(s || '').trim().split('\n')[0];
}

const REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
    comment { url }
  }
}`;

async function postReviewReply(r) {
  if (args.noPost) return { ok: true, url: '(dry-run)' };
  try {
    const out = await gh([
      'api', 'graphql',
      '-f', `query=${REPLY_MUTATION}`,
      '-f', `threadId=${r.threadId}`,
      '-f', `body=${r.body}`,
    ]);
    return { ok: true, url: JSON.parse(out).data.addPullRequestReviewThreadReply.comment.url };
  } catch (e1) {
    try {
      const out = await gh([
        'api', '-X', 'POST',
        `repos/${payload.repo.nameWithOwner}/pulls/${payload.pr.number}/comments/${r.replyToDatabaseId}/replies`,
        '-f', `body=${r.body}`,
      ]);
      return { ok: true, url: JSON.parse(out).html_url };
    } catch (e2) {
      return { ok: false, error: `${e1.message} | REST fallback: ${e2.message}` };
    }
  }
}

async function postIssueComment(r) {
  if (args.noPost) return { ok: true, url: '(dry-run)' };
  try {
    const out = await gh([
      'api', '-X', 'POST',
      `repos/${payload.repo.nameWithOwner}/issues/${payload.pr.number}/comments`,
      '-f', `body=${r.body}`,
    ]);
    return { ok: true, url: JSON.parse(out).html_url };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- lifecycle ----------
const state = { submitting: false, finished: false };
let timer = null;
let server = null;

function stopTimeout() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function finish(summary, exitCode) {
  if (state.finished) return;
  state.finished = true;
  stopTimeout();
  process.stdout.write(`\n${SENTINEL_START}\n${JSON.stringify(summary, null, 2)}\n${SENTINEL_END}\n`);
  process.exitCode = exitCode;
  if (server) server.close();
  // Not unref'd: guarantees the explicit exit code even if the loop drains first.
  setTimeout(() => process.exit(exitCode), 150);
}

function baseSummary(status) {
  return { status, mode: payload.mode, pr: payload.pr.number, repo: payload.repo.nameWithOwner };
}

// ---------- http ----------
function respond(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function respondJson(res, code, obj) {
  respond(res, code, 'application/json', JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // Keep draining so the 413 response can still be written on this socket.
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        return;
      }
      if (!tooBig) chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(new Error('body too large'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function handleSubmit(body, res) {
  if (state.submitting) return respondJson(res, 409, { error: 'already submitting' });

  // Validate shape BEFORE flipping state.submitting, so a bad body (including
  // a literal `null`) can never wedge the server into permanent 409s.
  if (payload.mode === 'triage') {
    if (!body || !Array.isArray(body.decisions)) {
      return respondJson(res, 400, { error: 'expected {decisions: [...]}' });
    }
    state.submitting = true;
    stopTimeout();
    respondJson(res, 200, { ok: true });
    setTimeout(() => finish({ ...baseSummary('submitted'), decisions: body.decisions }, 0), 250);
    return;
  }

  if (!body || !Array.isArray(body.replies)) {
    return respondJson(res, 400, { error: 'expected {replies: [...]}' });
  }
  state.submitting = true;
  // Posting can take a while; the safety timeout must not fire mid-posting and
  // report already-posted replies as status=timeout (the documented recovery
  // would then double-post them).
  stopTimeout();
  const results = { posted: [], errors: [], skipped: Array.isArray(body.skipped) ? body.skipped : [] };
  for (const r of body.replies) {
    if (typeof r.body !== 'string' || !r.body.trim()) continue;
    const out = r.kind === 'review' ? await postReviewReply(r) : await postIssueComment(r);
    const item = { kind: r.kind, key: r.key, path: r.path, line: r.line };
    if (out.ok) results.posted.push({ ...item, url: out.url });
    else results.errors.push({ ...item, error: out.error, body: r.body });
    process.stderr.write(`pr-replies: ${out.ok ? 'posted' : 'FAILED'} ${r.kind} reply${r.path ? ` (${r.path}:${r.line ?? '?'})` : ''}${out.ok ? '' : `: ${out.error}`}\n`);
  }
  respondJson(res, 200, results);
  setTimeout(() => finish({ ...baseSummary('submitted'), ...results }, 0), 250);
}

const token = crypto.randomBytes(16).toString('hex');

server = http.createServer((req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === `/${token}/`) {
      return respond(res, 200, 'text/html; charset=utf-8', html);
    }
    if (req.method === 'POST' && pathname === `/${token}/submit`) {
      return readJsonBody(req)
        .then((body) => handleSubmit(body, res))
        .catch((e) => respondJson(res, e.message === 'body too large' ? 413 : 400, { error: e.message }));
    }
    if (req.method === 'POST' && pathname === `/${token}/cancel`) {
      if (state.submitting) return respondJson(res, 409, { error: 'submit in progress' });
      respondJson(res, 200, { ok: true });
      setTimeout(() => finish(emptyResult('cancelled'), 0), 150);
      return;
    }
    respond(res, 404, 'text/plain', 'not found');
  } catch (e) {
    // A malformed request-target must never crash the process and lose the
    // sentinel protocol.
    try { respond(res, 400, 'text/plain', 'bad request'); } catch (_) { /* socket gone */ }
  }
});

function emptyResult(status) {
  return payload.mode === 'triage'
    ? { ...baseSummary(status), decisions: [] }
    : { ...baseSummary(status), posted: [], skipped: [], errors: [] };
}

server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/${token}/`;
  process.stderr.write(`pr-replies UI (${payload.mode}): ${url}\n`);
  if (!args.noOpen) {
    execFile('open', [url], (err) => {
      if (err) process.stderr.write(`pr-replies: could not open browser (${firstLine(err.message)}); open the URL above manually\n`);
    });
  }
});

timer = setTimeout(() => finish(emptyResult('timeout'), 2), args.timeoutSecs * 1000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => finish(emptyResult('cancelled'), 130));
}
