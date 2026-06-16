'use strict';
/* Reply view — review Claude's drafts, see the actual fix commits, edit with
 * markdown preview, then post. Posting streams per-item status over SSE;
 * partial failures stay on screen with Retry / Finish anyway. */
(function () {
  function seg2(key, include) {
    return '<div class="seg">' +
      '<label><input type="radio" name="seg-' + PRR.esc(key) + '" value="reply"' + (include ? ' checked' : '') + '><span>Reply</span></label>' +
      '<label><input type="radio" name="seg-' + PRR.esc(key) + '" value="skip"' + (include ? '' : ' checked') + '><span>Skip</span></label>' +
      '</div>';
  }

  function fixCommitHtml(snapshot, key, item) {
    const c = snapshot.reply.fixCommits && snapshot.reply.fixCommits[key];
    if (c) {
      return '<details class="hunk"><summary>fix commit <b>' + PRR.esc(c.sha) + '</b> — ' +
        PRR.esc(c.subject) + '</summary>' + PRR.renderDiff(c.diff) + '</details>';
    }
    if (item.fixedIn) {
      return '<details class="hunk"><summary>fixed in <b>' + PRR.esc(item.fixedIn) + '</b> (diff unavailable)</summary></details>';
    }
    return '';
  }

  function draftHtml(key, draft, hint) {
    return '<div class="draft-tools">' +
      '<button class="active" data-tab="edit" data-key="' + PRR.esc(key) + '">Edit</button>' +
      '<button data-tab="preview" data-key="' + PRR.esc(key) + '">Preview</button></div>' +
      '<textarea data-text="' + PRR.esc(key) + '" placeholder="Reply…">' + PRR.esc(draft || '') + '</textarea>' +
      '<div class="preview" data-preview="' + PRR.esc(key) + '" hidden></div>' +
      '<div class="hint">' + hint + '</div>';
  }

  function assigneeMentionRow(key) {
    return '<div class="assignee"><label>Assign</label>' +
      '<input list="prr-assignees" data-assignee="' + PRR.esc(key) + '" placeholder="teammate (optional)">' +
      '<label class="mention-label"><input type="checkbox" data-mention="' + PRR.esc(key) + '"> mention @ in reply</label></div>';
  }

  function threadCard(snapshot, t) {
    const key = PRR.itemKey(t);
    const autoResolve = snapshot.config.autoResolveFixedThreads;
    const resolveOn = t.resolveDefault != null ? t.resolveDefault : (!!t.fixedIn && t.viewerCanResolve && autoResolve);
    return '<div class="card" data-card="' + PRR.esc(key) + '">' +
      '<div class="card-head">' + PRR.locBadge(t) +
      (t.isOutdated ? '<span class="badge warn">outdated</span>' : '') +
      (t.fixedIn ? '<span class="badge fixed">fixed in ' + PRR.esc(t.fixedIn) + '</span>' : '') +
      '</div>' +
      '<details class="thread"><summary>original thread (' + PRR.plural(t.comments.length, 'comment') + ')</summary>' +
      (t.diffHunk ? PRR.renderDiff(t.diffHunk) : '') +
      PRR.renderComments(snapshot, t.comments) + '</details>' +
      fixCommitHtml(snapshot, key, t) +
      '<div class="controls">' + seg2(key, true) +
      draftHtml(key, t.draft, 'Empty reply = skipped. Markdown supported.') +
      '<div class="resolve-row' + (t.viewerCanResolve ? '' : ' disabled') + '"' +
      (t.viewerCanResolve ? '' : ' title="You cannot resolve this thread (no permission, or the thread is locked)"') + '>' +
      '<input type="checkbox" data-resolve="' + PRR.esc(key) + '"' +
      (resolveOn && t.viewerCanResolve ? ' checked' : '') + (t.viewerCanResolve ? '' : ' disabled') + '>' +
      ' Resolve thread after replying</div>' +
      assigneeMentionRow(key) +
      '</div></div>';
  }

  function issueCard(snapshot, c) {
    const key = PRR.itemKey(c);
    return '<div class="card" data-card="' + PRR.esc(key) + '">' +
      '<div class="card-head"><span class="badge">general comment</span>' +
      (c.fixedIn ? '<span class="badge fixed">fixed in ' + PRR.esc(c.fixedIn) + '</span>' : '') +
      '</div>' +
      '<details class="thread"><summary>original comment by ' + PRR.esc(c.author) + '</summary>' +
      PRR.renderComments(snapshot, [c]) + '</details>' +
      fixCommitHtml(snapshot, key, c) +
      '<div class="controls">' + seg2(key, true) +
      draftHtml(key, c.draft, 'Posts as a new top-level PR comment (GitHub has no threading here).') +
      assigneeMentionRow(key) +
      '</div></div>';
  }

  PRR.views.reply = {
    ring: null,
    posting: false,

    allItems: function (snapshot) {
      const P = snapshot.reply.payload;
      return P.reviewThreads.map(function (t) { return { kind: 'review', item: t, key: PRR.itemKey(t) }; })
        .concat(P.issueComments.map(function (c) { return { kind: 'issue', item: c, key: PRR.itemKey(c) }; }));
    },

    getAction: function (key) {
      const checked = document.querySelector('input[name="seg-' + CSS.escape(key) + '"]:checked');
      return checked ? checked.value : 'skip';
    },

    getText: function (key) {
      const el = document.querySelector('textarea[data-text="' + CSS.escape(key) + '"]');
      return el ? el.value : '';
    },

    isPosted: function (snapshot, key) {
      const s = snapshot.reply.itemStatus && snapshot.reply.itemStatus[key];
      return !!(s && s.status === 'posted');
    },

    // Posted, or interrupted by a crash mid-post (may already be on GitHub).
    // Either way the item is locked: never re-send it automatically.
    isLocked: function (snapshot, key) {
      const s = snapshot.reply.itemStatus && snapshot.reply.itemStatus[key];
      return !!(s && (s.status === 'posted' || s.status === 'interrupted'));
    },

    render: function (snapshot, opts) {
      const self = this;
      const P = snapshot.reply.payload;
      const app = document.getElementById('app');

      const mode = PRR.groupBy();
      const groups = PRR.groupThreads(P.reviewThreads, mode);
      const assignees = (P.pr && P.pr.assignableUsers) || [];

      let html =
        '<div class="view"><header><h1><a href="' + PRR.esc(P.pr.url) + '" target="_blank" rel="noopener">' + PRR.esc(P.pr.title) + '</a></h1>' +
        '<div class="sub"><a href="' + PRR.esc(P.pr.url) + '" target="_blank" rel="noopener">' +
        PRR.esc(P.repo.nameWithOwner) + '#' + P.pr.number + '</a>' +
        ' · <b>review and send replies</b> · <kbd>?</kbd> shortcuts</div></header>';

      html += '<div class="toolbar"><div class="row"><span class="spacer"></span>' + PRR.groupSeg(mode) + '</div></div>';
      html += '<datalist id="prr-assignees">' +
        assignees.map(function (a) { return '<option value="' + PRR.esc(a) + '"></option>'; }).join('') + '</datalist>';

      html += groups.map(function (g) {
        return '<div class="file-group">' + PRR.groupHeader(g, mode, snapshot) +
          g.threads.map(function (t) { return threadCard(snapshot, t); }).join('') + '</div>';
      }).join('');
      if (!groups.length) html += '<h2>Review threads</h2><p class="empty">No review threads.</p>';

      html += '<h2>General comments</h2>';
      html += P.issueComments.length
        ? P.issueComments.map(function (c) { return issueCard(snapshot, c); }).join('')
        : '<p class="empty">No general comments.</p>';
      html += '</div>';
      PRR.html(app, html);

      this.renderFooter(snapshot);
      this.wire(snapshot);
      this.restoreDrafts(snapshot, { silent: !!(opts && opts.silentRestore) });

      // refresh mid- or post-posting: replay item statuses
      Object.keys(snapshot.reply.itemStatus || {}).forEach(function (key) {
        self.showStatus(key, snapshot.reply.itemStatus[key]);
      });
      this.updateFooter(snapshot);
    },

    renderFooter: function (snapshot) {
      const autoClose = PRR.store.pref('autoclose');
      PRR.html(document.getElementById('footer'),
        PRR.app.stepper() +
        (snapshot.noPost ? '<span class="footer-note">dry run — nothing will be posted</span>' : '') +
        (snapshot.config.signature ? '<span class="footer-note">signature appended automatically</span>' : '') +
        '<label class="autoclose" title="Close this tab automatically when the session finishes">' +
        '<input type="checkbox" id="autoclose"' + (autoClose === '0' ? '' : ' checked') + '> Auto-close tab</label>' +
        '<span id="extra-actions"></span>' +
        '<button id="cancel">Cancel — post nothing</button>' +
        '<button id="submit" class="primary"></button>');
      document.getElementById('autoclose').addEventListener('change', function (ev) {
        PRR.store.pref('autoclose', ev.target.checked);
      });
    },

    wire: function (snapshot) {
      const self = this;
      const app = document.getElementById('app');
      self._snap = snapshot;
      this.ring = PRR.focusRing();

      // Delegated #app listeners survive innerHTML re-renders, so attach once
      // (a group-by toggle re-renders into the same #app). They read self._snap.
      if (!this._wired) {
        this._wired = true;
        app.addEventListener('click', function (ev) {
          const btn = ev.target.closest('.draft-tools button');
          if (!btn) return;
          const key = btn.dataset.key;
          const ta = document.querySelector('textarea[data-text="' + CSS.escape(key) + '"]');
          const pv = document.querySelector('[data-preview="' + CSS.escape(key) + '"]');
          const isPreview = btn.dataset.tab === 'preview';
          btn.parentElement.querySelectorAll('button').forEach(function (b) {
            b.classList.toggle('active', b === btn);
          });
          ta.hidden = isPreview;
          pv.hidden = !isPreview;
          if (isPreview) pv.innerHTML = PRR.renderMarkdown(ta.value) || '<span class="empty">nothing to preview</span>';
        });
        const persist = PRR.debounce(function () { self.persist(self._snap); }, 300);
        app.addEventListener('change', function () { self.updateFooter(self._snap); persist(); });
        app.addEventListener('input', function () { self.updateFooter(self._snap); persist(); });
      }

      document.querySelectorAll('input[name="groupby"]').forEach(function (el) {
        el.addEventListener('change', function () {
          self.persist(self._snap);
          PRR.store.pref('groupby', el.value);
          self.render(self._snap, { silentRestore: true });
        });
      });

      document.getElementById('submit').addEventListener('click', function () { self.submit(self._snap, false); });
      document.getElementById('cancel').addEventListener('click', function () {
        self.lock('Cancelling…');
        PRR.api.post('reply/cancel').catch(function () { /* terminal arrives over SSE */ });
      });

      PRR.keys.register('reply', {
        'j': function () { self.ring.move(1); },
        'k': function () { self.ring.move(-1); },
        'arrowdown': function () { self.ring.move(1); },
        'arrowup': function () { self.ring.move(-1); },
        '1': function () { self.setFocusedAction('reply', snapshot); },
        '2': function () { self.setFocusedAction('skip', snapshot); },
        'e': function () {
          const card = self.ring.current();
          const ta = card && card.querySelector('textarea');
          if (ta && !ta.hidden) ta.focus();
        },
        'p': function () {
          const card = self.ring.current();
          if (!card) return;
          const tabs = card.querySelectorAll('.draft-tools button');
          const target = card.querySelector('.draft-tools button.active[data-tab="edit"]') ? tabs[1] : tabs[0];
          if (target) target.click();
        },
        'x': function () {
          const card = self.ring.current();
          const cb = card && card.querySelector('input[type="checkbox"][data-resolve]');
          if (cb && !cb.disabled) {
            cb.checked = !cb.checked;
            self.persist(snapshot);
          }
        },
        'o': function () {
          const card = self.ring.current();
          const d = card && card.querySelector('details');
          if (d) d.open = !d.open;
        },
        't': function () {
          const card = self.ring.current();
          if (!card) return;
          const ta = card.querySelector('textarea[data-text]');
          if (!ta || ta.hidden) return;
          const it = self.allItems(snapshot).find(function (x) { return x.key === card.dataset.card; });
          PRR.templates.openPicker(ta, 'reply', it ? PRR.templateCtx(it.item, snapshot) : {});
        },
        '?': function () { PRR.app.toggleHelp('reply'); },
        'escape': function () {
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
          PRR.app.toggleHelp(false);
        },
        'mod+enter': function () { self.submit(snapshot, false); },
      });
      PRR.keys.setScope('reply');
    },

    setFocusedAction: function (action, snapshot) {
      const card = this.ring.current();
      if (!card) return;
      const input = card.querySelector('input[name="seg-' + CSS.escape(card.dataset.card) + '"][value="' + action + '"]');
      if (input && !input.disabled) input.checked = true;
      this.updateFooter(snapshot);
      this.persist(snapshot);
    },

    pending: function (snapshot) {
      const self = this;
      return this.allItems(snapshot).filter(function (it) {
        return !self.isLocked(snapshot, it.key) &&
          self.getAction(it.key) === 'reply' && self.getText(it.key).trim();
      });
    },

    failedKeys: function (snapshot) {
      const st = snapshot.reply.itemStatus || {};
      return Object.keys(st).filter(function (k) { return st[k].status === 'failed'; });
    },

    updateFooter: function (snapshot) {
      const btn = document.getElementById('submit');
      if (!btn || this.posting) return;
      const n = this.pending(snapshot).length;
      const failed = this.failedKeys(snapshot).length;
      btn.textContent = failed ? 'Retry failed · ' + PRR.plural(n, 'reply') : 'Send ' + PRR.plural(n, 'reply');
      btn.disabled = n === 0;
      const extra = document.getElementById('extra-actions');
      if (extra && failed && !extra.firstChild) {
        const finish = document.createElement('button');
        finish.textContent = 'Finish anyway';
        finish.addEventListener('click', function () {
          PRR.api.post('reply/finish').catch(function (e) { PRR.banner('err', PRR.esc(e.message)); });
        });
        extra.appendChild(finish);
      }
    },

    getAssignee: function (key) {
      const el = document.querySelector('input[data-assignee="' + CSS.escape(key) + '"]');
      return el ? el.value.trim() : '';
    },

    getMention: function (key) {
      const el = document.querySelector('input[data-mention="' + CSS.escape(key) + '"]');
      return !!(el && el.checked);
    },

    persist: function (snapshot) {
      const self = this;
      const reply = {};
      this.allItems(snapshot).forEach(function (it) {
        const cb = document.querySelector('input[data-resolve="' + CSS.escape(it.key) + '"]');
        reply[it.key] = {
          draft: self.getText(it.key),
          include: self.getAction(it.key) === 'reply',
          resolve: cb ? cb.checked : false,
          assignee: self.getAssignee(it.key),
          mention: self.getMention(it.key),
        };
      });
      PRR.store.save({ reply: reply });
      PRR.api.post('data/decisions', { reply: reply }).catch(function () {});
    },

    applySaved: function (snapshot, saved) {
      const self = this;
      this.allItems(snapshot).forEach(function (it) {
        const s = saved[it.key];
        if (!s || self.isPosted(snapshot, it.key)) return;
        const ta = document.querySelector('textarea[data-text="' + CSS.escape(it.key) + '"]');
        if (ta && s.draft) ta.value = s.draft;
        const input = document.querySelector('input[name="seg-' + CSS.escape(it.key) + '"][value="' + (s.include === false ? 'skip' : 'reply') + '"]');
        if (input) input.checked = true;
        const cb = document.querySelector('input[data-resolve="' + CSS.escape(it.key) + '"]');
        if (cb && !cb.disabled) cb.checked = !!s.resolve;
        const ai = document.querySelector('input[data-assignee="' + CSS.escape(it.key) + '"]');
        if (ai && s.assignee) ai.value = s.assignee;
        const mn = document.querySelector('input[data-mention="' + CSS.escape(it.key) + '"]');
        if (mn) mn.checked = !!s.mention;
      });
      this.updateFooter(snapshot);
    },

    restoreDrafts: function (snapshot, opts) {
      const self = this;
      const saved = PRR.store.load().reply;
      if (!saved) return;
      if (opts && opts.silent) { this.applySaved(snapshot, saved); return; }
      const dirty = this.allItems(snapshot).some(function (it) {
        const s = saved[it.key];
        return s && ((s.draft && s.draft !== (it.item.draft || '')) || s.assignee);
      });
      if (!dirty) return;
      const banner = PRR.banner('warn',
        'Found reply edits from ' + PRR.relTime(PRR.store.load().savedAt) + '.',
        '<button class="small" id="restore-yes">Restore</button><button class="small" id="restore-no">Dismiss</button>');
      banner.querySelector('#restore-yes').addEventListener('click', function () {
        self.applySaved(snapshot, saved);
        banner.remove();
      });
      banner.querySelector('#restore-no').addEventListener('click', function () { banner.remove(); });
    },

    lock: function (msg) {
      this.posting = true;
      const btn = document.getElementById('submit');
      btn.disabled = true;
      if (msg) btn.textContent = msg;
      document.getElementById('cancel').disabled = true;
      // Keep the auto-close checkbox usable so the user can opt out mid-posting.
      document.querySelectorAll('#app input, #app textarea, #app .draft-tools button')
        .forEach(function (el) { el.disabled = true; });
    },

    unlock: function (snapshot) {
      this.posting = false;
      document.getElementById('cancel').disabled = false;
      const self = this;
      document.querySelectorAll('#app input, #app textarea, #app .draft-tools button')
        .forEach(function (el) {
          const card = el.closest('.card');
          if (card && self.isPosted(snapshot, card.dataset.card)) return; // posted items stay locked
          el.disabled = false;
        });
      this.updateFooter(snapshot);
    },

    submit: function (snapshot, retryOnly) {
      const self = this;
      if (this.posting) return;
      const items = this.pending(snapshot);
      if (!items.length) return;
      const replies = [], skipped = [];
      this.allItems(snapshot).forEach(function (it) {
        if (self.isLocked(snapshot, it.key)) return;
        let body = self.getText(it.key).trim();
        const include = self.getAction(it.key) === 'reply' && body;
        if (include) {
          // Opt-in @-mention: prepend the assignee unless it's already there.
          const assignee = self.getAssignee(it.key);
          if (assignee && self.getMention(it.key) && body.indexOf('@' + assignee) === -1) {
            body = '@' + assignee + ' ' + body;
          }
          const r = { kind: it.kind, key: it.key, body: body };
          if (it.kind === 'review') {
            r.threadId = it.item.id;
            r.replyToDatabaseId = it.item.replyToDatabaseId;
            r.path = it.item.path;
            r.line = it.item.line;
            const cb = document.querySelector('input[data-resolve="' + CSS.escape(it.key) + '"]');
            r.resolve = !!(cb && cb.checked);
          }
          replies.push(r);
        } else {
          const s = { kind: it.kind, key: it.key };
          if (it.kind === 'review') { s.threadId = it.item.id; s.path = it.item.path; s.line = it.item.line; }
          else s.databaseId = it.item.databaseId;
          skipped.push(s);
        }
      });
      this.lock('Posting ' + PRR.plural(replies.length, 'reply') + '…');
      PRR.api.post('reply/submit', { replies: replies, skipped: skipped }).catch(function (e) {
        PRR.banner('err', 'Failed to submit: ' + PRR.esc(e.message) + ' — is the session still running?');
        self.unlock(snapshot);
      });
      // per-item progress + post_done arrive over SSE
    },

    showStatus: function (key, s) {
      const card = document.querySelector('.card[data-card="' + CSS.escape(key) + '"]');
      if (!card) return;
      let line = card.querySelector('.status-line');
      if (!line) {
        line = document.createElement('div');
        card.appendChild(line);
      }
      line.className = 'status-line ' + s.status;
      if (s.status === 'posting') line.innerHTML = '<span class="spinner"></span> posting…';
      else if (s.status === 'retrying') line.innerHTML = '<span class="spinner"></span> retrying (attempt ' + PRR.esc(s.attempt) + ') — ' + PRR.esc(s.error || '');
      else if (s.status === 'posted') {
        line.innerHTML = '✓ Posted' + (s.url && s.url !== '(dry-run)'
          ? ' — <a href="' + PRR.esc(s.url) + '" target="_blank" rel="noopener">view on GitHub</a>'
          : ' (dry run)');
        card.querySelectorAll('input, textarea, .draft-tools button').forEach(function (el) { el.disabled = true; });
      } else if (s.status === 'interrupted') {
        line.innerHTML = '⚠ Interrupted by a restart — this reply <b>may already be on GitHub</b>. ' +
          'Check the thread before re-sending; it will not be posted again automatically.';
        card.querySelectorAll('input, textarea, .draft-tools button').forEach(function (el) { el.disabled = true; });
      } else if (s.status === 'failed') line.textContent = '✗ Failed: ' + (s.error || 'unknown error');
    },

    showResolve: function (key, s) {
      const card = document.querySelector('.card[data-card="' + CSS.escape(key) + '"]');
      if (!card) return;
      const line = document.createElement('div');
      line.className = 'status-line ' + (s.status === 'resolved' ? 'posted' : 'failed');
      line.textContent = s.status === 'resolved'
        ? '✓ Thread resolved'
        : '✗ Could not resolve thread: ' + (s.error || '');
      card.appendChild(line);
    },

    onEvent: function (e, snapshot) {
      if (e.type === 'post_item') this.showStatus(e.key, e);
      else if (e.type === 'resolve_item') this.showResolve(e.key, e);
      else if (e.type === 'post_done') {
        // update local statuses from the event totals; snapshot refresh happens
        // on phase change. Failures keep us here with Retry / Finish anyway.
        snapshot.reply.itemStatus = snapshot.reply.itemStatus || {};
        if (e.failed > 0) {
          PRR.banner('err', e.failed + ' of ' + (e.failed + e.posted) +
            ' replies failed — edit and retry below, or finish anyway.');
          this.refreshStatuses(snapshot);
        }
        // success path: server finalizes → phase event renders the done view
      }
    },

    refreshStatuses: function (snapshot) {
      const self = this;
      PRR.api.get('state').then(function (fresh) {
        snapshot.reply.itemStatus = fresh.reply.itemStatus;
        self.unlock(snapshot);
      }).catch(function () { self.unlock(snapshot); });
    },

    help: [
      ['j / k', 'next / previous reply'],
      ['1 / 2', 'set Reply / Skip'],
      ['e', 'edit draft'],
      ['t', 'insert a template'],
      ['p', 'toggle markdown preview'],
      ['x', 'toggle resolve thread'],
      ['o', 'toggle thread / diff'],
      ['⌘↩', 'send replies'],
      ['?', 'toggle this help'],
    ],
  };
})();
