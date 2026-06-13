'use strict';
/* Shared toolkit. Every ui file attaches to the PRR namespace; the server
 * concatenates them in order (common, triage, progress, reply, app). */
var PRR = {};

(function () {
  // ---------- text ----------
  PRR.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  PRR.relTime = function (iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms) || ms < 0) return iso;
    const m = Math.round(ms / 60000), h = Math.round(m / 60), d = Math.round(h / 24);
    if (m < 60) return m + 'm ago';
    if (h < 48) return h + 'h ago';
    return d + 'd ago';
  };

  PRR.plural = function (n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); };

  // ---------- markdown (GFM-lite, escape-first; everything that reaches the
  // DOM is escaped before any tag is introduced) ----------
  PRR.renderMarkdown = function (src) {
    const fences = [];
    let text = String(src == null ? '' : src).replace(/\r\n/g, '\n');
    text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, function (_, code) {
      fences.push(code);
      return '\x00F' + (fences.length - 1) + '\x00';
    });
    text = PRR.esc(text);

    function inline(s) {
      return s
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
        .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener">$1</a>');
    }

    const out = [];
    let para = [], list = null;
    function flushPara() {
      if (para.length) out.push('<p>' + para.map(inline).join('<br>') + '</p>');
      para = [];
    }
    function flushList() {
      if (list) out.push('<' + list.tag + '>' + list.items.map(function (i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</' + list.tag + '>');
      list = null;
    }
    for (const line of text.split('\n')) {
      const fence = line.match(/^\x00F(\d+)\x00\s*$/);
      const quote = line.match(/^&gt;\s?(.*)$/);
      const ul = line.match(/^[-*]\s+(.*)$/);
      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (fence) {
        flushPara(); flushList();
        out.push('<pre><code>' + PRR.esc(fences[Number(fence[1])]) + '</code></pre>');
      } else if (quote) {
        flushPara(); flushList();
        out.push('<blockquote>' + inline(quote[1]) + '</blockquote>');
      } else if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag: tag, items: [] }; }
        list.items.push((ul || ol)[1]);
      } else if (!line.trim()) {
        flushPara(); flushList();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara(); flushList();
    return '<div class="md">' + out.join('') + '</div>';
  };

  // ---------- diffs ----------
  PRR.renderDiff = function (text) {
    if (!text) return '';
    const lines = String(text).split('\n').map(function (l) {
      const cls = /^(@@|diff --git|index |\+\+\+ |--- )/.test(l) ? 'hd'
        : l.startsWith('+') ? 'add'
        : l.startsWith('-') ? 'del' : '';
      return '<span class="' + cls + '">' + (PRR.esc(l) || '&nbsp;') + '</span>';
    }).join('');
    return '<pre class="diff">' + lines + '</pre>';
  };

  // ---------- api (relative to /{token}/) ----------
  PRR.api = {
    get: function (p) {
      return fetch(p).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    },
    post: function (p, body) {
      return fetch(p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
          return data;
        });
      });
    },
  };

  // ---------- sse ----------
  PRR.connectSse = function (after, onEvent) {
    let lastSeq = after || 0;
    let retryMs = 1000;
    let es = null;
    function open() {
      es = new EventSource('events?after=' + lastSeq);
      es.onopen = function () { retryMs = 1000; };
      es.onmessage = function (m) {
        let e;
        try { e = JSON.parse(m.data); } catch (_) { return; }
        if (e.seq) lastSeq = Math.max(lastSeq, e.seq);
        onEvent(e);
      };
      es.onerror = function () {
        es.close();
        setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 15000);
      };
    }
    open();
  };

  // ---------- persistence (survives refresh, timeout, even a server resume
  // with a fresh port/token — keyed by repo+PR, not URL) ----------
  PRR.store = {
    key: null,
    init: function (repo, pr) { this.key = 'prr:v2:' + repo + '#' + pr; },
    load: function () {
      try { return JSON.parse(localStorage.getItem(this.key)) || {}; } catch (_) { return {}; }
    },
    save: function (patch) {
      const cur = this.load();
      for (const k in patch) cur[k] = patch[k];
      cur.savedAt = new Date().toISOString();
      try { localStorage.setItem(this.key, JSON.stringify(cur)); } catch (_) { /* quota */ }
    },
    clear: function () {
      try { localStorage.removeItem(this.key); } catch (_) { /* ignore */ }
    },
    pref: function (name, val) {
      const k = 'prr:pref:' + name;
      if (val === undefined) {
        const v = localStorage.getItem(k);
        return v === null ? null : v === '1';
      }
      try { localStorage.setItem(k, val ? '1' : '0'); } catch (_) { /* ignore */ }
    },
  };

  PRR.debounce = function (fn, ms) {
    let t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  };

  // ---------- keyboard ----------
  PRR.keys = (function () {
    const scopes = {};
    let active = null;
    function register(name, bindings) { scopes[name] = bindings; }
    function setScope(name) { active = name; }
    document.addEventListener('keydown', function (ev) {
      const tag = ev.target && ev.target.tagName;
      const typing = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT';
      let combo = ev.key === ' ' ? 'space' : ev.key.toLowerCase();
      if (ev.metaKey || ev.ctrlKey) combo = 'mod+' + combo;
      if (typing && combo !== 'mod+enter' && combo !== 'escape') return;
      const bindings = (active && scopes[active]) || {};
      const handler = bindings[combo] || (scopes['*'] || {})[combo];
      if (handler) {
        ev.preventDefault();
        handler(ev);
      }
    });
    return { register: register, setScope: setScope };
  })();

  // ---------- card focus ring (j/k navigation over visible cards) ----------
  PRR.focusRing = function () {
    let idx = -1;
    function cards() {
      return Array.prototype.slice.call(document.querySelectorAll('.card:not(.hidden)'));
    }
    function apply(list) {
      list.forEach(function (c, i) { c.classList.toggle('focused', i === idx); });
      if (idx >= 0 && list[idx]) list[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    return {
      move: function (delta) {
        const list = cards();
        if (!list.length) return;
        idx = Math.max(0, Math.min(list.length - 1, idx + delta));
        apply(list);
      },
      current: function () {
        const list = cards();
        return idx >= 0 ? list[idx] : null;
      },
      reset: function () { idx = -1; apply(cards()); },
    };
  };

  // ---------- misc dom ----------
  PRR.html = function (parent, html) {
    parent.innerHTML = html;
    return parent;
  };

  PRR.banner = function (cls, html, actions) {
    const div = document.createElement('div');
    div.className = 'banner ' + cls;
    div.innerHTML = html + (actions ? '<div class="actions">' + actions + '</div>' : '');
    const app = document.getElementById('app');
    app.insertBefore(div, app.firstChild);
    return div;
  };

  PRR.itemKey = function (item) {
    return item.id ? 'review:' + item.id : 'issue:' + item.databaseId;
  };

  PRR.locBadge = function (t) {
    const loc = t.path + (t.line != null
      ? ':' + (t.startLine != null && t.startLine !== t.line ? t.startLine + '-' : '') + t.line
      : '');
    return '<span class="badge">' + PRR.esc(loc) + '</span>';
  };

  PRR.reviewerStateBadge = function (snapshot, author) {
    const reviewers = (snapshot.pr && snapshot.pr.reviewers) || [];
    const r = reviewers.find(function (x) { return x.login === author; });
    if (!r) return '';
    if (r.state === 'CHANGES_REQUESTED') return '<span class="badge state state-changes">changes requested</span>';
    if (r.state === 'APPROVED') return '<span class="badge state state-approved">approved</span>';
    return '';
  };

  PRR.renderComments = function (snapshot, comments) {
    return comments.map(function (c) {
      return '<div class="comment"><div class="meta"><b>' + PRR.esc(c.author) + '</b>' +
        PRR.reviewerStateBadge(snapshot, c.author) +
        '<span>· ' + PRR.esc(PRR.relTime(c.createdAt)) + '</span></div>' +
        PRR.renderMarkdown(c.body) + '</div>';
    }).join('');
  };

  PRR.views = {};
})();
