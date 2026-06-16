'use strict';

/**
 * Read-only data plane behind the GET data/* endpoints. Aggregates things that
 * span sessions — live sessions on this machine, history, templates, and an
 * optional `gh pr list` — without ever touching the phase state machine.
 *
 * `exec` (gh) and `alive`/`now` are injectable for tests; nothing here mutates
 * a live session (the dashboard only deep-links to each session's own URL).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { readJson, isPidAlive } = require('./session');
const store = require('./store');

const DEFAULT_SESSIONS_DIR = '/tmp/pr-replies';
const PRS_TTL_MS = 60 * 1000;

function ghExec(argv, cwd) {
  return new Promise((resolve, reject) => {
    execFile('gh', argv, { cwd: cwd || undefined, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n')[0] || 'gh failed'));
      else resolve(stdout);
    });
  });
}

function createDataPlane({
  repoDir = null,
  config = {},
  mode = 'session',
  exec = ghExec,
  alive = isPidAlive,
  now = () => Date.now(),
  sessionsDir = process.env.PR_REPLIES_SESSIONS_DIR || DEFAULT_SESSIONS_DIR,
} = {}) {
  let prsCache = null; // { at, value }

  function sessions() {
    let names;
    try { names = fs.readdirSync(sessionsDir); } catch (_) { return []; }
    const out = [];
    for (const n of names) {
      const s = readJson(path.join(sessionsDir, n, 'session.json'));
      if (!s || !s.pid) continue;
      out.push({
        repo: s.repo, pr: s.pr, phase: s.phase, url: s.url,
        pid: s.pid, alive: !!alive(s.pid),
        startedAt: s.startedAt, updatedAt: s.updatedAt,
      });
    }
    // Live sessions first, then most-recently-updated.
    out.sort((a, b) => (Number(b.alive) - Number(a.alive)) ||
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return out;
  }

  async function prs(force) {
    if (!repoDir) return { available: false, reason: 'no repo directory' };
    if (!force && !config.dashboardListPrs) return { available: false, reason: 'disabled' };
    if (prsCache && now() - prsCache.at < PRS_TTL_MS) return prsCache.value;
    let value;
    try {
      const raw = await exec(
        ['pr', 'list', '--json', 'number,title,author,reviewDecision,updatedAt,url', '--limit', '30'],
        repoDir);
      const items = (JSON.parse(raw) || []).map((p) => ({
        number: p.number,
        title: p.title,
        author: p.author && p.author.login ? p.author.login : (p.author || ''),
        reviewDecision: p.reviewDecision || null,
        updatedAt: p.updatedAt,
        url: p.url,
        unresolved: null,
      }));
      value = { available: true, items };
    } catch (e) {
      value = { available: false, reason: e.message };
    }
    prsCache = { at: now(), value };
    return value;
  }

  function history() { return store.listHistory(config.historyMax || 200); }

  function historyDetail(id) {
    // Validate against the actual dir listing — never interpolate a raw id.
    if (store.historyIds().indexOf(id) === -1) return null;
    return store.readHistory(id);
  }

  function templates() { return store.readMergedTemplates(repoDir); }

  function saveTemplates(list) {
    store.writeUserTemplates(list);
    return store.readMergedTemplates(repoDir);
  }

  async function dashboard(opts) {
    const result = { mode, sessions: sessions(), history: history() };
    const wantPrs = (opts && opts.prs) || (config.dashboardListPrs && repoDir);
    if (wantPrs) result.prs = await prs(!!(opts && opts.prs));
    return result;
  }

  return { sessions, prs, history, historyDetail, templates, saveTemplates, dashboard };
}

module.exports = { createDataPlane, ghExec };
