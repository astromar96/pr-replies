'use strict';
/* Progress view (phase: fixing) — live timeline while the agent implements the
 * approved fixes. The model is derived purely from the event store (seeded from
 * events.jsonl + live SSE), so a refresh or reconnect is lossless. */
(function () {
  const html = PRR.html;
  const C = PRR.components;
  const Fragment = PRR.hooks.Fragment;
  const useState = PRR.hooks.useState;
  const useEffect = PRR.hooks.useEffect;
  const useMemo = PRR.hooks.useMemo;

  const FIX_EVENTS = ['fix_start', 'fix_done', 'fix_fail', 'fix_skip'];
  const ACTIVITY = FIX_EVENTS.concat(['check', 'push', 'drafting', 'note']);
  const STALL_MS = 3 * 60 * 1000;

  PRR.help.fixing = [['?', 'toggle this help']];

  function buildModel(snapshot, events) {
    const decisions = (snapshot.triage.result && snapshot.triage.result.decisions) || [];
    const P = snapshot.triage.payload;
    const labels = {};
    (P ? P.reviewThreads : []).forEach(function (t) { labels[PRR.itemKey(t)] = t.path + (t.line != null ? ':' + t.line : ''); });
    (P ? P.issueComments : []).forEach(function (c) { labels[PRR.itemKey(c)] = 'general comment by ' + c.author; });

    const items = {};
    decisions.filter(function (d) { return d.action === 'fix'; }).forEach(function (d) {
      const key = d.threadId ? 'review:' + d.threadId : 'issue:' + d.databaseId;
      items[key] = { label: labels[key] || key, status: 'pending' };
    });
    const checks = {};
    let push = null, drafting = false, aborting = false;
    const notes = [];
    events.forEach(function (e) {
      if (FIX_EVENTS.indexOf(e.type) !== -1 && e.item) {
        const row = items[e.item] || (items[e.item] = { label: e.item, status: 'pending' });
        if (e.type === 'fix_start') row.status = 'running';
        if (e.type === 'fix_done') { row.status = 'done'; row.sha = e.sha; row.summary = e.summary; }
        if (e.type === 'fix_fail') { row.status = 'failed'; row.reason = e.reason; }
        if (e.type === 'fix_skip') { row.status = 'skipped'; row.reason = e.reason; }
      } else if (e.type === 'check' && e.name) {
        checks[e.name] = { status: e.status || 'running', detail: e.detail };
      } else if (e.type === 'push') {
        push = { status: e.status || 'ok', detail: e.detail };
      } else if (e.type === 'drafting') {
        drafting = true;
      } else if (e.type === 'note' && e.text) {
        notes.push(e.text);
        if (/abort requested/i.test(e.text)) aborting = true;
      }
    });
    return { items: items, checks: checks, push: push, drafting: drafting, notes: notes, aborting: aborting };
  }

  function Timeline(props) {
    const m = props.model;
    const itemKeys = Object.keys(m.items);
    const checkNames = Object.keys(m.checks);
    const empty = !itemKeys.length && !checkNames.length && !m.push && !m.notes.length && !m.drafting;
    return html`<div className="timeline" id="timeline">
      ${itemKeys.map(function (key) {
        const it = m.items[key];
        const icon = it.status === 'running' ? html`<${C.Spinner} />`
          : it.status === 'done' ? html`<span className="t-icon ok">✓</span>`
          : it.status === 'failed' ? html`<span className="t-icon err">✗</span>`
          : it.status === 'skipped' ? html`<span className="t-icon muted">–</span>`
          : html`<span className="t-icon muted">○</span>`;
        return html`<div key=${key} className=${'trow' + (it.status === 'pending' ? ' pending' : '')}>
          <span className="t-icon">${icon}</span>
          <span className="t-label">${it.label}</span>
          <span className="t-meta">${it.sha ? html`<span className="badge fixed">${it.sha}</span>` : null}${it.summary || it.reason || ''}</span>
        </div>`;
      })}
      ${checkNames.length ? html`<div className="checks">${checkNames.map(function (name) {
        const c = m.checks[name];
        const cls = c.status === 'pass' ? 'fixed' : c.status === 'fail' ? 'conf conf-low' : '';
        return html`<span key=${name} className=${'badge ' + cls}>${name}: ${c.status}${c.detail ? ' — ' + c.detail : ''}</span>`;
      })}</div>` : null}
      ${m.push ? html`<div className="trow"><span className=${'t-icon ' + (m.push.status === 'ok' ? 'ok' : 'err')}>${m.push.status === 'ok' ? '✓' : '✗'}</span>
        <span className="t-meta">git push ${m.push.status === 'ok' ? 'succeeded' : 'failed'}${m.push.detail ? ' — ' + m.push.detail : ''}</span></div>` : null}
      ${m.notes.map(function (n, i) {
        return html`<div key=${'n' + i} className="trow"><span className="t-icon muted">·</span><span className="t-meta">${n}</span></div>`;
      })}
      ${m.drafting ? html`<div className="trow"><span className="t-icon"><${C.Spinner} /></span><span className="t-meta">drafting replies…</span></div>` : null}
      ${empty ? html`<div className="trow"><span className="t-meta">No fixes to implement — drafting replies…</span></div>` : null}
    </div>`;
  }

  PRR.views.fixing = function ProgressView(props) {
    const snapshot = props.snapshot;
    const events = PRR.useStore(PRR.stores.events);
    const model = useMemo(function () { return buildModel(snapshot, events); }, [snapshot, events]);

    const fixCount = Object.keys(model.items).length;
    const replyOnly = ((snapshot.triage.result && snapshot.triage.result.decisions) || [])
      .filter(function (d) { return d.action === 'reply'; }).length;

    const [aborting, setAborting] = useState(false);
    const abortRequested = !!snapshot.abortRequested || model.aborting;

    // stall hint: no activity for STALL_MS.
    const activityCount = useMemo(function () { return events.filter(function (e) { return ACTIVITY.indexOf(e.type) !== -1; }).length; }, [events]);
    const [stalled, setStalled] = useState(false);
    useEffect(function () {
      setStalled(false);
      const t = setTimeout(function () { setStalled(true); }, STALL_MS);
      return function () { clearTimeout(t); };
    }, [activityCount]);

    // keyboard
    useEffect(function () {
      PRR.keys.register('fixing', {
        '?': function () { PRR.stores.help.toggle('fixing'); },
        'escape': function () { PRR.stores.help.toggle(false); },
      });
      PRR.keys.setScope('fixing');
    }, []);

    function abort() { setAborting(true); PRR.api.post('fixing/abort').catch(function () { setAborting(false); }); }

    const body = html`<div className="view">
      <header><h1>Implementing fixes…</h1>
        <div className="sub"><b>${snapshot.repo ? snapshot.repo.nameWithOwner : ''}#${snapshot.pr ? snapshot.pr.number : ''}</b>
          ${' · '}${PRR.agentRefCap(snapshot)} is working on ${PRR.plural(fixCount, 'approved fix')}${replyOnly ? ' · ' + PRR.plural(replyOnly, 'reply-only item') + ' will be drafted after' : ''}</div>
      </header>
      <${Timeline} model=${model} />
      <div id="stall">${stalled ? html`<div className="banner warn stall-hint">No activity for a few minutes. Check ${PRR.agentRef(snapshot)}'s session — if it stopped, re-run <code>/pr-replies</code> to resume, or abort the remaining fixes above.</div>` : null}</div>
    </div>`;

    const footer = html`<${Fragment}>
      <${C.Stepper} phase=${snapshot.phase} />
      <span className="footer-note">you can keep this tab open — replies come next</span>
      <button id="abort" className="danger" disabled=${aborting || abortRequested} onClick=${abort}>
        ${abortRequested ? 'Abort requested — stopping after current fix' : 'Abort remaining fixes'}
      </button>
    </${Fragment}>`;

    return html`<${C.Shell} footer=${footer}>${body}</${C.Shell}>`;
  };
})();
