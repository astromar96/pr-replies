'use strict';
/* Dashboard route — the hub overview: live sessions on this machine, recent
 * session history, and (optionally) open PRs from GitHub. It can NOT start a
 * new flow (the browser can't invoke Claude) — it deep-links to running
 * sessions and surfaces copyable `/pr-replies <n>` launch hints. */
(function () {
  function stateBadge(decision) {
    if (decision === 'CHANGES_REQUESTED') return '<span class="badge state state-changes">changes requested</span>';
    if (decision === 'APPROVED') return '<span class="badge state state-approved">approved</span>';
    if (decision === 'REVIEW_REQUIRED') return '<span class="badge">review required</span>';
    return '';
  }

  function sessionTile(s) {
    const loc = PRR.esc((s.repo || '?') + '#' + (s.pr != null ? s.pr : '?'));
    return '<div class="pr-tile card">' +
      '<div class="pt-top"><span class="pt-repo">' + loc + '</span>' +
      '<span class="badge ' + (s.alive ? 'fixed' : '') + '">' + PRR.esc(s.alive ? (s.phase || 'live') : 'ended') + '</span></div>' +
      '<div class="pt-meta">updated ' + PRR.esc(PRR.relTime(s.updatedAt)) + '</div>' +
      '<div class="pt-actions">' +
      (s.alive && s.url
        ? '<a href="' + PRR.esc(s.url) + '" target="_blank" rel="noopener">open session →</a>'
        : '<span class="empty">no longer running</span>') +
      '</div></div>';
  }

  function prTile(p) {
    return '<div class="pr-tile card">' +
      '<div class="pt-top"><span class="pt-repo">#' + PRR.esc(p.number) + '</span>' + stateBadge(p.reviewDecision) + '</div>' +
      '<div class="pt-title"><a href="' + PRR.esc(p.url) + '" target="_blank" rel="noopener">' + PRR.esc(p.title) + '</a></div>' +
      '<div class="pt-meta">by ' + PRR.esc(p.author) + ' · ' + PRR.esc(PRR.relTime(p.updatedAt)) + '</div>' +
      '<div class="pt-actions"><button class="small" data-launch="' + PRR.esc(p.number) + '">copy /pr-replies ' + PRR.esc(p.number) + '</button></div>' +
      '</div>';
  }

  function historyRow(h) {
    const icon = h.status === 'submitted' ? '<span class="t-icon ok">✓</span>'
      : h.status === 'timeout' ? '<span class="t-icon muted">⧖</span>'
      : '<span class="t-icon muted">–</span>';
    const c = h.counts || {};
    return '<a class="trow history-row" href="#/history/' + encodeURIComponent(h.id) + '">' +
      '<span class="t-icon">' + icon + '</span>' +
      '<span class="t-label">' + PRR.esc((h.repo || '') + '#' + (h.pr != null ? h.pr : '')) +
      (h.dryRun ? ' <span class="badge">dry run</span>' : '') + '</span>' +
      '<span class="t-meta">' + PRR.esc(h.prTitle || '') +
      ' <span class="badge">' + (c.posted || 0) + ' posted</span>' +
      (c.resolved ? '<span class="badge fixed">' + c.resolved + ' resolved</span>' : '') +
      ' · ' + PRR.esc(PRR.relTime(h.endedAt)) + '</span></a>';
  }

  function section(title, inner) {
    return '<h2>' + PRR.esc(title) + '</h2>' + inner;
  }

  PRR.routes.dashboard = {
    help: [
      ['g d / g h / g t / g p', 'Dashboard / History / Templates / Active PR'],
      ['r', 'refresh'],
      ['?', 'toggle this help'],
    ],

    render: function () {
      const app = document.getElementById('app');
      PRR.html(app,
        '<div class="view"><header><h1>Dashboard</h1>' +
        '<div class="sub">Live sessions, history, and open PRs — all local to this machine.</div></header>' +
        '<div id="dash-body"><div class="boot">Loading…</div></div></div>');
      PRR.html(document.getElementById('footer'),
        '<span class="footer-note" style="margin-right:auto">Start a session with <code>/pr-replies &lt;n&gt;</code> in Claude Code</span>' +
        '<button class="small" id="dash-refresh">Refresh</button>');
      document.getElementById('dash-refresh').addEventListener('click', function () { PRR.routes.dashboard.load(); });

      PRR.keys.register('dashboard', {
        'r': function () { PRR.routes.dashboard.load(); },
        '?': function () { PRR.app.toggleHelp('dashboard'); },
        'escape': function () { PRR.app.toggleHelp(false); },
      });
      PRR.keys.setScope('dashboard');
      this.load();
    },

    load: function () {
      const body = document.getElementById('dash-body');
      if (!body) return;
      PRR.api.get('data/dashboard').then(function (d) {
        if (!document.getElementById('dash-body')) return; // navigated away
        PRR.routes.dashboard.paint(d);
      }).catch(function (e) {
        if (body) body.innerHTML = '<div class="banner err">Could not load the dashboard: ' + PRR.esc(e.message) + '</div>';
      });
    },

    paint: function (d) {
      const body = document.getElementById('dash-body');
      const sessions = (d.sessions || []).filter(function (s) { return s.alive; });
      const history = d.history || [];
      const prs = d.prs;
      let html = '';

      if (sessions.length) {
        html += section('Active sessions', '<div class="dash-grid">' + sessions.map(sessionTile).join('') + '</div>');
      }

      if (prs && prs.available && prs.items && prs.items.length) {
        html += section('Open PRs', '<div class="dash-grid">' + prs.items.map(prTile).join('') + '</div>');
      } else {
        const note = prs && prs.available === false && prs.reason === 'disabled'
          ? 'Enable <code>dashboardListPrs</code> in your config to list open PRs here, or'
          : (prs && prs.reason && prs.reason !== 'disabled' ? 'GitHub PR list unavailable (' + PRR.esc(prs.reason) + '). You can' : 'You can');
        html += section('Open PRs',
          '<div class="dash-actions"><button class="small" id="load-prs">Load PRs from GitHub</button>' +
          '<span class="footer-note">' + note + ' load on demand.</span></div>');
      }

      if (history.length) {
        html += section('Recent sessions', '<div class="summary-list">' + history.slice(0, 25).map(historyRow).join('') + '</div>');
      }

      if (!sessions.length && !history.length && !(prs && prs.available && prs.items && prs.items.length)) {
        html += PRR.emptyState('Nothing here yet',
          'Run <code>/pr-replies &lt;n&gt;</code> in Claude Code to triage a PR. Finished sessions show up here, and your reply templates live under <b>Templates</b>.');
      }

      body.innerHTML = html;
      PRR.routes.dashboard.wire();
    },

    wire: function () {
      const loadBtn = document.getElementById('load-prs');
      if (loadBtn) {
        loadBtn.addEventListener('click', function () {
          loadBtn.disabled = true;
          loadBtn.textContent = 'Loading…';
          PRR.api.get('data/prs').then(function (prs) {
            const sec = loadBtn.closest('.dash-actions');
            if (!sec) return;
            if (prs && prs.available && prs.items && prs.items.length) {
              const grid = document.createElement('div');
              grid.className = 'dash-grid';
              grid.innerHTML = prs.items.map(prTile).join('');
              sec.replaceWith(grid);
              PRR.routes.dashboard.wire();
            } else {
              loadBtn.disabled = false;
              loadBtn.textContent = 'Load PRs from GitHub';
              PRR.banner('warn', 'No open PRs found' + (prs && prs.reason ? ' (' + PRR.esc(prs.reason) + ')' : '') + '.');
            }
          }).catch(function (e) {
            loadBtn.disabled = false;
            loadBtn.textContent = 'Load PRs from GitHub';
            PRR.banner('err', PRR.esc(e.message));
          });
        });
      }
      Array.prototype.forEach.call(document.querySelectorAll('[data-launch]'), function (btn) {
        btn.addEventListener('click', function () {
          const cmd = '/pr-replies ' + btn.dataset.launch;
          const done = function () { btn.textContent = 'copied!'; setTimeout(function () { btn.textContent = 'copy ' + cmd; }, 1400); };
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cmd).then(done, done);
          else done();
        });
      });
    },
  };
})();
