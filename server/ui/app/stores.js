'use strict';
/* External stores bridged into React via useSyncExternalStore. These hold the
 * cross-cutting state that lives outside any single view — the /state snapshot,
 * the hash route, the help overlay, the theme, the group-by mode, and transient
 * banners. window.PRR (set up in main.js) drives the help + theme stores so the
 * Playwright harness and power users keep their imperative entry points. */
(function () {
  const useSyncExternalStore = PRR.hooks.useSyncExternalStore;

  function makeStore(initial) {
    let value = initial;
    const subs = new Set();
    return {
      get: function () { return value; },
      set: function (next) {
        if (next === value) return;
        value = next;
        subs.forEach(function (fn) { fn(); });
      },
      // Functional update — handy for merging into object-valued stores.
      update: function (fn) { this.set(fn(value)); },
      subscribe: function (fn) { subs.add(fn); return function () { subs.delete(fn); }; },
    };
  }

  // React hook: re-render the caller whenever `store` changes.
  PRR.useStore = function (store) {
    return useSyncExternalStore(store.subscribe, store.get);
  };

  // ---------- snapshot (GET /state) ----------
  const snapshot = makeStore(null);

  // ---------- hash route ----------
  function parseHash() {
    const h = String(location.hash || '').replace(/^#\/?/, '');
    if (!h) return { name: '', param: null };
    const parts = h.split('/');
    return { name: parts[0], param: parts[1] ? decodeURIComponent(parts[1]) : null };
  }
  const route = makeStore(parseHash());
  window.addEventListener('hashchange', function () { route.set(parseHash()); });
  route.go = function (name, param) {
    location.hash = '#/' + name + (param ? '/' + encodeURIComponent(param) : '');
  };

  // ---------- help overlay ----------
  // open with a scope name, or toggle/close. Mirrors the original toggleHelp:
  // a falsy scope (or an already-open overlay) closes it.
  const help = makeStore({ open: false, scope: null });
  help.toggle = function (scope) {
    const cur = help.get();
    if (!scope || cur.open) help.set({ open: false, scope: null });
    else help.set({ open: true, scope: scope });
  };

  // ---------- theme (light / dark / system) ----------
  const THEME_NEXT = { light: 'dark', dark: 'system', system: 'light' };
  function applyTheme(v) {
    if (v === 'light' || v === 'dark') document.documentElement.setAttribute('data-theme', v);
    else document.documentElement.removeAttribute('data-theme');
  }
  const theme = makeStore(PRR.store.pref('theme') || 'system');
  theme.apply = applyTheme;
  theme.choose = function (v) { PRR.store.pref('theme', v); applyTheme(v); theme.set(v); };
  theme.cycle = function () { const n = THEME_NEXT[theme.get()] || 'light'; theme.choose(n); return n; };

  // ---------- group-by (file / reviewer), persisted ----------
  const groupBy = makeStore(PRR.store.pref('groupby') === 'reviewer' ? 'reviewer' : 'file');
  groupBy.choose = function (v) { PRR.store.pref('groupby', v); groupBy.set(v); };

  // ---------- transient banners (rendered at the top of #app) ----------
  let bannerSeq = 0;
  const banners = makeStore([]);
  // content is a React node or an escape-safe HTML string; actions is an
  // optional array of { label, onClick, primary }.
  banners.push = function (cls, content, actions) {
    const id = ++bannerSeq;
    banners.set(banners.get().concat([{ id: id, cls: cls, content: content, actions: actions || null }]));
    return { id: id, dismiss: function () { banners.dismiss(id); } };
  };
  banners.dismiss = function (id) { banners.set(banners.get().filter(function (b) { return b.id !== id; })); };
  banners.clear = function () { if (banners.get().length) banners.set([]); };
  // Imperative shortcut used across views, matching the old PRR.banner signature.
  PRR.banner = function (cls, content, actions) { return banners.push(cls, content, actions); };

  // ---------- event log (SSE fan-in) ----------
  // The full, seq-ordered event stream — seeded from the snapshot's persisted
  // events.jsonl replay and appended to live. Progress/Reply derive their UI
  // from this purely, so a refresh or reconnect is lossless (matches the
  // server's "events.jsonl is the source of truth" design).
  const events = makeStore([]);
  function mergeEvents(cur, incoming) {
    const bySeq = {};
    cur.forEach(function (e) { if (e && e.seq) bySeq[e.seq] = e; });
    incoming.forEach(function (e) { if (e && e.seq && !bySeq[e.seq]) bySeq[e.seq] = e; });
    return Object.keys(bySeq).map(Number).sort(function (a, b) { return a - b; }).map(function (s) { return bySeq[s]; });
  }
  events.add = function (ev) { events.set(mergeEvents(events.get(), [ev])); };
  events.seed = function (list) { events.set(mergeEvents(events.get(), list || [])); };

  PRR.stores = { snapshot: snapshot, route: route, help: help, theme: theme, groupBy: groupBy, banners: banners, events: events };
})();
