'use strict';
/* Pure helpers — text, markdown, diffs, the HTTP/SSE client, localStorage, and
 * the reviewer-grouping logic. Ported (mostly verbatim) from the original
 * common.js: these are framework-agnostic and reused by every React view.
 * renderMarkdown / renderDiff still return escape-first HTML strings — the <Md>
 * and <Diff> components feed them through dangerouslySetInnerHTML, so the same
 * "escape before any tag is introduced" safety property holds. */
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

  // The display name of the coding agent driving the session. Returns the
  // configured label (e.g. "Codex") or the neutral fallback "the agent". Use
  // agentRef in object/possessive positions ("Guidance for {ref}", "{ref}'s
  // sketch") and agentRefCap at the start of a sentence ("{Cap} is working").
  PRR.agentRef = function (snapshot) {
    return (snapshot && snapshot.config && snapshot.config.agentLabel) || 'the agent';
  };
  PRR.agentRefCap = function (snapshot) {
    return (snapshot && snapshot.config && snapshot.config.agentLabel) || 'The agent';
  };

  PRR.plural = function (n, word) {
    if (n === 1) return n + ' ' + word;
    var plural;
    if (/(?:s|x|z|ch|sh)$/.test(word)) plural = word + 'es';          // fix → fixes
    else if (/[^aeiou]y$/.test(word)) plural = word.slice(0, -1) + 'ies'; // reply → replies
    else plural = word + 's';
    return n + ' ' + plural;
  };

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
    // Value-typed preference store. get() returns the RAW string (or null);
    // set() writes a boolean as '1'/'0' (legacy autoclose semantics) and any
    // other value as its string. Callers coerce: e.g. pref('autoclose') === '0'.
    pref: function (name, val) {
      const k = 'prr:pref:' + name;
      if (val === undefined) {
        return localStorage.getItem(k);
      }
      try { localStorage.setItem(k, typeof val === 'boolean' ? (val ? '1' : '0') : String(val)); } catch (_) { /* ignore */ }
    },
  };

  // ---------- templates ----------
  // Variable substitution: {{author}} {{sha}} {{path}} {{pr}} {{repo}} {{line}}.
  // Unknown placeholders are left literal. The result is inserted into a
  // textarea's .value (never innerHTML), so it stays escape-safe by construction.
  PRR.TEMPLATE_VARS = ['author', 'sha', 'path', 'pr', 'repo', 'line'];
  PRR.templates = {
    _cache: null,
    invalidate: function () { PRR.templates._cache = null; },
    load: function () {
      if (PRR.templates._cache) return Promise.resolve(PRR.templates._cache);
      return PRR.api.get('data/templates').then(function (d) {
        PRR.templates._cache = d.templates || [];
        return PRR.templates._cache;
      });
    },
    apply: function (body, ctx) {
      ctx = ctx || {};
      return String(body == null ? '' : body).replace(/\{\{(\w+)\}\}/g, function (m, k) {
        return Object.prototype.hasOwnProperty.call(ctx, k) && ctx[k] != null && ctx[k] !== '' ? String(ctx[k]) : m;
      });
    },
  };

  PRR.templateCtx = function (item, snapshot) {
    const first = (item.comments && item.comments[0]) || {};
    return {
      author: item.author || first.author || '',
      path: item.path || '',
      line: item.line != null ? item.line : '',
      sha: item.fixedIn || '',
      pr: snapshot && snapshot.pr ? snapshot.pr.number : '',
      repo: snapshot && snapshot.repo ? snapshot.repo.nameWithOwner : '',
    };
  };

  PRR.debounce = function (fn, ms) {
    let t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  };

  // ---------- item keys + location labels ----------
  PRR.itemKey = function (item) {
    return item.id ? 'review:' + item.id : 'issue:' + item.databaseId;
  };

  PRR.locText = function (t) {
    return t.path + (t.line != null
      ? ':' + (t.startLine != null && t.startLine !== t.line ? t.startLine + '-' : '') + t.line
      : '');
  };

  // ---------- reviewer grouping ----------
  PRR.threadReviewer = function (t) {
    return (t.comments && t.comments[0] && t.comments[0].author) || 'unknown';
  };

  // Stable 1..6 color slot for a login (maps to --reviewer-N tokens).
  PRR.reviewerColor = function (login) {
    let h = 0;
    const s = String(login || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return (h % 6) + 1;
  };

  // Group threads by path ('file') or first-comment author ('reviewer').
  PRR.groupThreads = function (threads, mode) {
    const groups = {};
    const order = [];
    threads.forEach(function (t) {
      const key = mode === 'reviewer' ? PRR.threadReviewer(t) : t.path;
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(t);
    });
    order.sort();
    return order.map(function (k) { return { key: k, threads: groups[k] }; });
  };

  PRR.reviewerState = function (snapshot, author) {
    const reviewers = (snapshot && snapshot.pr && snapshot.pr.reviewers) || [];
    const r = reviewers.find(function (x) { return x.login === author; });
    return r ? r.state : null;
  };
})();
