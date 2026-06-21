'use strict';
/* App shell — the persistent nav, the hash router, and the dispatch into the
 * active view. The '#/pr' route is the per-PR phase flow (triage / fixing /
 * reply / done|cancelled); History / Templates are sibling routes.
 * Routing reads the route + snapshot stores; the phase machine on the server
 * stays the single source of truth via the snapshot. */
(function () {
  const html = PRR.html;
  const C = PRR.components;
  const Fragment = PRR.hooks.Fragment;
  const useEffect = PRR.hooks.useEffect;
  const useRef = PRR.hooks.useRef;

  const NAV = [
    { name: 'pr', label: 'Active PR', modes: ['session'] },
    { name: 'history', label: 'History', modes: ['home', 'session'] },
    { name: 'templates', label: 'Templates', modes: ['home', 'session'] },
  ];
  const THEME_ICON = { light: '☀', dark: '☾', system: '◐' };
  const PHASE_LABEL = { triage: 'triage', fixing: 'fixing', reply: 'reply', done: 'done', cancelled: 'cancelled' };
  const TITLE_PHASE = { triage: 'Triage', fixing: 'Fixing', reply: 'Replies', done: 'Done', cancelled: 'Cancelled' };

  function modeOf(s) { return s && s.mode ? s.mode : (s && s.phase ? 'session' : 'home'); }
  function hasPr(s) { return modeOf(s) === 'session'; }
  function available(name, s) {
    const r = NAV.find(function (n) { return n.name === name; });
    return !!(r && r.modes.indexOf(modeOf(s)) !== -1 && (name !== 'pr' || hasPr(s)));
  }
  function defaultRoute(s) { return modeOf(s) === 'home' ? 'history' : 'pr'; }
  function resolveName(route, s) {
    let name = route.name || defaultRoute(s);
    if (!available(name, s)) name = defaultRoute(s);
    return name;
  }
  function scopeFor(curName, s) { return curName === 'pr' ? (s ? s.phase : 'triage') : curName; }

  function Nav(props) {
    const s = props.snapshot;
    const curName = props.curName;
    const theme = PRR.useStore(PRR.stores.theme);
    const phase = s && s.phase;
    const links = NAV.filter(function (n) { return available(n.name, s); }).map(function (n) {
      return html`<a key=${n.name} className=${'nav-link' + (n.name === curName ? ' active' : '')} data-route=${n.name} href=${'#/' + n.name}>
        ${n.label}${n.name === 'pr' ? html`<span className="nav-phase" id="nav-phase">${PHASE_LABEL[phase] ? ' · ' + PHASE_LABEL[phase] : ''}</span>` : null}
      </a>`;
    });
    return html`<nav id="nav">
      <div className="nav-inner">
        <a className="nav-brand" href=${'#/' + defaultRoute(s)}>pr-replies</a>
        <div className="nav-links">${links}</div>
        <div className="nav-right">
          <button className="nav-btn" id="nav-theme" title=${'Theme: ' + theme + ' (click to change)'} onClick=${function () { PRR.stores.theme.cycle(); }}>${THEME_ICON[theme] || '◐'}</button>
          <button className="nav-btn" id="nav-help" title="Keyboard shortcuts (?)" onClick=${function () { PRR.stores.help.toggle(scopeFor(curName, s)); }}>?</button>
        </div>
      </div>
    </nav>`;
  }

  function Placeholder(props) {
    const footer = html`<${C.Stepper} phase=${(PRR.stores.snapshot.get() || {}).phase} />`;
    return html`<${C.Shell} footer=${footer}>
      <div className="view"><${C.EmptyState} title=${props.name.charAt(0).toUpperCase() + props.name.slice(1)}>This section is coming soon.</${C.EmptyState}></div>
    </${C.Shell}>`;
  }

  function ActiveView(props) {
    const s = props.snapshot;
    const curName = props.curName;
    if (curName === 'pr') {
      const phase = s.phase;
      if (phase === 'done' || phase === 'cancelled') return html`<${PRR.views.final} snapshot=${s} />`;
      const View = PRR.views[phase];
      return View ? html`<${View} snapshot=${s} />` : html`<${Placeholder} name=${phase || 'pr'} />`;
    }
    const Route = PRR.routes[curName];
    return Route ? html`<${Route} snapshot=${s} />` : html`<${Placeholder} name=${curName} />`;
  }

  function App() {
    const snapshot = PRR.useStore(PRR.stores.snapshot);
    const route = PRR.useStore(PRR.stores.route);
    const curName = snapshot ? resolveName(route, snapshot) : '';
    const phase = snapshot && snapshot.phase;

    // Normalize an empty / unavailable hash to the default route.
    useEffect(function () {
      if (!snapshot) return;
      const name = resolveName(route, snapshot);
      if (!route.param && route.name !== name) location.hash = '#/' + name;
    }, [route, snapshot]);

    // Transient banners are per-view; clear them when the route or phase changes.
    useEffect(function () { PRR.stores.banners.clear(); }, [curName, phase]);

    // Document title tracks the active PR phase.
    useEffect(function () {
      if (!snapshot) return;
      document.title = curName === 'pr'
        ? 'PR #' + (snapshot.pr ? snapshot.pr.number : '') + ' — ' + (TITLE_PHASE[phase] || '')
        : 'pr-replies';
    }, [phase, curName, snapshot]);

    // On a genuine phase transition (not the initial mount), announce the new
    // phase to assistive tech and move focus to the new view's heading, so
    // keyboard / screen-reader users aren't stranded on a now-gone control.
    const prevPhaseRef = useRef(null);
    useEffect(function () {
      if (!snapshot || curName !== 'pr') { prevPhaseRef.current = phase; return; }
      const prev = prevPhaseRef.current;
      prevPhaseRef.current = phase;
      if (prev == null || prev === phase) return;
      const region = document.getElementById('prr-live');
      if (region) region.textContent = 'Now in ' + (TITLE_PHASE[phase] || phase) + '.';
      const h1 = document.querySelector('#app h1');
      if (h1) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: false }); }
    }, [phase, curName, snapshot]);

    // go-to chords: g h / g t / g p (capture phase, so they win over
    // per-view single-key bindings like reply's 'p').
    useEffect(function () {
      let pendingG = 0;
      function onKey(ev) {
        const tag = ev.target && ev.target.tagName;
        if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') { pendingG = 0; return; }
        if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
        const k = ev.key.toLowerCase();
        if (pendingG && Date.now() - pendingG < 1000) {
          pendingG = 0;
          const dest = { h: 'history', t: 'templates', p: 'pr' }[k];
          const snap = PRR.stores.snapshot.get();
          if (dest && available(dest, snap)) { ev.preventDefault(); ev.stopPropagation(); PRR.stores.route.go(dest); }
          return;
        }
        if (k === 'g') { pendingG = Date.now(); ev.preventDefault(); }
      }
      document.addEventListener('keydown', onKey, true);
      return function () { document.removeEventListener('keydown', onKey, true); };
    }, []);

    if (!snapshot) return html`<main className="wrap" id="app"><div className="boot">Loading session…</div></main>`;

    return html`<${Fragment}>
      <div id="prr-live" className="sr-only" aria-live="polite" aria-atomic="true"></div>
      <${Nav} snapshot=${snapshot} curName=${curName} />
      <${ActiveView} snapshot=${snapshot} curName=${curName} />
      <${C.HelpOverlay} />
      <${C.PickerOverlay} />
    </${Fragment}>`;
  }

  PRR.App = App;
})();
