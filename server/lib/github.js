/**
 * GitHub posting via the `gh` CLI with retry/backoff.
 *
 * `exec` and `sleep` are injectable for tests; defaults shell out to `gh`
 * and use real timers. All methods resolve to result objects, never throw.
 */
'use strict';

const { execFile } = require('node:child_process');

function firstLine(s) {
  return String(s || '').trim().split('\n')[0];
}

function ghExec(argv) {
  return new Promise((resolve, reject) => {
    execFile('gh', argv, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(firstLine(stderr) || firstLine(err.message) || 'gh failed'));
      else resolve(stdout);
    });
  });
}

// `gh api` exits 0 even when GitHub returns HTTP 200 with a GraphQL `errors`
// array or a body missing the field we need, so a non-zero exit is not enough
// to trust a mutation. Parse defensively and raise the embedded error message
// so withRetry/the caller see a real failure instead of a false success.
function parseResponse(out, context) {
  let data;
  try {
    data = JSON.parse(out);
  } catch (_) {
    throw new Error(`${context}: could not parse response`);
  }
  if (data && Array.isArray(data.errors) && data.errors.length) {
    throw new Error(`${context}: ${data.errors[0].message || JSON.stringify(data.errors[0])}`);
  }
  return data || {};
}

const RETRYABLE_PATTERNS = [
  /HTTP (429|5\d\d)/,
  /rate limit/i,
  /submitted too quickly/i,
  /(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up)/i,
];

function isRetryable(message) {
  const m = String(message || '');
  return RETRYABLE_PATTERNS.some((re) => re.test(m));
}

const REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
    comment { url }
  }
}`;

const RESOLVE_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { isResolved }
  }
}`;

function createGithub({ exec = ghExec, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 4, baseMs = 1000, noPost = false } = {}) {
  // attempt() resolves to a success result or throws; the thrown message
  // decides retryability. Backoff: baseMs * 2^(n-2) + 0-250ms jitter.
  async function withRetry(attempt, onAttempt) {
    let lastError = '';
    for (let n = 1; n <= attempts; n++) {
      if (n > 1) {
        if (onAttempt) onAttempt(n, lastError);
        await sleep(baseMs * 2 ** (n - 2) + Math.floor(Math.random() * 250));
      }
      try {
        return await attempt();
      } catch (e) {
        lastError = e.message;
        if (!isRetryable(lastError)) break;
      }
    }
    return { ok: false, error: lastError };
  }

  async function replyAttempt({ repo, pr, threadId, replyToDatabaseId, body }) {
    try {
      const data = parseResponse(await exec([
        'api', 'graphql',
        '-f', `query=${REPLY_MUTATION}`,
        '-f', `threadId=${threadId}`,
        '-f', `body=${body}`,
      ]), 'graphql reply');
      const reply = data.data && data.data.addPullRequestReviewThreadReply;
      const url = reply && reply.comment && reply.comment.url;
      if (!url) throw new Error('graphql reply: response missing comment url');
      return { ok: true, url };
    } catch (e1) {
      try {
        const data = parseResponse(await exec([
          'api', '-X', 'POST',
          `repos/${repo}/pulls/${pr}/comments/${replyToDatabaseId}/replies`,
          '-f', `body=${body}`,
        ]), 'rest reply');
        if (!data.html_url) throw new Error('rest reply: response missing html_url');
        return { ok: true, url: data.html_url };
      } catch (e2) {
        throw new Error(`${e1.message} | REST fallback: ${e2.message}`);
      }
    }
  }

  async function issueCommentAttempt({ repo, pr, body }) {
    const data = parseResponse(await exec([
      'api', '-X', 'POST',
      `repos/${repo}/issues/${pr}/comments`,
      '-f', `body=${body}`,
    ]), 'issue comment');
    if (!data.html_url) throw new Error('issue comment: response missing html_url');
    return { ok: true, url: data.html_url };
  }

  async function resolveAttempt({ threadId }) {
    const data = parseResponse(await exec([
      'api', 'graphql',
      '-f', `query=${RESOLVE_MUTATION}`,
      '-f', `threadId=${threadId}`,
    ]), 'resolve thread');
    const thread = data.data && data.data.resolveReviewThread && data.data.resolveReviewThread.thread;
    if (!thread || thread.isResolved !== true) throw new Error('resolve thread: thread not resolved');
    return { ok: true };
  }

  return {
    postReviewReply(req, onAttempt) {
      if (noPost) return Promise.resolve({ ok: true, url: '(dry-run)' });
      return withRetry(() => replyAttempt(req), onAttempt);
    },
    postIssueComment(req, onAttempt) {
      if (noPost) return Promise.resolve({ ok: true, url: '(dry-run)' });
      return withRetry(() => issueCommentAttempt(req), onAttempt);
    },
    resolveThread(req, onAttempt) {
      if (noPost) return Promise.resolve({ ok: true });
      return withRetry(() => resolveAttempt(req), onAttempt);
    },
  };
}

module.exports = { createGithub, isRetryable };
