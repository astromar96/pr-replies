'use strict';
/* Reply view (phase: reply) — review the agent's drafts, see the actual fix
 * commits, edit with a markdown preview, then post. Posting streams per-item
 * status over SSE (derived from the event store); partial failures stay on
 * screen with Retry / Finish anyway. */
(function () {
  const html = PRR.html;
  const C = PRR.components;
  const Fragment = PRR.hooks.Fragment;
  const useState = PRR.hooks.useState;
  const useEffect = PRR.hooks.useEffect;
  const useRef = PRR.hooks.useRef;
  const useMemo = PRR.hooks.useMemo;
  const useCallback = PRR.hooks.useCallback;

  const SEG_OPTS = [['reply', 'Reply'], ['skip', 'Skip']];

  PRR.help.reply = [
    ['j / k', 'next / previous reply'],
    ['1 / 2', 'set Reply / Skip'],
    ['v', 'switch reply variant'],
    ['e', 'edit draft'],
    ['t', 'insert a template'],
    ['p', 'toggle markdown preview'],
    ['x', 'toggle resolve thread'],
    ['o', 'toggle thread / diff'],
    ['⌘↩', 'send replies'],
    ['?', 'toggle this help'],
  ];

  function statusInner(s) {
    if (!s) return null;
    if (s.status === 'posting') return html`<div className="status-line posting"><${C.Spinner} /> posting…</div>`;
    if (s.status === 'retrying') return html`<div className="status-line retrying"><${C.Spinner} /> retrying (attempt ${s.attempt}) — ${s.error || ''}</div>`;
    if (s.status === 'posted') return html`<div className="status-line posted">✓ Posted${(s.url && s.url !== '(dry-run)') ? html` — <a href=${s.url} target="_blank" rel="noopener">view on GitHub</a>` : ' (dry run)'}</div>`;
    if (s.status === 'interrupted') return html`<div className="status-line interrupted">⚠ Interrupted by a restart — this reply <b>may already be on GitHub</b>. Check the thread before re-sending; it will not be posted again automatically.</div>`;
    if (s.status === 'failed') return html`<div className="status-line failed">✗ Failed: ${s.error || 'unknown error'}</div>`;
    return null;
  }

  // Persistent per-card live region so a posting → posted/failed transition is
  // announced to screen readers (failures/interruptions assertively). The region
  // stays in the DOM even when empty, which is what makes the update announce.
  function StatusLine(props) {
    const s = props.status;
    const assertive = !!s && (s.status === 'failed' || s.status === 'interrupted' || s.status === 'retrying');
    return html`<div className="status-region" role="status" aria-live=${assertive ? 'assertive' : 'polite'}>${statusInner(s)}</div>`;
  }

  function ResolveLine(props) {
    const s = props.resolveStatus;
    if (!s) return null;
    return s.status === 'resolved'
      ? html`<div className="status-line posted">✓ Thread resolved</div>`
      : html`<div className="status-line failed">✗ Could not resolve thread: ${s.error || ''}</div>`;
  }

  function FixCommit(props) {
    const c = props.commit;
    if (c) return html`<details className="hunk"><summary>fix commit <b>${c.sha}</b> — ${c.subject}</summary><${C.Diff} text=${c.diff} /></details>`;
    if (props.fixedIn) return html`<details className="hunk"><summary>fixed in <b>${props.fixedIn}</b> (diff unavailable)</summary></details>`;
    return null;
  }

  function DraftTools(props) {
    const key = props.itemKey;
    return html`<${Fragment}>
      <div className="draft-tools">
        <button className=${props.previewOn ? '' : 'active'} data-tab="edit" data-key=${key} onClick=${function () { props.onTab(false); }}>Edit</button>
        <button className=${props.previewOn ? 'active' : ''} data-tab="preview" data-key=${key} onClick=${function () { props.onTab(true); }}>Preview</button>
      </div>
      <textarea data-text=${key} value=${props.draft} hidden=${props.previewOn} disabled=${props.locked} placeholder="Reply…" aria-label="Reply draft"
        onChange=${function (e) { props.onDraft(e.target.value); }} />
      <div className="preview" data-preview=${key} hidden=${!props.previewOn}
        dangerouslySetInnerHTML=${{ __html: props.draft ? PRR.renderMarkdown(props.draft) : '<span class="empty">nothing to preview</span>' }} />
      <div className="hint">${props.hint}</div>
    </${Fragment}>`;
  }

  // The agent authors two drafts per item — Direct (fix-plan) and Humanized.
  // Show both side-by-side; picking one loads it into the editable draft below.
  // Renders nothing when only one variant exists (back-compat with old payloads).
  function VariantPicker(props) {
    const direct = props.item.draft || '';
    const humanized = props.item.draftHumanized || '';
    if (!direct || !humanized) return null;
    const opts = [['direct', 'Direct · fix plan', direct], ['humanized', 'Humanized', humanized]];
    return html`<${Fragment}>
      <div className="variants-cap">Pick a reply <span>(then edit below)</span></div>
      <div className="variants" data-variants=${props.itemKey}>
        ${opts.map(function (o) {
          const which = o[0];
          const active = props.variant === which;
          function pick() { if (!props.locked) props.onPick(which); }
          return html`<div key=${which} className=${'variant-card' + (active ? ' active' : '') + (props.locked ? ' disabled' : '')}
            role="button" tabIndex=${props.locked ? -1 : 0} aria-pressed=${active} data-variant=${which}
            onClick=${pick} onKeyDown=${function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}>
            <div className="variant-label">${o[1]}${active ? html`<span className="variant-on">✓ chosen</span>` : null}</div>
            <div className="variant-body md" dangerouslySetInnerHTML=${{ __html: PRR.renderMarkdown(o[2]) }} />
          </div>`;
        })}
      </div>
    </${Fragment}>`;
  }

  function AssigneeMention(props) {
    const key = props.itemKey;
    return html`<div className="assignee"><label>Assign</label>
      <input list="prr-assignees" data-assignee=${key} value=${props.assignee} disabled=${props.locked} placeholder="teammate (optional)" aria-label="Assign to teammate"
        onChange=${function (e) { props.onAssignee(e.target.value); }} />
      <label className="mention-label"><input type="checkbox" data-mention=${key} checked=${props.mention} disabled=${props.locked}
        onChange=${function (e) { props.onMention(e.target.checked); }} /> mention @ in reply</label>
    </div>`;
  }

  function ReplyCard(props) {
    const item = props.item;
    const key = props.itemKey;
    const isIssue = props.kind === 'issue';
    const dec = props.dec;
    const head = isIssue
      ? html`<${Fragment}><span className="badge">general comment</span>${item.fixedIn ? html`<span className="badge fixed">fixed in ${item.fixedIn}</span>` : null}</${Fragment}>`
      : html`<${Fragment}><${C.LocBadge} item=${item} />${item.isOutdated ? html`<span className="badge warn">outdated</span>` : null}${item.fixedIn ? html`<span className="badge fixed">fixed in ${item.fixedIn}</span>` : null}</${Fragment}>`;
    const thread = isIssue
      ? html`<details className="thread"><summary>original comment by ${item.author}</summary><${C.Comments} snapshot=${props.snapshot} comments=${[item]} /></details>`
      : html`<details className="thread"><summary>original thread (${PRR.plural(item.comments.length, 'comment')})</summary>${item.diffHunk ? html`<${C.Diff} text=${item.diffHunk} />` : null}<${C.Comments} snapshot=${props.snapshot} comments=${item.comments} /></details>`;
    const hint = isIssue
      ? 'Posts as a new top-level PR comment (GitHub has no threading here).'
      : 'Empty reply = skipped. Markdown supported.';

    return html`<div className=${'card' + (props.focused ? ' focused' : '')} data-card=${key} tabIndex=${-1}>
      <div className="card-head">${head}</div>
      ${thread}
      <${FixCommit} commit=${props.fixCommit} fixedIn=${item.fixedIn} />
      <div className="controls">
        <${C.Seg} name=${'seg-' + key} value=${dec.action} options=${SEG_OPTS} disabled=${props.locked} onChange=${props.onAction} />
        <${VariantPicker} itemKey=${key} item=${item} variant=${dec.variant} locked=${props.locked} onPick=${props.onPickVariant} />
        <${DraftTools} itemKey=${key} draft=${dec.draft} previewOn=${props.previewOn} locked=${props.locked} hint=${hint} onDraft=${props.onDraft} onTab=${props.onTab} />
        ${!isIssue ? html`<div className=${'resolve-row' + (item.viewerCanResolve ? '' : ' disabled')} title=${item.viewerCanResolve ? undefined : 'You cannot resolve this thread (no permission, or the thread is locked)'}>
          <input type="checkbox" data-resolve=${key} checked=${!!dec.resolve && item.viewerCanResolve} disabled=${!item.viewerCanResolve || props.locked}
            onChange=${function (e) { props.onResolve(e.target.checked); }} /> Resolve thread after replying</div>` : null}
        <${AssigneeMention} itemKey=${key} assignee=${dec.assignee} mention=${dec.mention} locked=${props.locked} onAssignee=${props.onAssignee} onMention=${props.onMention} />
      </div>
      <${StatusLine} status=${props.status} />
      <${ResolveLine} resolveStatus=${props.resolveStatus} />
    </div>`;
  }

  PRR.views.reply = function ReplyView(props) {
    const snapshot = props.snapshot;
    const P = snapshot.reply.payload;
    const mode = PRR.useStore(PRR.stores.groupBy);
    const events = PRR.useStore(PRR.stores.events);
    const assignees = (P.pr && P.pr.assignableUsers) || [];
    const autoResolve = snapshot.config.autoResolveFixedThreads;
    const fixCommits = snapshot.reply.fixCommits || {};

    const allItems = useMemo(function () {
      return P.reviewThreads.map(function (t) { return { kind: 'review', item: t, key: PRR.itemKey(t) }; })
        .concat(P.issueComments.map(function (c) { return { kind: 'issue', item: c, key: PRR.itemKey(c) }; }));
    }, [P]);

    // ---- merged item status: snapshot base overlaid with live (seq>baseSeq) events ----
    const baseSeq = snapshot.lastSeq || 0;
    const live = useMemo(function () {
      const status = {}, resolve = {};
      events.forEach(function (e) {
        if (e.seq <= baseSeq) return;
        if (e.type === 'post_item') status[e.key] = { status: e.status, url: e.url, error: e.error, attempt: e.attempt };
        else if (e.type === 'resolve_item') resolve[e.key] = { status: e.status, error: e.error };
      });
      return { status: status, resolve: resolve };
    }, [events, baseSeq]);
    const itemStatus = useMemo(function () { return Object.assign({}, snapshot.reply.itemStatus || {}, live.status); }, [snapshot, live]);

    function isPosted(key) { const s = itemStatus[key]; return !!(s && s.status === 'posted'); }
    function isLocked(key) { const s = itemStatus[key]; return !!(s && (s.status === 'posted' || s.status === 'interrupted')); }

    // ---- per-item decisions ----
    const [decisions, setDecisions] = useState(function () {
      const d = {};
      P.reviewThreads.forEach(function (t) {
        const key = PRR.itemKey(t);
        const resolveOn = t.resolveDefault != null ? t.resolveDefault : (!!t.fixedIn && t.viewerCanResolve && autoResolve);
        d[key] = { action: 'reply', variant: 'direct', draft: t.draft || t.draftHumanized || '', resolve: !!(resolveOn && t.viewerCanResolve), assignee: '', mention: false };
      });
      P.issueComments.forEach(function (c) {
        d[PRR.itemKey(c)] = { action: 'reply', variant: 'direct', draft: c.draft || c.draftHumanized || '', resolve: false, assignee: '', mention: false };
      });
      return d;
    });
    const setItem = useCallback(function (key, patch) {
      setDecisions(function (prev) { const n = {}; n[key] = Object.assign({}, prev[key], patch); return Object.assign({}, prev, n); });
    }, []);

    const [preview, setPreview] = useState({});
    const [posting, setPosting] = useState(false);
    const [lockMsg, setLockMsg] = useState('');

    const ring = PRR.useFocusRing();
    const viewRef = useRef(null);
    useEffect(function () { ring.setVisible(allItems.map(function (it) { return it.key; })); }, [allItems]);
    useEffect(function () { if (viewRef.current) viewRef.current.inert = posting; }, [posting]);

    // ---- stable refs ----
    const stateRef = useRef();
    stateRef.current = { decisions: decisions, allItems: allItems, itemStatus: itemStatus, posting: posting, preview: preview, snapshot: snapshot };
    const submitRef = useRef(function () {});

    // ---- derived counts ----
    function pendingItems() {
      const cur = stateRef.current;
      return cur.allItems.filter(function (it) {
        return !((cur.itemStatus[it.key] && (cur.itemStatus[it.key].status === 'posted' || cur.itemStatus[it.key].status === 'interrupted')))
          && cur.decisions[it.key].action === 'reply' && (cur.decisions[it.key].draft || '').trim();
      });
    }
    const pendingCount = allItems.filter(function (it) { return !isLocked(it.key) && decisions[it.key].action === 'reply' && (decisions[it.key].draft || '').trim(); }).length;
    const failedKeys = Object.keys(itemStatus).filter(function (k) { return itemStatus[k].status === 'failed'; });

    // ---- post_done handling (banner + unlock) ----
    const lastDone = useMemo(function () { let d = null; events.forEach(function (e) { if (e.type === 'post_done' && e.seq > baseSeq) d = e; }); return d; }, [events, baseSeq]);
    const handledDone = useRef(0);
    useEffect(function () {
      if (lastDone && lastDone.seq !== handledDone.current) {
        handledDone.current = lastDone.seq;
        setPosting(false);
        if (lastDone.failed > 0) {
          PRR.banner('err', lastDone.failed + ' of ' + (lastDone.failed + lastDone.posted) + ' replies failed — edit and retry below, or finish anyway.');
        }
      }
    }, [lastDone]);

    // ---- persistence (debounced) ----
    const persistRef = useRef(null);
    if (!persistRef.current) {
      persistRef.current = PRR.debounce(function () {
        const reply = {};
        const cur = stateRef.current.decisions;
        Object.keys(cur).forEach(function (k) {
          reply[k] = { draft: cur[k].draft, variant: cur[k].variant, include: cur[k].action === 'reply', resolve: cur[k].resolve, assignee: cur[k].assignee, mention: cur[k].mention };
        });
        PRR.store.save({ reply: reply });
        PRR.api.post('data/decisions', { reply: reply }).catch(function () {});
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
          const st = stateRef.current.itemStatus[it.key];
          if (!s || (st && st.status === 'posted')) return;
          next[it.key] = Object.assign({}, prev[it.key], {
            draft: s.draft != null ? s.draft : prev[it.key].draft,
            variant: s.variant || prev[it.key].variant,
            action: s.include === false ? 'skip' : 'reply',
            resolve: it.kind === 'review' && it.item.viewerCanResolve ? !!s.resolve : prev[it.key].resolve,
            assignee: s.assignee || prev[it.key].assignee,
            mention: !!s.mention,
          });
        });
        return next;
      });
    }, [allItems]);
    useEffect(function () {
      const loaded = PRR.store.load();
      const saved = loaded.reply;
      if (!saved) return;
      const dirty = allItems.some(function (it) {
        const s = saved[it.key];
        return s && ((s.draft && s.draft !== (it.item.draft || '')) || s.assignee);
      });
      if (!dirty) return;
      const b = PRR.banner('warn', 'Found reply edits from ' + PRR.relTime(loaded.savedAt) + '.', [
        { label: 'Restore', onClick: function () { applySaved(saved); b.dismiss(); } },
        { label: 'Dismiss', onClick: function () { b.dismiss(); } },
      ]);
    }, []); // eslint-disable-line

    // ---- actions ----
    function insertDraft(key, ta, text) {
      const s = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
      const e = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
      const cur = stateRef.current.decisions[key].draft || '';
      setItem(key, { draft: cur.slice(0, s) + text + cur.slice(e) });
      requestAnimationFrame(function () { try { ta.focus(); ta.selectionStart = ta.selectionEnd = s + text.length; } catch (_) {} });
    }

    function variantSources(item) { return { direct: item.draft || '', humanized: item.draftHumanized || '' }; }

    // Load the chosen variant's text into the editable draft. If the user has
    // already edited the draft (it matches neither variant's source), confirm
    // before clobbering — same banner-with-actions idiom as the restore prompt.
    function pickVariant(key, which) {
      const cur = stateRef.current;
      const st = cur.itemStatus[key];
      if (st && (st.status === 'posted' || st.status === 'interrupted')) return;
      const it = cur.allItems.find(function (x) { return x.key === key; });
      if (!it) return;
      const src = variantSources(it.item);
      if (!src.direct || !src.humanized) return;
      const dec = cur.decisions[key];
      if (dec.variant === which && dec.draft === src[which]) return;
      const draft = dec.draft || '';
      const edited = draft.trim() !== '' && draft !== src.direct && draft !== src.humanized;
      if (edited) {
        const label = which === 'direct' ? 'Direct' : 'Humanized';
        const b = PRR.banner('warn', 'Replace your edited draft with the ' + label + ' variant?', [
          { label: 'Replace', onClick: function () { setItem(key, { variant: which, draft: src[which] }); b.dismiss(); } },
          { label: 'Keep mine', onClick: function () { b.dismiss(); } },
        ]);
        return;
      }
      setItem(key, { variant: which, draft: src[which] });
    }

    function submit() {
      const cur = stateRef.current;
      if (cur.posting) return;
      const items = pendingItems();
      if (!items.length) return;
      const replies = [], skipped = [];
      cur.allItems.forEach(function (it) {
        const st = cur.itemStatus[it.key];
        if (st && (st.status === 'posted' || st.status === 'interrupted')) return;
        let body = (cur.decisions[it.key].draft || '').trim();
        const include = cur.decisions[it.key].action === 'reply' && body;
        if (include) {
          const assignee = (cur.decisions[it.key].assignee || '').trim();
          if (assignee && cur.decisions[it.key].mention && body.indexOf('@' + assignee) === -1) body = '@' + assignee + ' ' + body;
          const r = { kind: it.kind, key: it.key, body: body, variant: cur.decisions[it.key].variant };
          if (it.kind === 'review') {
            r.threadId = it.item.id; r.replyToDatabaseId = it.item.replyToDatabaseId; r.path = it.item.path; r.line = it.item.line;
            r.resolve = !!cur.decisions[it.key].resolve;
          }
          replies.push(r);
        } else {
          const s = { kind: it.kind, key: it.key };
          if (it.kind === 'review') { s.threadId = it.item.id; s.path = it.item.path; s.line = it.item.line; } else s.databaseId = it.item.databaseId;
          skipped.push(s);
        }
      });
      setPosting(true); setLockMsg('Posting ' + PRR.plural(replies.length, 'reply') + '…');
      PRR.api.post('reply/submit', { replies: replies, skipped: skipped }).catch(function (e) {
        PRR.banner('err', 'Failed to submit: ' + e.message + ' — is the session still running?');
        setPosting(false);
      });
    }
    submitRef.current = submit;

    function cancel() { setPosting(true); setLockMsg('Cancelling…'); PRR.api.post('reply/cancel').catch(function () {}); }
    function finish() { PRR.api.post('reply/finish').catch(function (e) { PRR.banner('err', e.message); }); }

    // ---- keyboard ----
    useEffect(function () {
      function focusedKey() { return ring.currentKey(); }
      function setFocusedAction(action) {
        const k = focusedKey(); if (!k) return;
        if (stateRef.current.itemStatus[k] && (stateRef.current.itemStatus[k].status === 'posted' || stateRef.current.itemStatus[k].status === 'interrupted')) return;
        setItem(k, { action: action });
      }
      PRR.keys.register('reply', {
        'j': function () { ring.move(1); },
        'k': function () { ring.move(-1); },
        'arrowdown': function () { ring.move(1); },
        'arrowup': function () { ring.move(-1); },
        '1': function () { setFocusedAction('reply'); },
        '2': function () { setFocusedAction('skip'); },
        'v': function () {
          const k = focusedKey(); if (!k) return;
          const it = stateRef.current.allItems.find(function (x) { return x.key === k; });
          if (!it) return;
          const src = variantSources(it.item);
          if (!src.direct || !src.humanized) return;
          pickVariant(k, stateRef.current.decisions[k].variant === 'direct' ? 'humanized' : 'direct');
        },
        'e': function () { const k = focusedKey(); if (!k || stateRef.current.preview[k]) return; const el = PRR.cardEl(k); const ta = el && el.querySelector('textarea'); if (ta && !ta.hidden) ta.focus(); },
        'p': function () { const k = focusedKey(); if (k) setPreview(function (prev) { const n = {}; n[k] = !prev[k]; return Object.assign({}, prev, n); }); },
        'x': function () {
          const k = focusedKey(); if (!k) return;
          const it = stateRef.current.allItems.find(function (x) { return x.key === k; });
          if (!it || it.kind !== 'review' || !it.item.viewerCanResolve) return;
          if (stateRef.current.itemStatus[k] && (stateRef.current.itemStatus[k].status === 'posted' || stateRef.current.itemStatus[k].status === 'interrupted')) return;
          setItem(k, { resolve: !stateRef.current.decisions[k].resolve });
        },
        'o': function () { const k = focusedKey(); const el = k && PRR.cardEl(k); const d = el && el.querySelector('details'); if (d) d.open = !d.open; },
        't': function () {
          const k = focusedKey(); if (!k || stateRef.current.preview[k]) return;
          const el = PRR.cardEl(k); const ta = el && el.querySelector('textarea[data-text]'); if (!ta || ta.hidden) return;
          const it = stateRef.current.allItems.find(function (x) { return x.key === k; });
          PRR.openPicker({ scope: 'reply', ctx: it ? PRR.templateCtx(it.item, snapshot) : {}, onPick: function (text) { insertDraft(k, ta, text); } });
        },
        '?': function () { PRR.stores.help.toggle('reply'); },
        'escape': function () { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); PRR.stores.help.toggle(false); },
        'mod+enter': function () { submitRef.current(); },
      });
      PRR.keys.setScope('reply');
    }, []); // eslint-disable-line

    // ---- render ----
    function cardFor(it) {
      const key = it.key;
      return html`<${ReplyCard} key=${key} snapshot=${snapshot} kind=${it.kind} item=${it.item} itemKey=${key} dec=${decisions[key]}
        previewOn=${!!preview[key]} status=${itemStatus[key]} resolveStatus=${live.resolve[key]} fixCommit=${fixCommits[key]}
        locked=${isLocked(key)} focused=${ring.focused === key}
        onAction=${function (a) { setItem(key, { action: a }); }}
        onPickVariant=${function (which) { pickVariant(key, which); }}
        onDraft=${function (v) { setItem(key, { draft: v }); }}
        onResolve=${function (v) { setItem(key, { resolve: v }); }}
        onAssignee=${function (v) { setItem(key, { assignee: v }); }}
        onMention=${function (v) { setItem(key, { mention: v }); }}
        onTab=${function (p) { setPreview(function (prev) { const n = {}; n[key] = p; return Object.assign({}, prev, n); }); }} />`;
    }

    const groups = PRR.groupThreads(P.reviewThreads, mode);
    const autoClose = PRR.store.pref('autoclose');

    const body = html`<div className="view" ref=${viewRef}>
      <header>
        <h1><a href=${P.pr.url} target="_blank" rel="noopener">${P.pr.title}</a></h1>
        <div className="sub"><a href=${P.pr.url} target="_blank" rel="noopener">${P.repo.nameWithOwner}#${P.pr.number}</a>${' · '}<b>review and send replies</b>${' · '}<kbd>?</kbd> shortcuts</div>
      </header>
      <div className="toolbar"><div className="row"><span className="spacer"></span><${C.GroupSeg} mode=${mode} onChange=${PRR.stores.groupBy.choose} /></div></div>
      <${C.AssigneesDatalist} users=${assignees} />
      ${groups.map(function (g) {
        return html`<div key=${g.key} className="file-group">
          <${C.GroupHeader} group=${g} mode=${mode} snapshot=${snapshot} />
          ${g.threads.map(function (t) { return cardFor({ kind: 'review', item: t, key: PRR.itemKey(t) }); })}
        </div>`;
      })}
      ${!groups.length ? html`<${Fragment}><h2>Review threads</h2><p className="empty">No review threads.</p></${Fragment}>` : null}
      <h2>General comments</h2>
      ${P.issueComments.length
        ? P.issueComments.map(function (c) { return cardFor({ kind: 'issue', item: c, key: PRR.itemKey(c) }); })
        : html`<p className="empty">No general comments.</p>`}
    </div>`;

    const submitText = posting ? lockMsg : (failedKeys.length ? 'Retry failed · ' + PRR.plural(pendingCount, 'reply') : 'Send ' + PRR.plural(pendingCount, 'reply'));
    const footer = html`<${Fragment}>
      <${C.Stepper} phase=${snapshot.phase} />
      ${snapshot.noPost ? html`<span className="footer-note">dry run — nothing will be posted</span>` : null}
      ${snapshot.config.signature ? html`<span className="footer-note">signature appended automatically</span>` : null}
      <label className="autoclose" title="Close this tab automatically when the session finishes">
        <input type="checkbox" id="autoclose" defaultChecked=${autoClose !== '0'} onChange=${function (e) { PRR.store.pref('autoclose', e.target.checked); }} /> Auto-close tab</label>
      <span id="extra-actions">${failedKeys.length ? html`<button onClick=${finish}>Finish anyway</button>` : null}</span>
      <button id="cancel" disabled=${posting} onClick=${cancel}>Cancel — post nothing</button>
      <button id="submit" className="primary" disabled=${posting || pendingCount === 0} onClick=${submit}>${submitText}</button>
    </${Fragment}>`;

    return html`<${C.Shell} appRef=${null} footer=${footer}>${body}</${C.Shell}>`;
  };
})();
