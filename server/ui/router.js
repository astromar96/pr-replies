'use strict';
/* App-shell router. Sits ABOVE the per-phase dispatch in app.js: the active-PR
 * flow is just the '#/pr' route and still owns the snapshot + SSE. Dashboard /
 * History / Templates are sibling hash routes that render into #app + #footer
 * without ever touching the phase machine. Hash-based (no History API). */
PRR.routes = {};

(function () {
  // Nav order + availability. 'pr' only exists when a live session is attached
  // (session mode); the hub (home mode) has no active PR.
  const NAV = [
    { name: 'dashboard', label: 'Dashboard', modes: ['home', 'session'] },
    { name: 'pr', label: 'Active PR', modes: ['session'] },
    { name: 'history', label: 'History', modes: ['home', 'session'] },
    { name: 'templates', label: 'Templates', modes: ['home', 'session'] },
  ];
  const THEME_ICON = { light: '☀', dark: '☾', system: '◐' };

  let mode = 'session';
  let curName = 'pr';
  let curParam = null;

  function available(name) {
    const r = NAV.find(function (n) { return n.name === name; });
    return !!(r && r.modes.indexOf(mode) !== -1 && (name !== 'pr' || PRR.routes.pr));
  }

  function defaultRoute() { return mode === 'home' ? 'dashboard' : 'pr'; }

  function parseHash() {
    const h = String(location.hash || '').replace(/^#\/?/, '');
    if (!h) return { name: '', param: null };
    const parts = h.split('/');
    return { name: parts[0], param: parts[1] ? decodeURIComponent(parts[1]) : null };
  }

  // The keyboard/help scope for the current route: the phase for #/pr, else the
  // route name. Used by the nav help button.
  function scopeName() {
    if (curName === 'pr') {
      const s = PRR.app.getSnapshot();
      return s ? s.phase : 'triage';
    }
    return curName;
  }

  function renderNav() {
    const nav = document.getElementById('nav');
    const theme = PRR.theme.get();
    const links = NAV.filter(function (n) { return available(n.name); }).map(function (n) {
      return '<a class="nav-link' + (n.name === curName ? ' active' : '') + '" data-route="' + n.name +
        '" href="#/' + n.name + '">' + PRR.esc(n.label) +
        (n.name === 'pr' ? '<span class="nav-phase" id="nav-phase"></span>' : '') + '</a>';
    }).join('');
    nav.innerHTML =
      '<div class="nav-inner">' +
      '<a class="nav-brand" href="#/' + defaultRoute() + '">pr-replies</a>' +
      '<div class="nav-links">' + links + '</div>' +
      '<div class="nav-right">' +
      '<button class="nav-btn" id="nav-theme" title="Theme: ' + theme + ' (click to change)">' +
      (THEME_ICON[theme] || '◐') + '</button>' +
      '<button class="nav-btn" id="nav-help" title="Keyboard shortcuts (?)">?</button>' +
      '</div></div>';
    nav.hidden = false;

    document.getElementById('nav-theme').addEventListener('click', function () {
      PRR.theme.cycle();
      renderNav();
    });
    document.getElementById('nav-help').addEventListener('click', function () {
      PRR.app.toggleHelp(scopeName());
    });
    updatePhaseBadge();
  }

  function updatePhaseBadge() {
    const el = document.getElementById('nav-phase');
    if (!el) return;
    const s = PRR.app.getSnapshot();
    const phase = s && s.phase;
    const txt = { triage: 'triage', fixing: 'fixing', reply: 'reply', done: 'done', cancelled: 'cancelled' }[phase];
    el.textContent = txt ? ' · ' + txt : '';
  }

  function placeholder(name) {
    PRR.html(document.getElementById('app'),
      '<div class="view">' + PRR.emptyState(name.charAt(0).toUpperCase() + name.slice(1),
        'This section is coming soon.') + '</div>');
    PRR.html(document.getElementById('footer'), PRR.app.stepper());
  }

  function renderRoute() {
    const parsed = parseHash();
    let name = parsed.name || defaultRoute();
    if (!available(name)) name = defaultRoute();
    // Normalize the hash if it was empty or redirected.
    const wanted = '#/' + name + (parsed.param ? '/' + encodeURIComponent(parsed.param) : '');
    if (location.hash !== wanted && !parsed.param) {
      // setting the hash re-enters via hashchange; avoid a double render
      if (('#/' + parsed.name) !== ('#/' + name)) { location.hash = '#/' + name; return; }
    }
    curName = name;
    curParam = parsed.param;
    const route = PRR.routes[name];
    if (route && route.render) route.render(curParam, PRR.app.getSnapshot());
    else placeholder(name);
    // Reflect active state in the nav.
    Array.prototype.forEach.call(document.querySelectorAll('.nav-link'), function (a) {
      a.classList.toggle('active', a.dataset.route === name);
    });
    updatePhaseBadge();
  }

  // ---- go-to chords (g d / g h / g t / g p), capture phase so they win over
  // per-view single-key bindings (e.g. reply's 'p'). ----
  let pendingG = 0;
  document.addEventListener('keydown', function (ev) {
    const tag = ev.target && ev.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') { pendingG = 0; return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (pendingG && Date.now() - pendingG < 1000) {
      pendingG = 0;
      const dest = { d: 'dashboard', h: 'history', t: 'templates', p: 'pr' }[k];
      if (dest && available(dest)) { ev.preventDefault(); ev.stopPropagation(); PRR.router.go(dest); }
      return;
    }
    if (k === 'g') { pendingG = Date.now(); ev.preventDefault(); }
  }, true);

  PRR.router = {
    start: function (snapshot) {
      mode = snapshot && snapshot.mode ? snapshot.mode : (snapshot && snapshot.phase ? 'session' : 'home');
      window.addEventListener('hashchange', renderRoute);
      renderNav();
      renderRoute();
    },
    current: function () { return curName; },
    param: function () { return curParam; },
    scope: scopeName,
    go: function (name, param) { location.hash = '#/' + name + (param ? '/' + encodeURIComponent(param) : ''); },
    refreshNav: function () { renderNav(); },
  };
})();
