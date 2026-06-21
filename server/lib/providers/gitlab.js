'use strict';

/**
 * GitLab provider: the same canonical interface as the GitHub provider, mapped
 * onto Merge Request discussions/notes via the `glab` CLI. Auth is delegated to
 * the user's own `glab auth login` (no stored tokens), mirroring the gh model.
 *
 * REST-only on purpose: `glab`'s GraphQL coverage is patchier than `gh`'s, and
 * the MR discussions/notes REST endpoints are stable across gitlab.com and
 * self-managed instances. A self-managed host flows in via `host` → GITLAB_HOST.
 *
 * Provider-neutral term mapping:
 *   - "review" thread   = a resolvable MR discussion (a thread of notes)
 *   - "issue" comment   = a top-level MR note
 *   - repo              = the human project path "group/project" (nested groups
 *                         allowed); URL-encoded only at the API boundary
 *   - pr                = the MR IID (the per-project number the user sees)
 *   - threadId          = the GitLab discussion id (a string hash)
 */

const { execFile } = require('node:child_process');
const { firstLine, parseResponse, makeWithRetry } = require('./retry');

function glabExec(argv, { host, cwd } = {}) {
  const env = host ? { ...process.env, GITLAB_HOST: host } : process.env;
  return new Promise((resolve, reject) => {
    execFile('glab', argv, { cwd: cwd || undefined, env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(firstLine(stderr) || firstLine(err.message) || 'glab failed'));
      else resolve(stdout);
    });
  });
}

// GitLab REST addresses a project by its URL-encoded path; nested groups encode
// every slash (group/sub/project → group%2Fsub%2Fproject).
function encProject(repo) {
  return encodeURIComponent(String(repo));
}

// Notes endpoints don't return a stable web URL, so build the canonical anchor
// from the host + project path + MR IID + note id.
function noteUrl(host, repo, pr, noteId) {
  const base = `https://${host || 'gitlab.com'}/${repo}/-/merge_requests/${pr}`;
  return noteId != null ? `${base}#note_${noteId}` : base;
}

function createGitlabProvider({
  exec, sleep, attempts = 4, baseMs = 1000, noPost = false, host = 'gitlab.com',
} = {}) {
  const run = exec || ((argv, cwd) => glabExec(argv, { host, cwd }));
  const withRetry = makeWithRetry({ sleep, attempts, baseMs });

  // Reply inside an existing MR discussion (thread).
  async function replyAttempt({ repo, pr, threadId, body }) {
    const data = parseResponse(await run([
      'api', '-X', 'POST',
      `projects/${encProject(repo)}/merge_requests/${pr}/discussions/${threadId}/notes`,
      '-f', `body=${body}`,
    ]), 'mr discussion reply');
    if (data.id == null) throw new Error('mr discussion reply: response missing note id');
    return { ok: true, url: noteUrl(host, repo, pr, data.id) };
  }

  // A new top-level MR note.
  async function noteAttempt({ repo, pr, body }) {
    const data = parseResponse(await run([
      'api', '-X', 'POST',
      `projects/${encProject(repo)}/merge_requests/${pr}/notes`,
      '-f', `body=${body}`,
    ]), 'mr note');
    if (data.id == null) throw new Error('mr note: response missing note id');
    return { ok: true, url: noteUrl(host, repo, pr, data.id) };
  }

  // Mark a resolvable discussion resolved. GitLab resolves the whole discussion.
  // Idempotent: re-resolving an already-resolved discussion returns its notes
  // with resolved:true, which we accept. Only a discussion that still has an
  // explicitly-unresolved resolvable note (or came back with nothing resolved at
  // all) is a real failure — so a thread someone else already resolved between
  // triage and posting doesn't surface a spurious resolve error.
  async function resolveAttempt({ repo, pr, threadId }) {
    const data = parseResponse(await run([
      'api', '-X', 'PUT',
      `projects/${encProject(repo)}/merge_requests/${pr}/discussions/${threadId}?resolved=true`,
    ]), 'resolve discussion');
    const notes = Array.isArray(data.notes) ? data.notes : [];
    const stillUnresolved = notes.some((n) => n.resolvable === true && n.resolved === false);
    const anyResolved = notes.some((n) => n.resolved === true);
    if (stillUnresolved || !anyResolved) throw new Error('resolve discussion: not resolved');
    return { ok: true };
  }

  // Open MRs (provider read helper). glab infers the project from the checkout
  // (cwd). Maps the raw API objects (snake_case) to the neutral item shape;
  // field names are read defensively since glab JSON has varied across versions.
  async function listPrs({ repoDir, limit = 30 } = {}) {
    const raw = await run(['mr', 'list', '--output', 'json', '--per-page', String(limit)], repoDir);
    const list = JSON.parse(raw);
    const arr = Array.isArray(list) ? list : (list && Array.isArray(list.merge_requests) ? list.merge_requests : []);
    return arr.map((m) => ({
      number: m.iid != null ? m.iid : m.IID,
      title: m.title,
      author: (m.author && (m.author.username || m.author.login)) || '',
      reviewDecision: null,
      updatedAt: m.updated_at || m.updatedAt || null,
      url: m.web_url || m.webUrl || m.url || null,
      unresolved: null,
    }));
  }

  return {
    name: 'gitlab',
    listPrs,
    postReviewReply(req, onAttempt) {
      if (noPost) return Promise.resolve({ ok: true, url: '(dry-run)' });
      return withRetry(() => replyAttempt(req), onAttempt);
    },
    postIssueComment(req, onAttempt) {
      if (noPost) return Promise.resolve({ ok: true, url: '(dry-run)' });
      return withRetry(() => noteAttempt(req), onAttempt);
    },
    resolveThread(req, onAttempt) {
      if (noPost) return Promise.resolve({ ok: true });
      return withRetry(() => resolveAttempt(req), onAttempt);
    },
  };
}

module.exports = { createGitlabProvider, glabExec, encProject, noteUrl };
