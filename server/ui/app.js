'use strict';
/* App shell — boots from /state, routes phases to views, handles SSE fan-in,
 * the phase stepper, the help overlay, and the final summary views. */
(function () {
  const STEPS = [['triage', 'Triage'], ['fixing', 'Fix'], ['reply', 'Reply'], ['done', 'Done']];
  let snapshot = null;

  PRR.app = {
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
      const entries = (PRR.views[scope] && PRR.views[scope].help) || [];
      overlay.innerHTML = '<div class="help-card"><h3>Keyboard shortcuts</h3><table>' +
        entries.map(function (e) {
          return '<tr><td>' + e[0].split(' / ').map(function (k) { return '<kbd>' + PRR.esc(k) + '</kbd>'; }).join(' / ') +
            '</td><td>' + PRR.esc(e[1]) + '</td></tr>';
        }).join('') + '</table></div>';
      overlay.hidden = false;
      overlay.addEventListener('click', function () { overlay.hidden = true; }, { once: true });
    },
  };

  function labelFor(key) {
    const pools = [];
    if (snapshot.reply.payload) pools.push(snapshot.reply.payload);
    if (snapshot.triage.payload) pools.push(snapshot.triage.payload);
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
    const posted = result.posted || [];
    const errors = result.errors || [];
    const resolved = result.resolved || [];
    const fixes = fixDoneEvents();

    let html = '<div class="view"><header><h1>' +
      (cancelled ? (timedOut ? 'Session timed out' : 'Session cancelled') : 'All done') + '</h1>' +
      '<div class="sub"><b>' + PRR.esc(snapshot.repo ? snapshot.repo.nameWithOwner : '') +
      '#' + (snapshot.pr ? snapshot.pr.number : '') + '</b> · return to the Claude session for the summary</div></header>';

    if (cancelled) {
      html += '<div class="banner ' + (timedOut ? 'warn' : 'ok') + '">' +
        (timedOut ? 'The session window elapsed.' : 'Cancelled — no replies were posted.') +
        (fixes.length ? ' Fix commits already pushed remain on the branch.' : '') + '</div>';
    } else {
      html += '<div class="banner ' + (errors.length ? 'warn' : 'ok') + '">' +
        PRR.plural(posted.length, 'reply') + ' posted' +
        (resolved.length ? ', ' + PRR.plural(resolved.length, 'thread') + ' resolved' : '') +
        (errors.length ? ', ' + errors.length + ' failed' : '') + '.</div>';
    }

    const rows = [];
    fixes.forEach(function (e) {
      rows.push('<div class="trow"><span class="t-icon ok">✓</span><span class="t-label">' +
        PRR.esc(labelFor(e.item)) + '</span><span class="t-meta"><span class="badge fixed">' +
        PRR.esc(e.sha || '') + '</span>' + PRR.esc(e.summary || '') + '</span></div>');
    });
    posted.forEach(function (p) {
      rows.push('<div class="trow"><span class="t-icon ok">✓</span><span class="t-label">' +
        PRR.esc(labelFor(p.key)) + '</span><span class="t-meta">' +
        (p.url && p.url !== '(dry-run)'
          ? '<a href="' + PRR.esc(p.url) + '" target="_blank" rel="noopener">view reply</a>'
          : 'dry run') + '</span></div>');
    });
    errors.forEach(function (e) {
      rows.push('<div class="trow"><span class="t-icon err">✗</span><span class="t-label">' +
        PRR.esc(labelFor(e.key)) + '</span><span class="t-meta">' + PRR.esc(e.error || '') + '</span></div>');
    });
    if (rows.length) html += '<div class="summary-list">' + rows.join('') + '</div>';
    html += '</div>';
    PRR.html(app, html);

    PRR.html(document.getElementById('footer'),
      PRR.app.stepper() +
      '<span class="footer-note">this tab can be closed</span>' +
      '<button id="close-tab">Close tab</button>');
    document.getElementById('close-tab').addEventListener('click', function () { window.close(); });
    PRR.keys.setScope(null);

    if (!cancelled && !errors.length) PRR.store.clear();
  }

  function render() {
    const view = PRR.views[snapshot.phase];
    if (snapshot.phase === 'done' || snapshot.phase === 'cancelled') renderFinal();
    else if (view) view.render(snapshot);
    document.title = 'PR #' + (snapshot.pr ? snapshot.pr.number : '') + ' — ' +
      ({ triage: 'Triage', fixing: 'Fixing', reply: 'Replies', done: 'Done', cancelled: 'Cancelled' })[snapshot.phase];
  }

  function refetchAndRender() {
    return PRR.api.get('state').then(function (fresh) {
      snapshot = fresh;
      render();
    }).catch(function () {
      PRR.banner('err', 'Lost connection to the session server. If it was restarted, this page will reconnect automatically.');
    });
  }

  function maybeAutoClose() {
    if (PRR.store.pref('autoclose') === false) return;
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
    const view = snapshot && PRR.views[snapshot.phase];
    if (view && view.onEvent) view.onEvent(e, snapshot);
  }

  PRR.api.get('state').then(function (s) {
    snapshot = s;
    PRR.store.init(s.repo ? s.repo.nameWithOwner : 'unknown', s.pr ? s.pr.number : 0);
    render();
    PRR.connectSse(s.lastSeq, onEvent);
  }).catch(function (e) {
    PRR.html(document.getElementById('app'),
      '<div class="banner err">Could not load the session: ' + PRR.esc(e.message) +
      ' — is the server still running?</div>');
  });
})();
