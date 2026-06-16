'use strict';
/* App shell — boots from /state, hands routing to PRR.router, and owns the
 * per-PR phase flow: the phase stepper, the help overlay, the SSE fan-in, and
 * the final summary. The phase machine stays the single source of truth for the
 * active PR; Dashboard/History/Templates are sibling routes that never repaint
 * it (render is a no-op unless the active route is 'pr'). */
(function () {
  const STEPS = [['triage', 'Triage'], ['fixing', 'Fix'], ['reply', 'Reply'], ['done', 'Done']];
  let snapshot = null;

  PRR.app = {
    getSnapshot: function () { return snapshot; },

    stepper: function () {
      const phase = snapshot ? snapshot.phase : 'triage';
      const idx = STEPS.findIndex(function (s) { return s[0] === phase; });
      return '<div class="stepper">' + STEPS.map(function (s, i) {
        const cls = phase === 'cancelled' ? '' : i < idx || phase === 'done' ? 'done' : i === idx ? 'active' : '';
        return '<span class="step ' + cls + '">' + s[1] + '</span>' + (i < STEPS.length - 1 ? '<span class="sep">→</span>' : '');
      }).join('') + (phase === 'cancelled' ? '<span class="step">cancelled</span>' : '') + '</div>';
    },

    toggleHelp: function (scope) {
      const overlay = document.getElementById('help');
      if (!scope || !overlay.hidden) {
        overlay.hidden = true;
        return;
      }
      const entries = (PRR.views[scope] && PRR.views[scope].help) ||
        (PRR.routes[scope] && PRR.routes[scope].help) || [];
      overlay.innerHTML = '<div class="help-card"><h3>Keyboard shortcuts</h3><table>' +
        entries.map(function (e) {
          return '<tr><td>' + e[0].split(' / ').map(function (k) { return '<kbd>' + PRR.esc(k) + '</kbd>'; }).join(' / ') +
            '</td><td>' + PRR.esc(e[1]) + '</td></tr>';
        }).join('') + '</table></div>';
      overlay.hidden = false;
      overlay.addEventListener('click', function () { overlay.hidden = true; }, { once: true });
    },

    // Shared summary renderer — used by the final (done/cancelled) view AND the
    // history detail route. Builds the banner + a summary-list into `el`.
    renderSummary: function (el, opts) {
      const posted = opts.posted || [];
      const errors = opts.errors || [];
      const resolved = opts.resolved || [];
      const fixes = opts.fixes || [];
      const label = opts.labelFor || function (k) { return k; };

      let html = '';
      if (opts.cancelled) {
        html += '<div class="banner ' + (opts.timedOut ? 'warn' : 'ok') + '">' +
          (opts.timedOut ? 'The session window elapsed.' : 'Cancelled — no replies were posted.') +
          (fixes.length ? ' Fix commits already pushed remain on the branch.' : '') + '</div>';
      } else {
        html += '<div class="banner ' + (errors.length ? 'warn' : 'ok') + '">' +
          PRR.plural(posted.length, 'reply') + ' posted' +
          (resolved.length ? ', ' + PRR.plural(resolved.length, 'thread') + ' resolved' : '') +
          (errors.length ? ', ' + errors.length + ' failed' : '') + '.</div>';
      }

      const rows = [];
      fixes.forEach(function (f) {
        rows.push('<div class="trow"><span class="t-icon ok">✓</span><span class="t-label">' +
          PRR.esc(label(f.key)) + '</span><span class="t-meta"><span class="badge fixed">' +
          PRR.esc(f.sha || '') + '</span>' + PRR.esc(f.text || '') + '</span></div>');
      });
      posted.forEach(function (p) {
        rows.push('<div class="trow"><span class="t-icon ok">✓</span><span class="t-label">' +
          PRR.esc(label(p.key)) + '</span><span class="t-meta">' +
          (p.url && p.url !== '(dry-run)'
            ? '<a href="' + PRR.esc(p.url) + '" target="_blank" rel="noopener">view reply</a>'
            : 'dry run') + '</span></div>');
      });
      errors.forEach(function (e) {
        rows.push('<div class="trow"><span class="t-icon err">✗</span><span class="t-label">' +
          PRR.esc(label(e.key)) + '</span><span class="t-meta">' + PRR.esc(e.error || '') + '</span></div>');
      });
      if (rows.length) html += '<div class="summary-list">' + rows.join('') + '</div>';
      el.innerHTML = html;
    },
  };

  function labelFor(key) {
    const pools = [];
    if (snapshot.reply && snapshot.reply.payload) pools.push(snapshot.reply.payload);
    if (snapshot.triage && snapshot.triage.payload) pools.push(snapshot.triage.payload);
    for (const P of pools) {
      for (const t of P.reviewThreads) {
        if (PRR.itemKey(t) === key) return t.path + (t.line != null ? ':' + t.line : '');
      }
      for (const c of P.issueComments) {
        if (PRR.itemKey(c) === key) return 'general comment by ' + c.author;
      }
    }
    return key;
  }

  function fixDoneEvents() {
    return (snapshot.fixing.events || []).filter(function (e) { return e.type === 'fix_done'; });
  }

  function renderFinal() {
    const app = document.getElementById('app');
    const result = snapshot.reply.result || {};
    const cancelled = snapshot.phase === 'cancelled';
    const timedOut = result.status === 'timeout' ||
      (snapshot.triage.result && snapshot.triage.result.status === 'timeout');

    const head = '<div class="view"><header><h1>' +
      (cancelled ? (timedOut ? 'Session timed out' : 'Session cancelled') : 'All done') + '</h1>' +
      '<div class="sub"><b>' + PRR.esc(snapshot.repo ? snapshot.repo.nameWithOwner : '') +
      '#' + (snapshot.pr ? snapshot.pr.number : '') + '</b> · return to the Claude session for the summary</div></header>';

    const body = document.createElement('div');
    PRR.app.renderSummary(body, {
      cancelled: cancelled,
      timedOut: timedOut,
      posted: result.posted || [],
      errors: result.errors || [],
      resolved: result.resolved || [],
      fixes: fixDoneEvents().map(function (e) { return { key: e.item, sha: e.sha, text: e.summary }; }),
      labelFor: labelFor,
    });
    PRR.html(app, head + body.innerHTML + '</div>');

    PRR.html(document.getElementById('footer'),
      PRR.app.stepper() +
      '<span class="footer-note">this tab can be closed</span>' +
      '<button id="close-tab">Close tab</button>');
    document.getElementById('close-tab').addEventListener('click', function () { window.close(); });
    PRR.keys.setScope(null);

    if (!cancelled && !(result.errors || []).length) PRR.store.clear();
  }

  // The #/pr route delegates here. Renders the current phase into #app.
  function renderPhase() {
    const view = PRR.views[snapshot.phase];
    if (snapshot.phase === 'done' || snapshot.phase === 'cancelled') renderFinal();
    else if (view) view.render(snapshot);
    document.title = 'PR #' + (snapshot.pr ? snapshot.pr.number : '') + ' — ' +
      ({ triage: 'Triage', fixing: 'Fixing', reply: 'Replies', done: 'Done', cancelled: 'Cancelled' })[snapshot.phase];
  }

  function onPr() { return PRR.router.current() === 'pr'; }

  function refetchAndRender() {
    return PRR.api.get('state').then(function (fresh) {
      snapshot = fresh;
      if (onPr()) renderPhase();
      PRR.router.refreshNav();
    }).catch(function () {
      PRR.banner('err', 'Lost connection to the session server. If it was restarted, this page will reconnect automatically.');
    });
  }

  function maybeAutoClose() {
    if (PRR.store.pref('autoclose') === '0') return;
    const errors = (snapshot.reply.result && snapshot.reply.result.errors) || [];
    if (snapshot.phase === 'done' && errors.length === 0) {
      // Browsers only honor window.close() for tabs they opened themselves —
      // exactly how the server launches this page.
      setTimeout(function () { window.close(); }, 1200);
    }
  }

  function onEvent(e) {
    if (e.type === 'hello') {
      if (snapshot && e.phase !== snapshot.phase) refetchAndRender();
      return;
    }
    if (e.type === 'phase') {
      refetchAndRender();
      return;
    }
    if (e.type === 'session_end') {
      refetchAndRender().then(maybeAutoClose);
      return;
    }
    // Per-item live events only matter while the phase view is mounted.
    if (!onPr()) return;
    const view = snapshot && PRR.views[snapshot.phase];
    if (view && view.onEvent) view.onEvent(e, snapshot);
  }

  // The 'pr' route is owned here so the phase machine + SSE stay in app.js.
  PRR.routes.pr = {
    label: 'Active PR',
    render: function () { renderPhase(); },
  };

  PRR.api.get('state').then(function (s) {
    snapshot = s;
    PRR.store.init(s.repo ? s.repo.nameWithOwner : 'unknown', s.pr ? s.pr.number : 0);
    // Only a live session has an event stream; the hub (home mode) has none.
    if (s.phase) PRR.connectSse(s.lastSeq, onEvent);
    PRR.router.start(s);
  }).catch(function (e) {
    PRR.html(document.getElementById('app'),
      '<div class="banner err">Could not load the session: ' + PRR.esc(e.message) +
      ' — is the server still running?</div>');
  });
})();
