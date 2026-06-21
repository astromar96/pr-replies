'use strict';
/* Triage view — decide fix / reply / skip per item, with filtering, batch
 * actions, file/reviewer grouping and keyboard-first navigation. Per-item
 * decisions live in React state (fully controlled), persisted to localStorage
 * + mirrored to the server, and restorable after a refresh. */
(function () {
  const html = PRR.html;
  const C = PRR.components;
  const Fragment = PRR.hooks.Fragment;
  const useState = PRR.hooks.useState;
  const useEffect = PRR.hooks.useEffect;
  const useRef = PRR.hooks.useRef;
  const useMemo = PRR.hooks.useMemo;
  const useCallback = PRR.hooks.useCallback;

  const FILTER_CHIPS = [['all', 'All'], ['fix', 'Fix'], ['reply', 'Reply'], ['skip', 'Skip'], ['outdated', 'Outdated']];
  const SEG_OPTS = [['fix', 'Fix'], ['reply', 'Reply only'], ['skip', 'Skip']];

  PRR.help.triage = [
    ['j / k', 'next / previous comment'],
    ['1 / 2 / 3', 'set Fix / Reply / Skip'],
    ['e', 'edit guidance'],
    ['t', 'insert a template'],
    ['o', 'toggle diff'],
    ['/', 'filter'],
    ['⌘↩', 'continue'],
    ['?', 'toggle this help'],
  ];

  function defaultAction(item, snapshot) {
    return item.suggestedAction || snapshot.config.defaultTriageAction || 'reply';
  }
  function searchText(item) {
    const comments = item.comments || [{ author: item.author, body: item.body }];
    return [item.path || 'general']
      .concat(comments.map(function (c) { return c.author + ' ' + c.body; }))
      .join(' ').toLowerCase();
  }

  function TriageCard(props) {
    const item = props.item;
    const key = props.itemKey;
    const isIssue = props.kind === 'issue';
    const dec = props.dec;
    return html`<div className=${'card' + (props.focused ? ' focused' : '') + (props.hidden ? ' hidden' : '')}
      data-card=${key} data-outdated=${(!isIssue && item.isOutdated) ? '1' : '0'} tabIndex=${-1}>
      <div className="card-head">
        ${isIssue
          ? html`<span className="badge">general comment</span>`
          : html`<${Fragment}><${C.LocBadge} item=${item} />${item.isOutdated ? html`<span className="badge warn">outdated</span>` : null}</${Fragment}>`}
        <${C.ConfBadge} item=${item} />
      </div>
      ${(!isIssue && item.diffHunk) ? html`<details className="hunk" open><summary>diff context</summary><${C.Diff} text=${item.diffHunk} /></details>` : null}
      <${C.Comments} snapshot=${props.snapshot} comments=${isIssue ? [item] : item.comments} />
      <div className="controls">
        ${item.fixPlan ? html`<div className="fixplan"><span className="label">${PRR.agentRefCap(props.snapshot)}’s proposed fix</span><${C.Md} src=${item.fixPlan} /></div>` : null}
        ${item.proposedDiff ? html`<div className="sketch"><span className="label">${PRR.agentRefCap(props.snapshot)}’s sketch — not yet applied</span><${C.Diff} text=${item.proposedDiff} /></div>` : null}
        <${C.Seg} name=${'seg-' + key} value=${dec.action} options=${SEG_OPTS} onChange=${props.onAction} />
        <textarea data-guidance=${key} value=${dec.guidance} aria-label=${'Guidance for ' + PRR.agentRef(props.snapshot)}
          placeholder=${'Optional guidance for ' + PRR.agentRef(props.snapshot) + ' (how to fix, what to say…)'}
          onChange=${function (e) { props.onGuidance(e.target.value); }} />
        <div className="assignee"><label>Assign</label>
          <input list="prr-assignees" data-assignee=${key} value=${dec.assignee} placeholder="teammate (optional)" aria-label="Assign to teammate"
            onChange=${function (e) { props.onAssignee(e.target.value); }} /></div>
      </div>
    </div>`;
  }

  PRR.views.triage = function TriageView(props) {
    const snapshot = props.snapshot;
    const P = snapshot.triage.payload;
    const mode = PRR.useStore(PRR.stores.groupBy);
    const assignees = (P.pr && P.pr.assignableUsers) || [];

    const allItems = useMemo(function () {
      return P.reviewThreads.map(function (t) { return { kind: 'review', item: t, key: PRR.itemKey(t) }; })
        .concat(P.issueComments.map(function (c) { return { kind: 'issue', item: c, key: PRR.itemKey(c) }; }));
    }, [P]);
    const searchMap = useMemo(function () {
      const m = {}; allItems.forEach(function (it) { m[it.key] = searchText(it.item); }); return m;
    }, [allItems]);

    const [decisions, setDecisions] = useState(function () {
      const d = {};
      allItems.forEach(function (it) { d[it.key] = { action: defaultAction(it.item, snapshot), guidance: '', assignee: '' }; });
      return d;
    });
    const setItem = useCallback(function (key, patch) {
      setDecisions(function (prev) { const n = {}; n[key] = Object.assign({}, prev[key], patch); return Object.assign({}, prev, n); });
    }, []);

    const [q, setQ] = useState('');
    const [chip, setChip] = useState('all');
    const [locked, setLocked] = useState(false);
    const [lockMsg, setLockMsg] = useState('');
    // transient toolbar confirmation for the batch buttons; { text, muted }
    const [batchMsg, setBatchMsg] = useState(null);
    const batchTimer = useRef(null);
    const flashBatch = useCallback(function (text, muted) {
      setBatchMsg({ text: text, muted: !!muted });
      clearTimeout(batchTimer.current);
      batchTimer.current = setTimeout(function () { setBatchMsg(null); }, 2800);
    }, []);

    const ring = PRR.useFocusRing();
    const filterRef = useRef(null);
    const viewRef = useRef(null);

    // ---- visibility ----
    const visible = useMemo(function () {
      const query = q.trim().toLowerCase();
      const vis = {};
      allItems.forEach(function (it) {
        const action = decisions[it.key].action;
        let ok = !query || (searchMap[it.key] || '').indexOf(query) !== -1;
        if (ok && chip === 'outdated') ok = (it.kind === 'review' && !!it.item.isOutdated);
        else if (ok && chip !== 'all') ok = action === chip;
        vis[it.key] = ok;
      });
      return vis;
    }, [q, chip, decisions, allItems, searchMap]);
    const visibleKeys = useMemo(function () {
      return allItems.filter(function (it) { return visible[it.key]; }).map(function (it) { return it.key; });
    }, [allItems, visible]);
    useEffect(function () { ring.setVisible(visibleKeys); }, [visibleKeys]);

    // ---- stable refs for keyboard handlers ----
    const stateRef = useRef();
    stateRef.current = { decisions: decisions, allItems: allItems, snapshot: snapshot, locked: locked };
    const submitRef = useRef(function () {});

    // ---- persistence (debounced) ----
    const persistRef = useRef(null);
    if (!persistRef.current) {
      persistRef.current = PRR.debounce(function () {
        const triage = {};
        const cur = stateRef.current.decisions;
        Object.keys(cur).forEach(function (k) { triage[k] = { action: cur[k].action, guidance: cur[k].guidance, assignee: cur[k].assignee }; });
        PRR.store.save({ triage: triage });
        PRR.api.post('data/decisions', { triage: triage }).catch(function () {});
      }, 300);
    }
    const mounted = useRef(false);
    useEffect(function () { if (mounted.current) persistRef.current(); else mounted.current = true; }, [decisions]);

    // ---- restore drafts (once) ----
    const applySaved = useCallback(function (saved) {
      setDecisions(function (prev) {
        const next = Object.assign({}, prev);
        allItems.forEach(function (it) {
          const s = saved[it.key];
          if (!s) return;
          next[it.key] = {
            action: s.action || prev[it.key].action,
            guidance: s.guidance || prev[it.key].guidance,
            assignee: s.assignee || prev[it.key].assignee,
          };
        });
        return next;
      });
    }, [allItems]);
    useEffect(function () {
      const loaded = PRR.store.load();
      const saved = loaded.triage;
      if (!saved) return;
      const dirty = allItems.some(function (it) {
        const s = saved[it.key];
        return s && (s.guidance || s.assignee || s.action !== defaultAction(it.item, snapshot));
      });
      if (!dirty) return;
      const b = PRR.banner('warn', 'Found triage edits from ' + PRR.relTime(loaded.savedAt) + '.', [
        { label: 'Restore', onClick: function () { applySaved(saved); b.dismiss(); } },
        { label: 'Dismiss', onClick: function () { b.dismiss(); } },
      ]);
    }, []); // eslint-disable-line

    // ---- inert while locked ----
    useEffect(function () { if (viewRef.current) viewRef.current.inert = locked; }, [locked]);

    // ---- actions ----
    function insertGuidance(key, ta, text) {
      const s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
      const e = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
      const cur = stateRef.current.decisions[key].guidance || '';
      setItem(key, { guidance: cur.slice(0, s) + text + cur.slice(e) });
      requestAnimationFrame(function () { try { ta.focus(); ta.selectionStart = ta.selectionEnd = s + text.length; } catch (_) {} });
    }

    function submit() {
      if (stateRef.current.locked) return;
      const cur = stateRef.current.decisions;
      const out = stateRef.current.allItems.map(function (it) {
        const d = { kind: it.kind, action: cur[it.key].action, guidance: (cur[it.key].guidance || '').trim() };
        const assignee = (cur[it.key].assignee || '').trim();
        if (assignee) d.assignee = assignee;
        if (it.kind === 'review') d.threadId = it.item.id; else d.databaseId = it.item.databaseId;
        return d;
      });
      setLocked(true); setLockMsg('Submitting…');
      PRR.api.post('triage/submit', { decisions: out }).catch(function (e) {
        PRR.banner('err', 'Failed to submit: ' + e.message + ' — is the session still running?');
        setLocked(false); setLockMsg('');
      });
      // success path: the phase SSE event swaps the view to progress
    }
    submitRef.current = submit;

    function cancel() { setLocked(true); setLockMsg('Cancelling…'); PRR.api.post('triage/cancel').catch(function () {}); }

    function acceptSuggestions() {
      const counts = { fix: 0, reply: 0, skip: 0 };
      allItems.forEach(function (it) { const a = defaultAction(it.item, snapshot); counts[a] = (counts[a] || 0) + 1; });
      setDecisions(function (prev) {
        const n = Object.assign({}, prev);
        allItems.forEach(function (it) { n[it.key] = Object.assign({}, n[it.key], { action: defaultAction(it.item, snapshot) }); });
        return n;
      });
      const parts = ['fix', 'reply', 'skip'].filter(function (a) { return counts[a]; }).map(function (a) { return counts[a] + ' ' + a; });
      flashBatch('✓ Reset to ' + PRR.agentRef(snapshot) + '’s suggestions · ' + (parts.join(' · ') || 'nothing to apply'));
    }
    function skipOutdated() {
      const n = allItems.filter(function (it) { return it.kind === 'review' && it.item.isOutdated; }).length;
      setDecisions(function (prev) {
        const next = Object.assign({}, prev);
        allItems.forEach(function (it) { if (it.kind === 'review' && it.item.isOutdated) next[it.key] = Object.assign({}, next[it.key], { action: 'skip' }); });
        return next;
      });
      flashBatch(n ? '✓ Skipped ' + PRR.plural(n, 'outdated thread') : 'No outdated threads to skip', !n);
    }
    function batchSet(action) {
      setDecisions(function (prev) {
        const n = Object.assign({}, prev);
        visibleKeys.forEach(function (k) { n[k] = Object.assign({}, n[k], { action: action }); });
        return n;
      });
    }

    // ---- keyboard (registered once) ----
    useEffect(function () {
      function focusedKey() { return ring.currentKey(); }
      function actOnFocused(action) { const k = focusedKey(); if (k) setItem(k, { action: action }); }
      PRR.keys.register('triage', {
        'j': function () { ring.move(1); },
        'k': function () { ring.move(-1); },
        'arrowdown': function () { ring.move(1); },
        'arrowup': function () { ring.move(-1); },
        '1': function () { actOnFocused('fix'); },
        '2': function () { actOnFocused('reply'); },
        '3': function () { actOnFocused('skip'); },
        'e': function () { const k = focusedKey(); const el = k && PRR.cardEl(k); const ta = el && el.querySelector('textarea'); if (ta) ta.focus(); },
        'o': function () { const k = focusedKey(); const el = k && PRR.cardEl(k); const d = el && el.querySelector('details'); if (d) d.open = !d.open; },
        't': function () {
          const k = focusedKey(); if (!k) return;
          const el = PRR.cardEl(k); const ta = el && el.querySelector('textarea[data-guidance]'); if (!ta) return;
          const it = stateRef.current.allItems.find(function (x) { return x.key === k; });
          PRR.openPicker({ scope: 'guidance', ctx: it ? PRR.templateCtx(it.item, snapshot) : {}, onPick: function (text) { insertGuidance(k, ta, text); } });
        },
        '/': function () { if (filterRef.current) filterRef.current.focus(); },
        '?': function () { PRR.stores.help.toggle('triage'); },
        'escape': function () { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); PRR.stores.help.toggle(false); },
        'mod+enter': function () { submitRef.current(); },
      });
      PRR.keys.setScope('triage');
    }, []); // eslint-disable-line

    // ---- derived ----
    const counts = useMemo(function () {
      const c = { fix: 0, reply: 0, skip: 0 };
      allItems.forEach(function (it) { c[decisions[it.key].action]++; });
      return c;
    }, [decisions, allItems]);
    const groups = PRR.groupThreads(P.reviewThreads, mode);
    const shown = visibleKeys.length;
    const matchText = (q.trim() || chip !== 'all') ? shown + ' shown' : '';

    function cardFor(it) {
      const dec = decisions[it.key];
      return html`<${TriageCard} key=${it.key} snapshot=${snapshot} kind=${it.kind} item=${it.item} itemKey=${it.key} dec=${dec}
        focused=${ring.focused === it.key} hidden=${!visible[it.key]}
        onAction=${function (a) { setItem(it.key, { action: a }); }}
        onGuidance=${function (v) { setItem(it.key, { guidance: v }); }}
        onAssignee=${function (v) { setItem(it.key, { assignee: v }); }} />`;
    }

    const header = html`<header>
      <h1><a href=${P.pr.url} target="_blank" rel="noopener">${P.pr.title}</a></h1>
      <div className="sub"><a href=${P.pr.url} target="_blank" rel="noopener">${P.repo.nameWithOwner}#${P.pr.number}</a> by ${P.pr.author}
        ${' · '}${PRR.plural(P.reviewThreads.length, 'review thread')}${' · '}${PRR.plural(P.issueComments.length, 'general comment')}
        ${' · '}<b>choose what ${PRR.agentRef(snapshot)} should do</b>${' · '}<kbd>?</kbd> shortcuts</div>
    </header>`;

    const toolbar = html`<div className="toolbar">
      <div className="row">
        <input className="filter" id="filter" ref=${filterRef} aria-label="Filter comments by file, author, or text" placeholder="Filter by file, author, text…  ( / )" value=${q} onChange=${function (e) { setQ(e.target.value); }} />
        ${FILTER_CHIPS.map(function (c) {
          const active = chip === c[0];
          function pick() { setChip(c[0]); }
          // Keyboard-reachable: role/tabIndex/Enter-Space/aria-pressed, mirroring
          // the reply variant picker. Stays a <span> so .chip CSS and the
          // data-chip harness selector are unchanged.
          return html`<span key=${c[0]} className=${'chip' + (active ? ' active' : '')} data-chip=${c[0]}
            role="button" tabIndex=${0} aria-pressed=${active}
            onClick=${pick} onKeyDown=${function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}>${c[1]}</span>`;
        })}
        <span className="match-count" id="match-count">${matchText}</span>
      </div>
      <div className="row">
        <button className="small" id="batch-suggest" onClick=${acceptSuggestions}>Accept all suggestions</button>
        <button className="small" id="batch-skip-outdated" onClick=${skipOutdated}>Skip all outdated</button>
        ${batchMsg ? html`<span className=${'batch-status' + (batchMsg.muted ? ' muted' : '')} role="status">${batchMsg.text}</span>` : null}
        <span className="footer-note">set filtered to:</span>
        <button className="small" data-batch="fix" onClick=${function () { batchSet('fix'); }}>Fix</button>
        <button className="small" data-batch="reply" onClick=${function () { batchSet('reply'); }}>Reply</button>
        <button className="small" data-batch="skip" onClick=${function () { batchSet('skip'); }}>Skip</button>
        <span className="spacer"></span>
        <${C.GroupSeg} mode=${mode} onChange=${PRR.stores.groupBy.choose} />
      </div>
    </div>`;

    const body = html`<div className="view" ref=${viewRef}>
      ${header}
      ${toolbar}
      <${C.AssigneesDatalist} users=${assignees} />
      ${groups.map(function (g) {
        const groupVisible = g.threads.some(function (t) { return visible[PRR.itemKey(t)]; });
        return html`<div key=${g.key} className="file-group" data-file=${g.key} style=${{ display: groupVisible ? undefined : 'none' }}>
          <${C.GroupHeader} group=${g} mode=${mode} snapshot=${snapshot} />
          ${g.threads.map(function (t) { return cardFor({ kind: 'review', item: t, key: PRR.itemKey(t) }); })}
        </div>`;
      })}
      ${!groups.length ? html`<${Fragment}><h2>Review threads</h2><p className="empty">No unresolved review threads.</p></${Fragment}>` : null}
      <h2>General comments</h2>
      ${P.issueComments.length
        ? P.issueComments.map(function (c) { return cardFor({ kind: 'issue', item: c, key: PRR.itemKey(c) }); })
        : html`<p className="empty">No general comments.</p>`}
    </div>`;

    const footer = html`<${Fragment}>
      <${C.Stepper} phase=${snapshot.phase} />
      ${snapshot.noPost ? html`<span className="footer-note">dry run — nothing will be posted</span>` : null}
      <button id="cancel" disabled=${locked} onClick=${cancel}>Cancel session</button>
      <button id="submit" className="primary" disabled=${locked} onClick=${submit}>${locked ? lockMsg : 'Continue · ' + counts.fix + ' fix · ' + counts.reply + ' reply · ' + counts.skip + ' skip'}</button>
    </${Fragment}>`;

    return html`<${C.Shell} footer=${footer}>${body}</${C.Shell}>`;
  };
})();
