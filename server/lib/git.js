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

module.exports = { getFixCommit };
