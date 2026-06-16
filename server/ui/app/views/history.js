'use strict';
/* History route — a browsable audit log of past sessions. The list links to a
 * per-session detail that reuses the shared <Summary> (the same renderer as the
 * live "done" view). Read-only; data comes from GET data/history[/:id]. */
(function () {
  const html = PRR.html;
  const C = PRR.components;
  const Fragment = PRR.hooks.Fragment;
  const useState = PRR.hooks.useState;
  const useEffect = PRR.hooks.useEffect;

  PRR.help.history = [
    ['g d / g h / g t / g p', 'Dashboard / History / Templates / Active PR'],
    ['?', 'toggle this help'],
  ];

  function statusIcon(status) {
    return status === 'submitted' ? html`<span className="t-icon ok">✓</span>`
      : status === 'timeout' ? html`<span className="t-icon muted">⧖</span>`
      : html`<span className="t-icon muted">–</span>`;
  }

  function Row(props) {
    const h = props.h;
    const c = h.counts || {};
    return html`<a className="trow history-row" href=${'#/history/' + encodeURIComponent(h.id)}>
      <span className="t-icon">${statusIcon(h.status)}</span>
      <span className="t-label">${(h.repo || '') + '#' + (h.pr != null ? h.pr : '')}${h.dryRun ? html` <span className="badge">dry run</span>` : null}</span>
      <span className="t-meta">${h.prTitle || ''} <span className="badge">${c.posted || 0} posted</span>${c.failed ? html`<span className="badge conf conf-low">${c.failed} failed</span>` : null}${c.resolved ? html`<span className="badge fixed">${c.resolved} resolved</span>` : null} · ${PRR.relTime(h.endedAt)}</span>
    </a>`;
  }

  function labelMap(rec) {
    const map = {};
    (rec.posted || []).forEach(function (p) { map[p.key] = p.path ? p.path + (p.line != null ? ':' + p.line : '') : p.key; });
    (rec.fixCommits || []).forEach(function (f) { if (!map[f.key]) map[f.key] = f.key; });
    return map;
  }

  function HistoryList() {
    const [items, setItems] = useState(null);
    const [error, setError] = useState(null);
    useEffect(function () {
      PRR.api.get('data/history').then(function (d) { setItems(d.history || []); }).catch(function (e) { setError(e.message); });
    }, []);
    let inner;
    if (error) inner = html`<div className="banner err">Could not load history: ${error}</div>`;
    else if (!items) inner = html`<div className="boot">Loading…</div>`;
    else inner = items.length
      ? html`<div className="summary-list">${items.map(function (h, i) { return html`<${Row} key=${i} h=${h} />`; })}</div>`
      : html`<${C.EmptyState} title="No history yet">Finished <code>/pr-replies</code> sessions are recorded here automatically.</${C.EmptyState}>`;
    const body = html`<div className="view">
      <header><h1>History</h1><div className="sub">Past sessions on this machine — what was posted, resolved, and fixed.</div></header>
      <div id="hist-body">${inner}</div>
    </div>`;
    return html`<${C.Shell} footer=${html`<span className="footer-note">read-only audit log</span>`}>${body}</${C.Shell}>`;
  }

  function HistoryDetail(props) {
    const id = props.id;
    const [rec, setRec] = useState(null);
    const [error, setError] = useState(null);
    useEffect(function () {
      setRec(null); setError(null);
      PRR.api.get('data/history/' + encodeURIComponent(id)).then(function (r) { setRec(r); }).catch(function (e) { setError(e.message); });
    }, [id]);

    let inner;
    if (error) inner = html`<div className="banner err">Could not load this session: ${error}</div>`;
    else if (!rec) inner = html`<div className="boot">Loading…</div>`;
    else {
      const cancelled = rec.status !== 'submitted';
      const m = labelMap(rec);
      inner = html`<${Fragment}>
        <header><h1>${rec.prUrl ? html`<a href=${rec.prUrl} target="_blank" rel="noopener">${rec.prTitle || 'Session'}</a>` : (rec.prTitle || 'Session')}</h1>
          <div className="sub"><b>${(rec.repo || '') + '#' + (rec.pr != null ? rec.pr : '')}</b> · ${rec.status}${rec.dryRun ? ' · dry run' : ''} · ${PRR.relTime(rec.endedAt)}</div>
        </header>
        <${C.Summary}
          cancelled=${cancelled}
          timedOut=${rec.status === 'timeout'}
          posted=${rec.posted || []}
          errors=${rec.errors || []}
          resolved=${rec.resolved || []}
          fixes=${(rec.fixCommits || []).map(function (f) { return { key: f.key, sha: f.sha, text: f.subject }; })}
          labelFor=${function (k) { return m[k] || k; }} />
      </${Fragment}>`;
    }
    const body = html`<div className="view"><div id="hist-detail">${inner}</div></div>`;
    return html`<${C.Shell} footer=${html`<a className="nav-link" href="#/history">← All sessions</a>`}>${body}</${C.Shell}>`;
  }

  PRR.routes.history = function HistoryView() {
    const route = PRR.useStore(PRR.stores.route);
    useEffect(function () {
      PRR.keys.register('history', { '?': function () { PRR.stores.help.toggle('history'); }, 'escape': function () { PRR.stores.help.toggle(false); } });
      PRR.keys.setScope('history');
    }, []);
    return route.param ? html`<${HistoryDetail} id=${route.param} />` : html`<${HistoryList} />`;
  };
})();
