'use strict';
/* Triage view — decide fix / reply / skip per item, with filtering, batch
 * actions, file grouping and keyboard-first navigation. */
(function () {
  const FILTER_CHIPS = [
    ['all', 'All'], ['fix', 'Fix'], ['reply', 'Reply'], ['skip', 'Skip'], ['outdated', 'Outdated'],
  ];

  function defaultAction(item, snapshot) {
    return item.suggestedAction || snapshot.config.defaultTriageAction || 'reply';
  }

  function seg(key, action) {
    const opts = [['fix', 'Fix'], ['reply', 'Reply only'], ['skip', 'Skip']];
    return '<div class="seg">' + opts.map(function (o) {
      return '<label><input type="radio" name="seg-' + PRR.esc(key) + '" value="' + o[0] + '"' +
        (o[0] === action ? ' checked' : '') + '><span>' + o[1] + '</span></label>';
    }).join('') + '</div>';
  }

  function confBadge(item) {
    if (!item.confidence) return '';
    return '<span class="badge conf conf-' + item.confidence + '">' + item.confidence + ' confidence</span>';
  }

  function searchText(item) {
    const comments = item.comments || [{ author: item.author, body: item.body }];
    return [item.path || 'general']
      .concat(comments.map(function (c) { return c.author + ' ' + c.body; }))
      .join(' ').toLowerCase();
  }

  function controlsHtml(snapshot, item, key) {
    return '<div class="controls">' +
      (item.fixPlan
        ? '<div class="fixplan"><span class="label">Claude’s proposed fix</span>' + PRR.renderMarkdown(item.fixPlan) + '</div>'
        : '') +
      (item.proposedDiff
        ? '<div class="sketch"><span class="label">Claude’s sketch — not yet applied</span>' + PRR.renderDiff(item.proposedDiff) + '</div>'
        : '') +
      seg(key, defaultAction(item, snapshot)) +
      '<textarea data-guidance="' + PRR.esc(key) + '" placeholder="Optional guidance for Claude (how to fix, what to say…)"></textarea>' +
      '</div>';
  }

  function threadCard(snapshot, t) {
    const key = PRR.itemKey(t);
    return '<div class="card" data-card="' + PRR.esc(key) + '" data-outdated="' + (t.isOutdated ? 1 : 0) + '">' +
      '<div class="card-head">' + PRR.locBadge(t) +
      (t.isOutdated ? '<span class="badge warn">outdated</span>' : '') +
      confBadge(t) + '</div>' +
      (t.diffHunk ? '<details class="hunk" open><summary>diff context</summary>' + PRR.renderDiff(t.diffHunk) + '</details>' : '') +
      PRR.renderComments(snapshot, t.comments) +
      controlsHtml(snapshot, t, key) + '</div>';
  }

  function issueCard(snapshot, c) {
    const key = PRR.itemKey(c);
    return '<div class="card" data-card="' + PRR.esc(key) + '" data-outdated="0">' +
      '<div class="card-head"><span class="badge">general comment</span>' + confBadge(c) + '</div>' +
      PRR.renderComments(snapshot, [c]) +
      controlsHtml(snapshot, c, key) + '</div>';
  }

  PRR.views.triage = {
    ring: null,

    allItems: function (snapshot) {
      const P = snapshot.triage.payload;
      return P.reviewThreads.map(function (t) { return { kind: 'review', item: t, key: PRR.itemKey(t) }; })
        .concat(P.issueComments.map(function (c) { return { kind: 'issue', item: c, key: PRR.itemKey(c) }; }));
    },

    getAction: function (key) {
      const checked = document.querySelector('input[name="seg-' + CSS.escape(key) + '"]:checked');
      return checked ? checked.value : 'skip';
    },

    setAction: function (key, action) {
      const input = document.querySelector('input[name="seg-' + CSS.escape(key) + '"][value="' + action + '"]');
      if (input) input.checked = true;
    },

    getGuidance: function (key) {
      const el = document.querySelector('textarea[data-guidance="' + CSS.escape(key) + '"]');
      return el ? el.value : '';
    },

    render: function (snapshot) {
      const self = this;
      const P = snapshot.triage.payload;
      const app = document.getElementById('app');

      const byFile = {};
      P.reviewThreads.forEach(function (t) { (byFile[t.path] = byFile[t.path] || []).push(t); });
      const files = Object.keys(byFile).sort();

      let html =
        '<div class="view"><header><h1><a href="' + PRR.esc(P.pr.url) + '" target="_blank" rel="noopener">' + PRR.esc(P.pr.title) + '</a></h1>' +
        '<div class="sub"><a href="' + PRR.esc(P.pr.url) + '" target="_blank" rel="noopener">' +
        PRR.esc(P.repo.nameWithOwner) + '#' + P.pr.number + '</a> by ' + PRR.esc(P.pr.author) +
        ' · ' + PRR.plural(P.reviewThreads.length, 'review thread') +
        ' · ' + PRR.plural(P.issueComments.length, 'general comment') +
        ' · <b>choose what Claude should do</b> · <kbd>?</kbd> shortcuts</div></header>';

      html += '<div class="toolbar"><div class="row">' +
        '<input class="filter" id="filter" placeholder="Filter by file, author, text…  ( / )">' +
        FILTER_CHIPS.map(function (c) {
          return '<span class="chip' + (c[0] === 'all' ? ' active' : '') + '" data-chip="' + c[0] + '">' + c[1] + '</span>';
        }).join('') +
        '<span class="match-count" id="match-count"></span></div>' +
        '<div class="row">' +
        '<button class="small" id="batch-suggest">Accept all suggestions</button>' +
        '<button class="small" id="batch-skip-outdated">Skip all outdated</button>' +
        '<span class="footer-note">set filtered to:</span>' +
        '<button class="small" data-batch="fix">Fix</button>' +
        '<button class="small" data-batch="reply">Reply</button>' +
        '<button class="small" data-batch="skip">Skip</button>' +
        '</div></div>';

      html += files.map(function (f) {
        return '<div class="file-group" data-file="' + PRR.esc(f) + '">' +
          '<div class="file-head">' + PRR.esc(f) + ' <span class="n">· ' + PRR.plural(byFile[f].length, 'thread') + '</span></div>' +
          byFile[f].map(function (t) { return threadCard(snapshot, t); }).join('') + '</div>';
      }).join('');
      if (!files.length) html += '<h2>Review threads</h2><p class="empty">No unresolved review threads.</p>';

      html += '<h2>General comments</h2>';
      html += P.issueComments.length
        ? P.issueComments.map(function (c) { return issueCard(snapshot, c); }).join('')
        : '<p class="empty">No general comments.</p>';
      html += '</div>';
      PRR.html(app, html);

      // search text cached per card
      this.allItems(snapshot).forEach(function (it) {
        const card = document.querySelector('.card[data-card="' + CSS.escape(it.key) + '"]');
        if (card) card.dataset.search = searchText(it.item);
      });

      this.renderFooter(snapshot);
      this.wire(snapshot);
      this.restoreDrafts(snapshot);
      this.updateFooter(snapshot);
    },

    renderFooter: function (snapshot) {
      const footer = document.getElementById('footer');
      PRR.html(footer,
        PRR.app.stepper() +
        (snapshot.noPost ? '<span class="footer-note">dry run — nothing will be posted</span>' : '') +
        '<button id="cancel">Cancel session</button>' +
        '<button id="submit" class="primary"></button>');
    },

    wire: function (snapshot) {
      const self = this;
      const app = document.getElementById('app');
      this.ring = PRR.focusRing();

      // filtering
      const filterInput = document.getElementById('filter');
      let chip = 'all';
      function applyFilter() {
        const q = filterInput.value.trim().toLowerCase();
        let shown = 0;
        document.querySelectorAll('.card[data-card]').forEach(function (card) {
          const key = card.dataset.card;
          const action = self.getAction(key);
          let ok = !q || (card.dataset.search || '').indexOf(q) !== -1;
          if (ok && chip === 'outdated') ok = card.dataset.outdated === '1';
          else if (ok && chip !== 'all') ok = action === chip;
          card.classList.toggle('hidden', !ok);
          if (ok) shown++;
        });
        document.querySelectorAll('.file-group').forEach(function (g) {
          g.style.display = g.querySelector('.card:not(.hidden)') ? '' : 'none';
        });
        document.getElementById('match-count').textContent =
          q || chip !== 'all' ? shown + ' shown' : '';
        self.ring.reset();
      }
      filterInput.addEventListener('input', applyFilter);
      document.querySelectorAll('.chip').forEach(function (el) {
        el.addEventListener('click', function () {
          chip = el.dataset.chip;
          document.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('active', c === el); });
          applyFilter();
        });
      });

      // batch actions
      document.getElementById('batch-suggest').addEventListener('click', function () {
        self.allItems(snapshot).forEach(function (it) {
          self.setAction(it.key, defaultAction(it.item, snapshot));
        });
        self.afterChange(snapshot);
      });
      document.getElementById('batch-skip-outdated').addEventListener('click', function () {
        document.querySelectorAll('.card[data-outdated="1"]').forEach(function (card) {
          self.setAction(card.dataset.card, 'skip');
        });
        self.afterChange(snapshot);
      });
      document.querySelectorAll('[data-batch]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          document.querySelectorAll('.card[data-card]:not(.hidden)').forEach(function (card) {
            self.setAction(card.dataset.card, btn.dataset.batch);
          });
          self.afterChange(snapshot);
        });
      });

      // live updates + persistence
      const persist = PRR.debounce(function () { self.persist(snapshot); }, 300);
      app.addEventListener('change', function () { self.updateFooter(snapshot); persist(); });
      app.addEventListener('input', function () { self.updateFooter(snapshot); persist(); });

      // submit / cancel
      document.getElementById('submit').addEventListener('click', function () { self.submit(snapshot); });
      document.getElementById('cancel').addEventListener('click', function () {
        self.lock('Cancelling…');
        PRR.api.post('triage/cancel').catch(function () { /* terminal state arrives over SSE */ });
      });

      // keyboard
      PRR.keys.register('triage', {
        'j': function () { self.ring.move(1); },
        'k': function () { self.ring.move(-1); },
        'arrowdown': function () { self.ring.move(1); },
        'arrowup': function () { self.ring.move(-1); },
        '1': function () { self.actOnFocused('fix', snapshot); },
        '2': function () { self.actOnFocused('reply', snapshot); },
        '3': function () { self.actOnFocused('skip', snapshot); },
        'e': function () {
          const card = self.ring.current();
          const ta = card && card.querySelector('textarea');
          if (ta) ta.focus();
        },
        'o': function () {
          const card = self.ring.current();
          const d = card && card.querySelector('details');
          if (d) d.open = !d.open;
        },
        '/': function () { filterInput.focus(); },
        '?': function () { PRR.app.toggleHelp('triage'); },
        'escape': function () {
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
          PRR.app.toggleHelp(false);
        },
        'mod+enter': function () { self.submit(snapshot); },
      });
      PRR.keys.setScope('triage');
    },

    actOnFocused: function (action, snapshot) {
      const card = this.ring.current();
      if (!card) return;
      this.setAction(card.dataset.card, action);
      this.updateFooter(snapshot);
      this.persist(snapshot);
    },

    afterChange: function (snapshot) {
      this.updateFooter(snapshot);
      this.persist(snapshot);
    },

    counts: function (snapshot) {
      const self = this;
      const c = { fix: 0, reply: 0, skip: 0 };
      this.allItems(snapshot).forEach(function (it) { c[self.getAction(it.key)]++; });
      return c;
    },

    updateFooter: function (snapshot) {
      const c = this.counts(snapshot);
      const btn = document.getElementById('submit');
      if (btn) btn.textContent = 'Continue · ' + c.fix + ' fix · ' + c.reply + ' reply · ' + c.skip + ' skip';
    },

    persist: function (snapshot) {
      const self = this;
      const triage = {};
      this.allItems(snapshot).forEach(function (it) {
        triage[it.key] = { action: self.getAction(it.key), guidance: self.getGuidance(it.key) };
      });
      PRR.store.save({ triage: triage });
    },

    restoreDrafts: function (snapshot) {
      const self = this;
      const saved = PRR.store.load().triage;
      if (!saved) return;
      const dirty = this.allItems(snapshot).some(function (it) {
        const s = saved[it.key];
        return s && (s.guidance || s.action !== defaultAction(it.item, snapshot));
      });
      if (!dirty) return;
      const banner = PRR.banner('warn',
        'Found triage edits from ' + PRR.relTime(PRR.store.load().savedAt) + '.',
        '<button class="small" id="restore-yes">Restore</button><button class="small" id="restore-no">Dismiss</button>');
      banner.querySelector('#restore-yes').addEventListener('click', function () {
        self.allItems(snapshot).forEach(function (it) {
          const s = saved[it.key];
          if (!s) return;
          self.setAction(it.key, s.action);
          const ta = document.querySelector('textarea[data-guidance="' + CSS.escape(it.key) + '"]');
          if (ta && s.guidance) ta.value = s.guidance;
        });
        self.updateFooter(snapshot);
        banner.remove();
      });
      banner.querySelector('#restore-no').addEventListener('click', function () { banner.remove(); });
    },

    lock: function (msg) {
      document.getElementById('submit').disabled = true;
      document.getElementById('cancel').disabled = true;
      if (msg) document.getElementById('submit').textContent = msg;
      document.querySelectorAll('#app input, #app textarea, #app button').forEach(function (el) { el.disabled = true; });
    },

    submit: function (snapshot) {
      const self = this;
      if (document.getElementById('submit').disabled) return;
      const decisions = this.allItems(snapshot).map(function (it) {
        const d = { kind: it.kind, action: self.getAction(it.key), guidance: self.getGuidance(it.key).trim() };
        if (it.kind === 'review') d.threadId = it.item.id;
        else d.databaseId = it.item.databaseId;
        return d;
      });
      this.lock('Submitting…');
      PRR.api.post('triage/submit', { decisions: decisions }).catch(function (e) {
        PRR.banner('err', 'Failed to submit: ' + PRR.esc(e.message) + ' — is the session still running?');
        document.getElementById('submit').disabled = false;
        document.getElementById('cancel').disabled = false;
        self.updateFooter(snapshot);
        document.querySelectorAll('#app input, #app textarea, #app button').forEach(function (el) { el.disabled = false; });
      });
      // success path: the phase SSE event swaps the view to progress
    },

    onEvent: function () { /* triage has no live server events to render */ },

    help: [
      ['j / k', 'next / previous comment'],
      ['1 / 2 / 3', 'set Fix / Reply / Skip'],
      ['e', 'edit guidance'],
      ['o', 'toggle diff'],
      ['/', 'filter'],
      ['⌘↩', 'continue'],
      ['?', 'toggle this help'],
    ],
  };
})();
