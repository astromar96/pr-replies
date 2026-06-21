'use strict';

/**
 * Cross-session local storage: templates + history under the config dir
 * (~/.config/pr-replies by default, overridable with PR_REPLIES_CONFIG_DIR so
 * tests and the UI preview never touch a developer's real files).
 *
 * Everything reuses the session layer's atomic write + tolerant read, and no
 * function throws — a missing/corrupt file reads as empty.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeAtomic, readJson } = require('./session');

function configDir() {
  return process.env.PR_REPLIES_CONFIG_DIR || path.join(os.homedir(), '.config', 'pr-replies');
}

function templatesUserPath() { return path.join(configDir(), 'templates.json'); }
function templatesRepoPath(repoDir) { return repoDir ? path.join(repoDir, '.pr-replies', 'templates.json') : null; }
function historyDir() { return path.join(configDir(), 'history'); }
function historyPath(id) { return path.join(historyDir(), id + '.json'); }

// A session-dir basename: owner-repo-prN-epoch. No slashes, no traversal.
function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && id.length < 256 &&
    /^[A-Za-z0-9._-]+$/.test(id) && id.indexOf('..') === -1;
}

function readTemplateList(file) {
  if (!file) return [];
  const data = readJson(file);
  if (!data || !Array.isArray(data.templates)) return [];
  return data.templates.filter((t) => t && typeof t.id === 'string' && typeof t.body === 'string' && typeof t.name === 'string');
}

// User templates override repo templates on id collision. Each row is tagged so
// the UI can mark repo rows read-only.
function readMergedTemplates(repoDir) {
  const byId = new Map();
  for (const t of readTemplateList(templatesRepoPath(repoDir))) {
    byId.set(t.id, Object.assign({}, t, { source: 'repo', readonly: true }));
  }
  for (const t of readTemplateList(templatesUserPath())) {
    byId.set(t.id, Object.assign({}, t, { source: 'user', readonly: false }));
  }
  return Array.from(byId.values());
}

// Persists ONLY the user file; the repo file is never written. Strips the
// transient source/readonly tags so they don't get baked into the file.
function writeUserTemplates(list) {
  const clean = (Array.isArray(list) ? list : []).map((t) => {
    const out = { id: String(t.id), name: String(t.name), scope: t.scope || 'reply', body: String(t.body) };
    if (Array.isArray(t.tags)) out.tags = t.tags.map(String);
    return out;
  });
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeAtomic(templatesUserPath(), { version: 1, templates: clean });
  return clean;
}

function summary(rec) {
  return {
    id: rec.id, repo: rec.repo, pr: rec.pr, prTitle: rec.prTitle, prUrl: rec.prUrl,
    provider: rec.provider || 'github', host: rec.host || null,
    status: rec.status, dryRun: !!rec.dryRun,
    startedAt: rec.startedAt, endedAt: rec.endedAt, counts: rec.counts || {},
  };
}

function historyFiles() {
  try {
    return fs.readdirSync(historyDir()).filter((n) => n.endsWith('.json'));
  } catch (_) { return []; }
}

// Newest-first FULL records (by endedAt), bounded by `limit`. `suggest` needs
// the whole record (decisions, timestamps); listHistory maps these to summaries.
function allHistory(limit) {
  const recs = [];
  for (const n of historyFiles()) {
    const rec = readJson(path.join(historyDir(), n));
    if (rec && rec.id) recs.push(rec);
  }
  recs.sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || '')));
  return limit ? recs.slice(0, limit) : recs;
}

// Newest-first summaries (by endedAt), bounded by `limit`.
function listHistory(limit) {
  return allHistory(limit).map(summary);
}

function historyIds() {
  return historyFiles().map((n) => n.slice(0, -5));
}

function readHistory(id) {
  if (!isValidId(id)) return null;
  return readJson(historyPath(id));
}

// Delete oldest files (by mtime) beyond `max`.
function pruneHistory(max) {
  const files = historyFiles().map((n) => {
    const full = path.join(historyDir(), n);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch (_) { /* gone */ }
    return { full, mtime };
  });
  if (files.length <= max) return;
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files.slice(0, files.length - max)) {
    try { fs.rmSync(f.full, { force: true }); } catch (_) { /* ignore */ }
  }
}

function writeHistory(rec) {
  fs.mkdirSync(historyDir(), { recursive: true, mode: 0o700 });
  writeAtomic(historyPath(rec.id), rec);
}

module.exports = {
  configDir, templatesUserPath, templatesRepoPath, historyDir, historyPath, isValidId,
  readMergedTemplates, writeUserTemplates,
  allHistory, listHistory, historyIds, readHistory, pruneHistory, writeHistory, summary,
};
