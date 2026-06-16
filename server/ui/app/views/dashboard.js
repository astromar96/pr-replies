'use strict';
/* Dashboard route — the hub overview: live sessions on this machine, recent
 * session history, and (optionally) open PRs from GitHub. It cannot start a new
 * flow (the browser can't invoke Claude) — it deep-links to running sessions
 * and surfaces copyable `/pr-replies <n>` launch hints. */
(function () {
  const html = PRR.html;
  const C = PRR.components;
  const Fragment = PRR.hooks.Fragment;
  const useState = PRR.hooks.useState;
  const useEffect = PRR.hooks.useEffect;
  const useCallback = PRR.hooks.useCallback;

  PRR.help.dashboard = [
    ['g d / g h / g t / g p', 'Dashboard / History / Templates / Active PR'],
    ['r', 'refresh'],
    ['?', 'toggle this help'],
  ];

  function stateBadge(decision) {
    if (decision === 'CHANGES_REQUESTED') return html`<span className="badge state state-changes">changes requested</span>`;
    if (decision === 'APPROVED') return html`<span className="badge state state-approved">approved</span>`;
    if (decision === 'REVIEW_REQUIRED') return html`<span className="badge">review required</span>`;
    return null;
  }

  function SessionTile(props) {
    const s = props.s;
    const loc = (s.repo || '?') + '#' + (s.pr != null ? s.pr : '?');
    return html`<div className="pr-tile card">
      <div className="pt-top"><span className="pt-repo">${loc}</span>
        <span className=${'badge ' + (s.alive ? 'fixed' : '')}>${s.alive ? (s.phase || 'live') : 'ended'}</span></div>
      <div className="pt-meta">updated ${PRR.relTime(s.updatedAt)}</div>
      <div className="pt-actions">${(s.alive && s.url)
        ? html`<a href=${s.url} target="_blank" rel="noopener">open session →</a>`
        : html`<span className="empty">no longer running</span>`}</div>
    </div>`;
  }

  function CopyButton(props) {
    const [label, setLabel] = useState('copy /pr-replies ' + props.number);
    function copy() {
      const cmd = '/pr-replies ' + props.number;
      const done = function () { setLabel('copied!'); setTimeout(function () { setLabel('copy ' + cmd); }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cmd).then(done, done);
      else done();
    }
    return html`<button className="small" data-launch=${props.number} onClick=${copy}>${label}</button>`;
  }

  function PrTile(props) {
    const p = props.p;
    return html`<div className="pr-tile card">
      <div className="pt-top"><span className="pt-repo">#${p.number}</span>${stateBadge(p.reviewDecision)}</div>
      <div className="pt-title"><a href=${p.url} target="_blank" rel="noopener">${p.title}</a></div>
      <div className="pt-meta">by ${p.author} · ${PRR.relTime(p.updatedAt)}</div>
      <div className="pt-actions"><${CopyButton} number=${p.number} /></div>
    </div>`;
  }

  function HistoryRow(props) {
    const h = props.h;
    const c = h.counts || {};
    const icon = h.status === 'submitted' ? html`<span className="t-icon ok">✓</span>`
      : h.status === 'timeout' ? html`<span className="t-icon muted">⧖</span>`
      : html`<span className="t-icon muted">–</span>`;
    return html`<a className="trow history-row" href=${'#/history/' + encodeURIComponent(h.id)}>
      <span className="t-icon">${icon}</span>
      <span className="t-label">${(h.repo || '') + '#' + (h.pr != null ? h.pr : '')}${h.dryRun ? html` <span className="badge">dry run</span>` : null}</span>
      <span className="t-meta">${h.prTitle || ''} <span className="badge">${c.posted || 0} posted</span>${c.resolved ? html`<span className="badge fixed">${c.resolved} resolved</span>` : null} · ${PRR.relTime(h.endedAt)}</span>
    </a>`;
  }

  PRR.routes.dashboard = function DashboardView() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [prsOverride, setPrsOverride] = useState(null);
    const [loadingPrs, setLoadingPrs] = useState(false);

    const load = useCallback(function () {
      setError(null);
      PRR.api.get('data/dashboard').then(function (d) { setData(d); setPrsOverride(null); }).catch(function (e) { setError(e.message); });
    }, []);
    useEffect(function () { load(); }, [load]);
    useEffect(function () {
      PRR.keys.register('dashboard', { 'r': load, '?': function () { PRR.stores.help.toggle('dashboard'); }, 'escape': function () { PRR.stores.help.toggle(false); } });
      PRR.keys.setScope('dashboard');
    }, [load]);

    function loadPrs() {
      setLoadingPrs(true);
      PRR.api.get('data/prs').then(function (prs) {
        setLoadingPrs(false);
        if (prs && prs.available && prs.items && prs.items.length) setPrsOverride(prs);
        else PRR.banner('warn', 'No open PRs found' + (prs && prs.reason ? ' (' + PRR.esc(prs.reason) + ')' : '') + '.');
      }).catch(function (e) { setLoadingPrs(false); PRR.banner('err', PRR.esc(e.message)); });
    }

    let bodyInner;
    if (error) {
      bodyInner = html`<div className="banner err">Could not load the dashboard: ${error}</div>`;
    } else if (!data) {
      bodyInner = html`<div className="boot">Loading…</div>`;
    } else {
      const sessions = (data.sessions || []).filter(function (s) { return s.alive; });
      const history = data.history || [];
      const prs = prsOverride || data.prs;
      const haveOpenPrs = prs && prs.available && prs.items && prs.items.length;
      const sections = [];
      if (sessions.length) {
        sections.push(html`<${Fragment} key="sess"><h2>Active sessions</h2><div className="dash-grid">${sessions.map(function (s, i) { return html`<${SessionTile} key=${i} s=${s} />`; })}</div></${Fragment}>`);
      }
      if (haveOpenPrs) {
        sections.push(html`<${Fragment} key="prs"><h2>Open PRs</h2><div className="dash-grid">${prs.items.map(function (p, i) { return html`<${PrTile} key=${i} p=${p} />`; })}</div></${Fragment}>`);
      } else {
        const note = prs && prs.available === false && prs.reason === 'disabled'
          ? html`Enable <code>dashboardListPrs</code> in your config to list open PRs here, or`
          : (prs && prs.reason && prs.reason !== 'disabled' ? 'GitHub PR list unavailable (' + prs.reason + '). You can' : 'You can');
        sections.push(html`<${Fragment} key="prs"><h2>Open PRs</h2><div className="dash-actions">
          <button className="small" id="load-prs" disabled=${loadingPrs} onClick=${loadPrs}>${loadingPrs ? 'Loading…' : 'Load PRs from GitHub'}</button>
          <span className="footer-note">${note} load on demand.</span></div></${Fragment}>`);
      }
      if (history.length) {
        sections.push(html`<${Fragment} key="hist"><h2>Recent sessions</h2><div className="summary-list">${history.slice(0, 25).map(function (h, i) { return html`<${HistoryRow} key=${i} h=${h} />`; })}</div></${Fragment}>`);
      }
      if (!sessions.length && !history.length && !haveOpenPrs) {
        sections.push(html`<${C.EmptyState} key="empty" title="Nothing here yet">Run <code>/pr-replies ${'<n>'}</code> in Claude Code to triage a PR. Finished sessions show up here, and your reply templates live under <b>Templates</b>.</${C.EmptyState}>`);
      }
      bodyInner = sections;
    }

    const body = html`<div className="view">
      <header><h1>Dashboard</h1><div className="sub">Live sessions, history, and open PRs — all local to this machine.</div></header>
      <div id="dash-body">${bodyInner}</div>
    </div>`;

    const footer = html`<${Fragment}>
      <span className="footer-note" style=${{ marginRight: 'auto' }}>Start a session with <code>/pr-replies ${'<n>'}</code> in Claude Code</span>
      <button className="small" id="dash-refresh" onClick=${load}>Refresh</button>
    </${Fragment}>`;

    return html`<${C.Shell} footer=${footer}>${body}</${C.Shell}>`;
  };
})();
