'use strict';

/**
 * Read-only data plane behind the GET data/* endpoints. Aggregates things that
 * span sessions — live sessions on this machine, history, and templates —
 * without ever touching the phase state machine.
 *
 * `alive` is injectable for tests; nothing here mutates a live session (the hub
 * only deep-links to each session's own URL).
 */

const fs = require('node:fs');
const path = require('node:path');

const { readJson, isPidAlive } = require('./session');
const store = require('./store');

const DEFAULT_SESSIONS_DIR = '/tmp/pr-replies';

function createDataPlane({
  repoDir = null,
  config = {},
  alive = isPidAlive,
  sessionsDir = process.env.PR_REPLIES_SESSIONS_DIR || DEFAULT_SESSIONS_DIR,
} = {}) {
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

  // Best-effort removal of abandoned session dirs (crash leftovers) under the
  // sessions root. Gated on BOTH a dead pid AND age, so a live session, a
  // just-launched one mid-boot (no session.json yet), or one waiting to be
  // --resume'd within the window is never clobbered. Called on hub start.
  function pruneStale({ maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
    let names;
    try { names = fs.readdirSync(sessionsDir); } catch (_) { return { removed: 0 }; }
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const n of names) {
      const dir = path.join(sessionsDir, n);
      const s = readJson(path.join(dir, 'session.json'));
      if (!s || !s.pid || alive(s.pid)) continue;             // no record, or still running → keep
      const touched = Date.parse(s.updatedAt || s.startedAt || '') || 0;
      if (touched > cutoff) continue;                          // recently active → keep (resumable)
      try { fs.rmSync(dir, { recursive: true, force: true }); removed += 1; } catch (_) { /* best effort */ }
    }
    return { removed };
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

  return { sessions, history, historyDetail, templates, saveTemplates, pruneStale };
}

module.exports = { createDataPlane };
