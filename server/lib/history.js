'use strict';

/**
 * Session history recorder. Owns the audit-record file format and the
 * prune-on-write bound; state.js hands it the raw building blocks at a terminal
 * transition and stays free of file-format knowledge. Best-effort: a write
 * failure must never break a terminal transition (state.js wraps record()).
 */

const store = require('./store');

function computeCounts(rec) {
  const decisions = rec.decisions || [];
  const by = (action) => decisions.filter((d) => d.action === action).length;
  return {
    fix: by('fix'),
    reply: by('reply'),
    skip: by('skip'),
    posted: (rec.posted || []).length,
    failed: (rec.errors || []).length,
    resolved: (rec.resolved || []).length,
  };
}

function createHistory({ id, startedAt, dryRun = false, historyMax = 200 } = {}) {
  return {
    record(partial) {
      const rec = Object.assign({ version: 1, id, startedAt, dryRun: !!dryRun }, partial);
      rec.counts = rec.counts || computeCounts(rec);
      store.writeHistory(rec);
      store.pruneHistory(historyMax);
      return rec;
    },
  };
}

module.exports = { createHistory, computeCounts };
