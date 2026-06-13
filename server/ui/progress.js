'use strict';
/* Progress view — live timeline while Claude implements the approved fixes.
 * Fed by skill-emitted events (fix_start/fix_done/…); lossless across refresh
 * because the snapshot replays events.jsonl. */
(function () {
  const FIX_EVENTS = ['fix_start', 'fix_done', 'fix_fail', 'fix_skip'];
  const ACTIVITY = FIX_EVENTS.concat(['check', 'push', 'drafting', 'note']);
  const STALL_MS = 3 * 60 * 1000;

  PRR.views.fixing = {
    model: null,
    stallTimer: null,

    fixItems: function (snapshot) {
      const decisions = (snapshot.triage.result && snapshot.triage.result.decisions) || [];
      const P = snapshot.triage.payload;
      const labels = {};
      (P ? P.reviewThreads : []).forEach(function (t) {
        labels[PRR.itemKey(t)] = t.path + (t.line != null ? ':' + t.line : '');
      });
      (P ? P.issueComments : []).forEach(function (c) {
        labels[PRR.itemKey(c)] = 'general comment by ' + c.author;
      });
      return decisions.filter(function (d) { return d.action === 'fix'; }).map(function (d) {
        const key = d.threadId ? 'review:' + d.threadId : 'issue:' + d.databaseId;
        return { key: key, label: labels[key] || key };
      });
    },

    render: function (snapshot) {
      const self = this;
      const app = document.getElementById('app');
      const items = this.fixItems(snapshot);
      const replyOnly = ((snapshot.triage.result && snapshot.triage.result.decisions) || [])
        .filter(function (d) { return d.action === 'reply'; }).length;

      this.model = { items: {}, checks: {}, push: null, drafting: false, notes: [] };
      items.forEach(function (it) { self.model.items[it.key] = { label: it.label, status: 'pending' }; });

      PRR.html(app,
        '<div class="view"><header><h1>Implementing fixes…</h1>' +
        '<div class="sub"><b>' + PRR.esc(snapshot.repo ? snapshot.repo.nameWithOwner : '') +
        '#' + (snapshot.pr ? snapshot.pr.number : '') + '</b> · Claude is working on ' +
        PRR.plural(items.length, 'approved fix') +
        (replyOnly ? ' · ' + PRR.plural(replyOnly, 'reply-only item') + ' will be drafted after' : '') +
        '</div></header>' +
        '<div class="timeline" id="timeline"></div>' +
        '<div id="stall"></div></div>');

      PRR.html(document.getElementById('footer'),
        PRR.app.stepper() +
        '<span class="footer-note">you can keep this tab open — replies come next</span>' +
        '<button id="abort" class="danger">Abort remaining fixes</button>');

      const abortBtn = document.getElementById('abort');
      abortBtn.addEventListener('click', function () {
        abortBtn.disabled = true;
        PRR.api.post('fixing/abort').catch(function () { abortBtn.disabled = false; });
      });
      if (snapshot.abortRequested) this.markAborting();

      // replay persisted events, then live ones arrive over SSE
      (snapshot.fixing.events || []).forEach(function (e) { self.applyEvent(e, true); });
      this.renderTimeline();
      this.resetStall();

      PRR.keys.register('fixing', {
        '?': function () { PRR.app.toggleHelp('fixing'); },
        'escape': function () { PRR.app.toggleHelp(false); },
      });
      PRR.keys.setScope('fixing');
    },

    markAborting: function () {
      const btn = document.getElementById('abort');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Abort requested — stopping after current fix';
      }
    },

    applyEvent: function (e, replay) {
      const m = this.model;
      if (!m) return;
      if (FIX_EVENTS.indexOf(e.type) !== -1 && e.item) {
        const row = m.items[e.item] || (m.items[e.item] = { label: e.item, status: 'pending' });
        if (e.type === 'fix_start') row.status = 'running';
        if (e.type === 'fix_done') { row.status = 'done'; row.sha = e.sha; row.summary = e.summary; }
        if (e.type === 'fix_fail') { row.status = 'failed'; row.reason = e.reason; }
        if (e.type === 'fix_skip') { row.status = 'skipped'; row.reason = e.reason; }
      } else if (e.type === 'check' && e.name) {
        m.checks[e.name] = { status: e.status || 'running', detail: e.detail };
      } else if (e.type === 'push') {
        m.push = { status: e.status || 'ok', detail: e.detail };
      } else if (e.type === 'drafting') {
        m.drafting = true;
      } else if (e.type === 'note' && e.text) {
        m.notes.push(e.text);
        if (/abort requested/i.test(e.text)) this.markAborting();
      }
      if (!replay && ACTIVITY.indexOf(e.type) !== -1) {
        this.renderTimeline();
        this.resetStall();
      }
    },

    renderTimeline: function () {
      const m = this.model;
      const el = document.getElementById('timeline');
      if (!el || !m) return;
      let html = '';
      Object.keys(m.items).forEach(function (key) {
        const it = m.items[key];
        const icon = it.status === 'running' ? '<span class="spinner"></span>'
          : it.status === 'done' ? '<span class="t-icon ok">✓</span>'
          : it.status === 'failed' ? '<span class="t-icon err">✗</span>'
          : it.status === 'skipped' ? '<span class="t-icon muted">–</span>'
          : '<span class="t-icon muted">○</span>';
        html += '<div class="trow' + (it.status === 'pending' ? ' pending' : '') + '">' +
          '<span class="t-icon">' + icon + '</span>' +
          '<span class="t-label">' + PRR.esc(it.label) + '</span>' +
          '<span class="t-meta">' +
          (it.sha ? '<span class="badge fixed">' + PRR.esc(it.sha) + '</span>' : '') +
          PRR.esc(it.summary || it.reason || '') + '</span></div>';
      });
      const checkNames = Object.keys(m.checks);
      if (checkNames.length) {
        html += '<div class="checks">' + checkNames.map(function (name) {
          const c = m.checks[name];
          const cls = c.status === 'pass' ? 'fixed' : c.status === 'fail' ? 'conf conf-low' : '';
          return '<span class="badge ' + cls + '">' + PRR.esc(name) + ': ' + PRR.esc(c.status) +
            (c.detail ? ' — ' + PRR.esc(c.detail) : '') + '</span>';
        }).join('') + '</div>';
      }
      if (m.push) {
        html += '<div class="trow"><span class="t-icon ' + (m.push.status === 'ok' ? 'ok' : 'err') + '">' +
          (m.push.status === 'ok' ? '✓' : '✗') + '</span><span class="t-meta">git push ' +
          (m.push.status === 'ok' ? 'succeeded' : 'failed') +
          (m.push.detail ? ' — ' + PRR.esc(m.push.detail) : '') + '</span></div>';
      }
      m.notes.forEach(function (n) {
        html += '<div class="trow"><span class="t-icon muted">·</span><span class="t-meta">' + PRR.esc(n) + '</span></div>';
      });
      if (m.drafting) {
        html += '<div class="trow"><span class="t-icon"><span class="spinner"></span></span>' +
          '<span class="t-meta">drafting replies…</span></div>';
      }
      el.innerHTML = html || '<div class="trow"><span class="t-meta">No fixes to implement — drafting replies…</span></div>';
    },

    resetStall: function () {
      const self = this;
      clearTimeout(this.stallTimer);
      const stall = document.getElementById('stall');
      if (stall) stall.innerHTML = '';
      this.stallTimer = setTimeout(function () {
        const el = document.getElementById('stall');
        if (el) {
          el.innerHTML = '<div class="banner warn stall-hint">No activity for a few minutes. ' +
            'Check the Claude session — if it stopped, re-run <code>/pr-replies</code> to resume, ' +
            'or abort the remaining fixes above.</div>';
        }
      }, STALL_MS);
    },

    onEvent: function (e) { this.applyEvent(e, false); },

    help: [
      ['?', 'toggle this help'],
    ],
  };
})();
