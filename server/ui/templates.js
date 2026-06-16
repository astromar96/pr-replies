'use strict';
/* Templates route — manage reusable reply snippets, plus the insert-picker
 * used from the triage guidance and reply draft textareas. User templates are
 * editable; per-repo templates (.pr-replies/templates.json) are read-only.
 * Variable substitution is escape-safe (text enters textarea.value). */
(function () {
  const SCOPES = [['reply', 'Reply'], ['guidance', 'Guidance'], ['both', 'Both']];

  // ---- shared cache + insert-picker (used by reply.js / triage.js) ----
  PRR.templates._cache = null;
  PRR.templates.invalidate = function () { PRR.templates._cache = null; };
  PRR.templates.load = function () {
    if (PRR.templates._cache) return Promise.resolve(PRR.templates._cache);
    return PRR.api.get('data/templates').then(function (d) {
      PRR.templates._cache = d.templates || [];
      return PRR.templates._cache;
    });
  };

  function insertAtCursor(ta, text) {
    ta.focus();
    const s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    const e = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.dispatchEvent(new Event('input', { bubbles: true })); // triggers the view's debounced persist
  }

  // scope filter: 'reply' field shows reply+both; 'guidance' field shows guidance+both.
  function matchesScope(t, scope) {
    const s = t.scope || 'reply';
    return !scope || s === scope || s === 'both';
  }

  PRR.templates.openPicker = function (textarea, scope, ctx) {
    if (PRR.templates._pickerOpen) return;   // one picker at a time (e.g. a second 't')
    PRR.templates._pickerOpen = true;
    PRR.templates.load().then(function (all) {
      const list = all.filter(function (t) { return matchesScope(t, scope); });
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      const rows = list.length
        ? list.map(function (t, i) {
            return '<button class="insert-row" data-i="' + i + '"><span class="ir-name">' + PRR.esc(t.name) + '</span>' +
              '<span class="ir-body">' + PRR.esc(PRR.templates.apply(t.body, ctx).replace(/\s+/g, ' ').slice(0, 140)) + '</span></button>';
          }).join('')
        : '<div class="empty" style="padding:8px 2px">No templates for this field yet — add some under <b>Templates</b>.</div>';
      overlay.innerHTML = '<div class="help-card insert-picker"><h3>Insert template</h3><div class="insert-list">' + rows + '</div></div>';
      document.body.appendChild(overlay);

      function close() { PRR.templates._pickerOpen = false; overlay.remove(); document.removeEventListener('keydown', onKey, true); }
      function onKey(ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } }
      document.addEventListener('keydown', onKey, true);
      overlay.addEventListener('click', function (ev) {
        if (ev.target === overlay) return close();
        const btn = ev.target.closest('.insert-row');
        if (!btn) return;
        insertAtCursor(textarea, PRR.templates.apply(list[Number(btn.dataset.i)].body, ctx));
        close();
      });
      const firstRow = overlay.querySelector('.insert-row');
      if (firstRow) firstRow.focus();
    }).catch(function () { PRR.templates._pickerOpen = false; });
  };

  // ---- manager route ----
  let seq = 0;
  function slug(name) {
    const base = String(name || 'template').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'template';
    return base + '-' + (++seq);
  }

  function userRow(t) {
    const id = t.id || slug(t.name);
    return '<div class="card tmpl-row" data-id="' + PRR.esc(id) + '" data-source="user">' +
      '<div class="card-head">' +
      '<input class="tmpl-name" placeholder="Template name" value="' + PRR.esc(t.name || '') + '">' +
      '<select class="tmpl-scope">' + SCOPES.map(function (s) {
        return '<option value="' + s[0] + '"' + ((t.scope || 'reply') === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
      }).join('') + '</select>' +
      '<button class="small danger tmpl-del" title="Delete">Delete</button></div>' +
      '<textarea class="tmpl-body" placeholder="Reply text… use {{author}}, {{sha}}, {{path}}…">' + PRR.esc(t.body || '') + '</textarea>' +
      '</div>';
  }

  function repoRow(t) {
    return '<div class="card tmpl-row" data-source="repo">' +
      '<div class="card-head"><b>' + PRR.esc(t.name) + '</b>' +
      '<span class="badge">from repo</span><span class="badge">' + PRR.esc(t.scope || 'reply') + '</span></div>' +
      '<div class="tmpl-readonly">' + PRR.esc(t.body) + '</div></div>';
  }

  PRR.routes.templates = {
    help: [
      ['g d / g h / g t / g p', 'Dashboard / History / Templates / Active PR'],
      ['?', 'toggle this help'],
    ],

    render: function () {
      const app = document.getElementById('app');
      const vars = PRR.TEMPLATE_VARS.map(function (v) { return '<span class="var-pill">{{' + v + '}}</span>'; }).join(' ');
      PRR.html(app,
        '<div class="view"><header><h1>Templates</h1>' +
        '<div class="sub">Reusable replies you can insert with <kbd>t</kbd> while drafting. These fill in on insert: ' + vars + '</div></header>' +
        '<div id="tmpl-body"><div class="boot">Loading…</div></div></div>');
      PRR.html(document.getElementById('footer'),
        '<span class="footer-note" id="tmpl-note" style="margin-right:auto"></span>' +
        '<button class="small" id="tmpl-new">New template</button>' +
        '<button class="primary" id="tmpl-save">Save changes</button>');
      PRR.keys.register('templates', {
        '?': function () { PRR.app.toggleHelp('templates'); },
        'escape': function () { PRR.app.toggleHelp(false); },
      });
      PRR.keys.setScope('templates');
      this.load();
    },

    load: function () {
      const self = this;
      PRR.api.get('data/templates').then(function (d) {
        PRR.templates._cache = d.templates || [];
        if (document.getElementById('tmpl-body')) self.paint(d.templates || []);
      }).catch(function (e) {
        const body = document.getElementById('tmpl-body');
        if (body) body.innerHTML = '<div class="banner err">Could not load templates: ' + PRR.esc(e.message) + '</div>';
      });
    },

    paint: function (list) {
      const user = list.filter(function (t) { return !t.readonly; });
      const repo = list.filter(function (t) { return t.readonly; });
      let html = '<div class="tmpl-list" id="tmpl-user">' +
        (user.length ? user.map(userRow).join('') : PRR.emptyState('No templates yet', 'Add one below — it’s saved to <code>~/.config/pr-replies/templates.json</code>.')) +
        '</div>';
      if (repo.length) {
        html += '<h2>From this repo <span class="section-note">(read-only — edit <code>.pr-replies/templates.json</code>)</span></h2>' +
          '<div class="tmpl-list">' + repo.map(repoRow).join('') + '</div>';
      }
      document.getElementById('tmpl-body').innerHTML = html;
      this.wire();
    },

    wire: function () {
      const self = this;
      const newBtn = document.getElementById('tmpl-new');
      const saveBtn = document.getElementById('tmpl-save');
      newBtn.onclick = function () {
        const container = document.getElementById('tmpl-user');
        const es = container.querySelector('.empty-state');
        if (es) es.remove();
        container.insertAdjacentHTML('beforeend', userRow({ name: '', scope: 'reply', body: '' }));
        const rows = container.querySelectorAll('.tmpl-row');
        const last = rows[rows.length - 1];
        if (last) { self.bindRow(last); last.querySelector('.tmpl-name').focus(); }
      };
      saveBtn.onclick = function () { self.save(); };
      Array.prototype.forEach.call(document.querySelectorAll('.tmpl-row[data-source="user"]'), function (row) { self.bindRow(row); });
    },

    bindRow: function (row) {
      const del = row.querySelector('.tmpl-del');
      if (del) del.onclick = function () { row.remove(); };
    },

    collect: function () {
      return Array.prototype.map.call(document.querySelectorAll('.tmpl-row[data-source="user"]'), function (row) {
        return {
          id: row.dataset.id,
          name: row.querySelector('.tmpl-name').value.trim(),
          scope: row.querySelector('.tmpl-scope').value,
          body: row.querySelector('.tmpl-body').value,
        };
      });
    },

    save: function () {
      const self = this;
      const templates = this.collect().filter(function (t) { return t.name || t.body.trim(); });
      const note = document.getElementById('tmpl-note');
      const saveBtn = document.getElementById('tmpl-save');
      saveBtn.disabled = true;
      PRR.api.post('data/templates', { templates: templates }).then(function (d) {
        PRR.templates._cache = d.templates || [];
        saveBtn.disabled = false;
        if (note) note.textContent = 'Saved ' + PRR.plural(templates.length, 'template') + '.';
        self.paint(d.templates || []);
      }).catch(function (e) {
        saveBtn.disabled = false;
        PRR.banner('err', 'Could not save templates: ' + PRR.esc(e.message));
      });
    },
  };
})();
