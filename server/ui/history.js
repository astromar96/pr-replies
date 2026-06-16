'use strict';
/* History route — a browsable audit log of past sessions. The list links to a
 * per-session detail that reuses PRR.app.renderSummary (the same renderer as
 * the live "done" view). Read-only; data comes from GET data/history[/:id]. */
(function () {
  function statusIcon(status) {
    return status === 'submitted' ? '<span class="t-icon ok">✓</span>'
      : status === 'timeout' ? '<span class="t-icon muted">⧖</span>'
      : '<span class="t-icon muted">–</span>';
  }

  function row(h) {
    const c = h.counts || {};
    return '<a class="trow history-row" href="#/history/' + encodeURIComponent(h.id) + '">' +
      '<span class="t-icon">' + statusIcon(h.status) + '</span>' +
      '<span class="t-label">' + PRR.esc((h.repo || '') + '#' + (h.pr != null ? h.pr : '')) +
      (h.dryRun ? ' <span class="badge">dry run</span>' : '') + '</span>' +
      '<span class="t-meta">' + PRR.esc(h.prTitle || '') +
      ' <span class="badge">' + (c.posted || 0) + ' posted</span>' +
      (c.failed ? '<span class="badge conf conf-low">' + c.failed + ' failed</span>' : '') +
      (c.resolved ? '<span class="badge fixed">' + c.resolved + ' resolved</span>' : '') +
      ' · ' + PRR.esc(PRR.relTime(h.endedAt)) + '</span></a>';
  }

  function labelMap(rec) {
    const map = {};
    (rec.posted || []).forEach(function (p) {
      map[p.key] = p.path ? p.path + (p.line != null ? ':' + p.line : '') : p.key;
    });
    (rec.fixCommits || []).forEach(function (f) { if (!map[f.key]) map[f.key] = f.key; });
    return map;
  }

  PRR.routes.history = {
    help: [
      ['g d / g h / g t / g p', 'Dashboard / History / Templates / Active PR'],
      ['?', 'toggle this help'],
    ],

    render: function (param) {
      PRR.keys.register('history', {
        '?': function () { PRR.app.toggleHelp('history'); },
        'escape': function () { PRR.app.toggleHelp(false); },
      });
      PRR.keys.setScope('history');
      if (param) this.renderDetail(param);
      else this.renderList();
    },

    renderList: function () {
      const app = document.getElementById('app');
      PRR.html(app,
        '<div class="view"><header><h1>History</h1>' +
        '<div class="sub">Past sessions on this machine — what was posted, resolved, and fixed.</div></header>' +
        '<div id="hist-body"><div class="boot">Loading…</div></div></div>');
      PRR.html(document.getElementById('footer'), '<span class="footer-note">read-only audit log</span>');
      PRR.api.get('data/history').then(function (d) {
        const body = document.getElementById('hist-body');
        if (!body) return;
        const items = d.history || [];
        body.innerHTML = items.length
          ? '<div class="summary-list">' + items.map(row).join('') + '</div>'
          : PRR.emptyState('No history yet', 'Finished <code>/pr-replies</code> sessions are recorded here automatically.');
      }).catch(function (e) {
        const body = document.getElementById('hist-body');
        if (body) body.innerHTML = '<div class="banner err">Could not load history: ' + PRR.esc(e.message) + '</div>';
      });
    },

    renderDetail: function (id) {
      const app = document.getElementById('app');
      PRR.html(app, '<div class="view"><div id="hist-detail" class="boot">Loading…</div></div>');
      PRR.html(document.getElementById('footer'),
        '<a class="nav-link" href="#/history">← All sessions</a>');
      PRR.api.get('data/history/' + encodeURIComponent(id)).then(function (rec) {
        const host = document.getElementById('hist-detail');
        if (!host) return;
        host.className = '';
        const cancelled = rec.status !== 'submitted';
        const head = '<header><h1>' +
          (rec.prUrl ? '<a href="' + PRR.esc(rec.prUrl) + '" target="_blank" rel="noopener">' + PRR.esc(rec.prTitle || 'Session') + '</a>' : PRR.esc(rec.prTitle || 'Session')) +
          '</h1><div class="sub"><b>' + PRR.esc((rec.repo || '') + '#' + (rec.pr != null ? rec.pr : '')) + '</b>' +
          ' · ' + PRR.esc(rec.status) + (rec.dryRun ? ' · dry run' : '') +
          ' · ' + PRR.esc(PRR.relTime(rec.endedAt)) + '</div></header>';
        const summary = document.createElement('div');
        PRR.app.renderSummary(summary, {
          cancelled: cancelled,
          timedOut: rec.status === 'timeout',
          posted: rec.posted || [],
          errors: rec.errors || [],
          resolved: rec.resolved || [],
          fixes: (rec.fixCommits || []).map(function (f) { return { key: f.key, sha: f.sha, text: f.subject }; }),
          labelFor: (function () { const m = labelMap(rec); return function (k) { return m[k] || k; }; })(),
        });
        host.innerHTML = head + summary.innerHTML;
      }).catch(function (e) {
        const host = document.getElementById('hist-detail');
        if (host) { host.className = ''; host.innerHTML = '<div class="banner err">Could not load this session: ' + PRR.esc(e.message) + '</div>'; }
      });
    },
  };
})();
