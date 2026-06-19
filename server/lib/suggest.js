'use strict';

/**
 * Triage priors. `buildSuggestions({ repo, repoDir })` reads the local history +
 * reply templates and returns the signal the `/pr-replies` command uses to bias
 * its per-comment suggestions: how often this repo's review comments became
 * fixes vs replies vs skips (overall and per Claude-tagged category), and the
 * reusable reply templates. Pure aggregation — no LLM, no network. The server
 * stays dumb; Claude does the classification using these priors.
 */

const store = require('./store');

function ratesFrom(counts) {
  const total = counts.fix + counts.reply + counts.skip;
  if (!total) return { fix: 0, reply: 0, skip: 0 };
  const r = (n) => Math.round((100 * n) / total) / 100;
  return { fix: r(counts.fix), reply: r(counts.reply), skip: r(counts.skip) };
}

function buildSuggestions({ repo = null, repoDir = null, provider = null, historyMax = 200 } = {}) {
  const records = store.allHistory(historyMax)
    .filter((r) => (!repo || r.repo === repo) && (!provider || (r.provider || 'github') === provider));

  const overall = { fix: 0, reply: 0, skip: 0 };
  const byCategory = new Map();
  for (const rec of records) {
    for (const d of rec.decisions || []) {
      if (!d || (d.action !== 'fix' && d.action !== 'reply' && d.action !== 'skip')) continue;
      overall[d.action] += 1;
      if (d.category) {
        const c = byCategory.get(d.category) || { category: d.category, fix: 0, reply: 0, skip: 0, total: 0 };
        c[d.action] += 1; c.total += 1;
        byCategory.set(d.category, c);
      }
    }
  }

  const categoryPriors = Array.from(byCategory.values())
    .sort((a, b) => b.total - a.total)
    .map((c) => Object.assign({}, c, { rates: ratesFrom(c) }));

  const templates = store.readMergedTemplates(repoDir).map((t) => ({
    id: t.id, name: t.name, scope: t.scope || 'reply', tags: t.tags || [], body: t.body,
  }));

  return {
    repo,
    provider,
    sessions: records.length,
    decisions: overall.fix + overall.reply + overall.skip,
    actionPriors: ratesFrom(overall),
    categoryPriors,
    templates,
  };
}

module.exports = { buildSuggestions };
