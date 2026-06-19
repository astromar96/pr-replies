/**
 * Git helpers: fetch a commit's summary + diff for display in the reply UI.
 */
'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const MAX_DIFF_LINES = 1500;
const MAX_DIFF_BYTES = 100 * 1024;

const execFileP = promisify(execFile);

function defaultExec(file, argv) {
  return execFileP(file, argv, { maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout);
}

function capDiff(lines, sha) {
  // Trailing newline in git output yields a final empty element; not a line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let bytes = 0;
  let kept = 0;
  while (kept < lines.length && kept < MAX_DIFF_LINES) {
    const next = bytes + Buffer.byteLength(lines[kept], 'utf8') + 1;
    if (next > MAX_DIFF_BYTES) break;
    bytes = next;
    kept++;
  }
  if (kept >= lines.length) return lines.join('\n');
  const more = lines.length - kept;
  return lines
    .slice(0, kept)
    .concat(`…diff truncated (${more} more lines) — view locally with: git show ${sha}`)
    .join('\n');
}

// Parse an origin URL in either scp-like (git@host:path) or proto (https://,
// ssh://) form into { host, nameWithOwner }. Strips a trailing .git.
function parseRemoteUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return null;
  let host;
  let repoPath;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      host = u.hostname;
      repoPath = u.pathname;
    } catch (_) { return null; }
  } else {
    const scp = url.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/); // git@github.com:owner/repo.git
    if (!scp) return null;
    host = scp[1];
    repoPath = scp[2];
  }
  repoPath = String(repoPath || '').replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!host || !repoPath) return null;
  return { host, nameWithOwner: repoPath };
}

// Map a git host to a provider. Self-managed hosts are matched by substring so
// gitlab.acme.com / github.acme.com classify correctly; anything else is
// ambiguous (null) and the caller must fall back to an explicit --provider.
function classifyHost(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'github.com' || h.includes('github')) return 'github';
  if (h === 'gitlab.com' || h.includes('gitlab')) return 'gitlab';
  return null;
}

async function detectRemote({ repoDir, remote = 'origin', exec = defaultExec } = {}) {
  if (!repoDir) return null;
  let out;
  try {
    out = await exec('git', ['-C', repoDir, 'remote', 'get-url', remote]);
  } catch (_) {
    return null;
  }
  const parsed = parseRemoteUrl(out);
  if (!parsed) return null;
  return {
    provider: classifyHost(parsed.host),
    host: parsed.host,
    nameWithOwner: parsed.nameWithOwner,
    remoteUrl: String(out).trim(),
  };
}

async function detectBranch({ repoDir, exec = defaultExec } = {}) {
  if (!repoDir) return null;
  try {
    const out = await exec('git', ['-C', repoDir, 'branch', '--show-current']);
    return String(out).trim() || null;
  } catch (_) {
    return null;
  }
}

async function getFixCommit({ repoDir, sha, exec = defaultExec } = {}) {
  if (!repoDir || !sha) return null;
  let out;
  try {
    out = await exec('git', [
      '-C', repoDir,
      'show', '--no-color', '--stat', '--patch',
      '--format=%h%n%s%n==',
      sha,
    ]);
  } catch (_) {
    return null;
  }
  // Format is: short sha, subject, "==" separator, then the stat+patch body.
  const lines = String(out).split('\n');
  return {
    sha: lines[0] || sha,
    subject: lines[1] || '',
    diff: capDiff(lines.slice(3), sha),
  };
}

module.exports = { getFixCommit, detectRemote, detectBranch, parseRemoteUrl, classifyHost };
