'use strict';
/* Open PRs route (hub / home mode) — lists the repo's open PRs/MRs so the user
 * can jump into one. Read-only: data comes from GET data/prs (the server shells
 * out to gh/glab). The browser can't launch the agent command itself, so each
 * row links to the PR on its host and shows the `/pr-replies N` to run. */
(function () {
  const html = PRR.html;
  const C = PRR.components;
  const useState = PRR.hooks.useState;
  const useEffect = PRR.hooks.useEffect;

  PRR.help.prs = [
    ['g h / g t', 'History / Templates'],
    ['?', 'toggle this help'],
  ];

  function decisionBadge(d) {
    if (d === 'APPROVED') return html`<span className="badge state state-approved">approved</span>`;
    if (d === 'CHANGES_REQUESTED') return html`<span className="badge state state-changes">changes requested</span>`;
    if (d === 'REVIEW_REQUIRED') return html`<span className="badge">review required</span>`;
    return null;
  }

  function Row(props) {
    const p = props.p;
    return html`<div className="trow history-row">
      <span className="t-icon muted">#${p.number}</span>
      <span className="t-label">${p.url
        ? html`<a href=${p.url} target="_blank" rel="noopener">${p.title || '(untitled)'}</a>`
        : (p.title || '(untitled)')}</span>
      <span className="t-meta">${p.author ? 'by ' + p.author : ''}${decisionBadge(p.reviewDecision)}${p.updatedAt ? ' · ' + PRR.relTime(p.updatedAt) : ''} · <code>/pr-replies ${p.number}</code></span>
    </div>`;
  }

  PRR.routes.prs = function PrsView() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    useEffect(function () {
      PRR.api.get('data/prs').then(function (d) { setData(d); }).catch(function (e) { setError(e.message); });
      PRR.keys.register('prs', { '?': function () { PRR.stores.help.toggle('prs'); }, 'escape': function () { PRR.stores.help.toggle(false); } });
      PRR.keys.setScope('prs');
    }, []);

    const kind = data && data.provider === 'gitlab' ? 'merge requests' : 'pull requests';
    let inner;
    if (error) inner = html`<div className="banner err">Could not load open PRs: ${error}</div>`;
    else if (!data) inner = html`<div className="boot">Loading…</div>`;
    else if (data.error && !(data.prs && data.prs.length)) {
      inner = html`<${C.EmptyState} title="No open PRs to show">${data.error}. Open the hub with <code>/pr-dashboard</code> from inside a repo to list its open PRs.</${C.EmptyState}>`;
    } else if (!data.prs.length) {
      inner = html`<${C.EmptyState} title="No open PRs">${data.repo || 'This repo'} has no open ${kind}.</${C.EmptyState}>`;
    } else {
      inner = html`<div className="summary-list">${data.prs.map(function (p, i) { return html`<${Row} key=${i} p=${p} />`; })}</div>`;
    }

    const sub = data && data.repo
      ? html`Open ${kind} for <b>${data.repo}</b> — run <code>/pr-replies N</code> to start a session on one.`
      : html`Open pull/merge requests for the current repo.`;
    const body = html`<div className="view">
      <header><h1>Open PRs</h1><div className="sub">${sub}</div></header>
      <div id="prs-body">${inner}</div>
    </div>`;
    return html`<${C.Shell} footer=${html`<span className="footer-note">read-only — pick a PR, then run <code>/pr-replies N</code></span>`}>${body}</${C.Shell}>`;
  };
})();
