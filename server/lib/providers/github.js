'use strict';

/**
 * GitHub provider: PR review-thread replies, top-level comments, and thread
 * resolution via the `gh` CLI, with shared retry/backoff. `exec`/`sleep` are
 * injectable for tests; defaults shell out to `gh` and use real timers. All
 * write methods resolve to result objects, never throw.
 *
 * This is the canonical provider interface every backend implements:
 *   - postReviewReply  → reply inside a resolvable threaded discussion
 *   - postIssueComment → a new top-level comment on the PR/MR
 *   - resolveThread    → mark a resolvable discussion resolved
 * (The `review`/`issue` vocabulary is provider-neutral: "review" = a threaded,
 * resolvable discussion; "issue" = a top-level comment. GitLab maps the same
 * method names onto MR discussions and notes.)
 *
 * The only read helper here is `listPrs` (open PRs, for a multi-PR picker).
 * The heavier reads — fetching the PR, its review threads, and its general
 * comments, with pagination — are owned by the agent workflow
 * (src/agent/pr-replies.workflow.md, Steps 3–4), not this module; see
 * ./gitlab.js for the GitLab `listPrs` mapping.
 */

const { execFile } = require('node:child_process');
const { firstLine, parseResponse, isRetryable, makeWithRetry } = require('./retry');

// host !== github.com targets a GitHub Enterprise instance; gh honors GH_HOST.
// cwd lets repo-inferring commands (gh pr list) run inside the checkout.
function ghExec(argv, { host, cwd } = {}) {
  const env = host && host !== 'github.com' ? { ...process.env, GH_HOST: host } : process.env;
  return new Promise((resolve, reject) => {
    execFile('gh', argv, { cwd: cwd || undefined, env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(firstLine(stderr) || firstLine(err.message) || 'gh failed'));
      else resolve(stdout);
    });
  });
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

function createGithubProvider({
  exec, sleep, attempts = 4, baseMs = 1000, noPost = false, host = 'github.com',
} = {}) {
  const run = exec || ((argv, cwd) => ghExec(argv, { host, cwd }));
  const withRetry = makeWithRetry({ sleep, attempts, baseMs });

  async function replyAttempt({ repo, pr, threadId, replyToDatabaseId, body }) {
    try {
      const data = parseResponse(await run([
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
        const data = parseResponse(await run([
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
    const data = parseResponse(await run([
      'api', '-X', 'POST',
      `repos/${repo}/issues/${pr}/comments`,
      '-f', `body=${body}`,
    ]), 'issue comment');
    if (!data.html_url) throw new Error('issue comment: response missing html_url');
    return { ok: true, url: data.html_url };
  }

  async function resolveAttempt({ threadId }) {
    const data = parseResponse(await run([
      'api', 'graphql',
      '-f', `query=${RESOLVE_MUTATION}`,
      '-f', `threadId=${threadId}`,
    ]), 'resolve thread');
    const thread = data.data && data.data.resolveReviewThread && data.data.resolveReviewThread.thread;
    if (!thread || thread.isResolved !== true) throw new Error('resolve thread: thread not resolved');
    return { ok: true };
  }

  // Open PRs (provider read helper). gh infers the repo from the checkout, so
  // it runs in repoDir. Returns a normalized item list; throws on failure.
  async function listPrs({ repoDir, limit = 30 } = {}) {
    const raw = await run(
      ['pr', 'list', '--json', 'number,title,author,reviewDecision,updatedAt,url', '--limit', String(limit)],
      repoDir);
    return (JSON.parse(raw) || []).map((p) => ({
      number: p.number,
      title: p.title,
      author: p.author && p.author.login ? p.author.login : (p.author || ''),
      reviewDecision: p.reviewDecision || null,
      updatedAt: p.updatedAt,
      url: p.url,
    }));
  }

  return {
    name: 'github',
    listPrs,
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

module.exports = { createGithubProvider, ghExec, isRetryable };
