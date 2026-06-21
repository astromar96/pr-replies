'use strict';
/* Final view (phase: done | cancelled) — the end-of-session summary, built from
 * the reply result + fix_done events with the shared <Summary> renderer (the
 * same one the History detail route uses). */
(function () {
  const html = PRR.html;
  const C = PRR.components;
  const Fragment = PRR.hooks.Fragment;
  const useEffect = PRR.hooks.useEffect;
  const useState = PRR.hooks.useState;

  function labelFor(snapshot, key) {
    const pools = [];
    if (snapshot.reply && snapshot.reply.payload) pools.push(snapshot.reply.payload);
    if (snapshot.triage && snapshot.triage.payload) pools.push(snapshot.triage.payload);
    for (let i = 0; i < pools.length; i++) {
      const P = pools[i];
      for (const t of P.reviewThreads) { if (PRR.itemKey(t) === key) return t.path + (t.line != null ? ':' + t.line : ''); }
      for (const c of P.issueComments) { if (PRR.itemKey(c) === key) return 'general comment by ' + c.author; }
    }
    return key;
  }

  PRR.views.final = function FinalView(props) {
    const snapshot = props.snapshot;
    const events = PRR.useStore(PRR.stores.events);
    const result = snapshot.reply.result || {};
    const cancelled = snapshot.phase === 'cancelled';
    const timedOut = result.status === 'timeout' ||
      (snapshot.triage.result && snapshot.triage.result.status === 'timeout');
    const errors = result.errors || [];

    const fixes = events.filter(function (e) { return e.type === 'fix_done'; })
      .map(function (e) { return { key: e.item, sha: e.sha, text: e.summary }; });

    // Opt-in roll-up comment on the PR. Idempotent server-side: a summary_posted
    // event (replayed from the log) means it's already done.
    const summaryEv = events.find(function (e) { return e.type === 'summary_posted'; });
    const [summing, setSumming] = useState(false);
    const [summErr, setSummErr] = useState(null);
    function postSummary() {
      setSumming(true); setSummErr(null);
      PRR.api.post('reply/summary').then(function () { setSumming(false); }).catch(function (e) { setSummErr(e.message); setSumming(false); });
    }

    // Clear saved drafts once on a clean finish (matches the old renderFinal).
    useEffect(function () {
      PRR.keys.setScope(null);
      if (!cancelled && !errors.length) PRR.store.clear();
    }, []);

    const body = html`<div className="view">
      <header><h1>${cancelled ? (timedOut ? 'Session timed out' : 'Session cancelled') : 'All done'}</h1>
        <div className="sub"><b>${snapshot.repo ? snapshot.repo.nameWithOwner : ''}#${snapshot.pr ? snapshot.pr.number : ''}</b> · return to ${PRR.agentRef(snapshot)}'s session for the summary</div>
      </header>
      <${C.Summary}
        cancelled=${cancelled}
        timedOut=${!!timedOut}
        posted=${result.posted || []}
        errors=${errors}
        resolved=${result.resolved || []}
        fixes=${fixes}
        labelFor=${function (k) { return labelFor(snapshot, k); }} />
      ${!cancelled ? html`<div className="summary-action">
        ${summaryEv
          ? html`<span className="status-line posted">✓ Summary comment posted${(summaryEv.url && summaryEv.url !== '(dry-run)') ? html` — <a href=${summaryEv.url} target="_blank" rel="noopener">view on the PR</a>` : ' (dry run)'}</span>`
          : html`<${Fragment}><button onClick=${postSummary} disabled=${summing}>${summing ? 'Posting…' : 'Post a summary comment to the PR'}</button>${summErr ? html`<span className="status-line failed">✗ ${summErr}</span>` : null}</${Fragment}>`}
      </div>` : null}
    </div>`;

    const footer = html`<${Fragment}>
      <${C.Stepper} phase=${snapshot.phase} />
      <span className="footer-note">this tab can be closed</span>
      <button id="close-tab" onClick=${function () { window.close(); }}>Close tab</button>
    </${Fragment}>`;

    return html`<${C.Shell} footer=${footer}>${body}</${C.Shell}>`;
  };
})();
