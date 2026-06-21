'use strict';
/* Shared presentational components. They render the exact same class names /
 * ids / data-attributes as the original vanilla UI, so ui.css and the
 * Playwright harness keep working unchanged. Markdown and diffs go through
 * dangerouslySetInnerHTML fed by the escape-first renderers in util.js. */
(function () {
  const html = PRR.html;
  const Fragment = PRR.hooks.Fragment;
  const useState = PRR.hooks.useState;
  const useEffect = PRR.hooks.useEffect;
  const useRef = PRR.hooks.useRef;
  const useSyncExternalStore = PRR.hooks.useSyncExternalStore;
  const C = PRR.components;

  // ---------- raw HTML (markdown / diff) ----------
  // Memoized: props are plain strings, so a re-render with the same src/text
  // skips both the vdom and (via util.js) the parse — the large-PR hot path.
  C.Md = PRR.React.memo(function (props) {
    return html`<div dangerouslySetInnerHTML=${{ __html: PRR.renderMarkdown(props.src) }} />`;
  });
  C.Diff = PRR.React.memo(function (props) {
    if (!props.text) return null;
    return html`<div dangerouslySetInnerHTML=${{ __html: PRR.renderDiff(props.text) }} />`;
  });
  C.Spinner = function () { return html`<span className="spinner"></span>`; };

  // ---------- badges ----------
  C.LocBadge = function (props) { return html`<span className="badge">${PRR.locText(props.item)}</span>`; };

  C.StateBadge = function (props) {
    const state = PRR.reviewerState(props.snapshot, props.author);
    if (state === 'CHANGES_REQUESTED') return html`<span className="badge state state-changes">changes requested</span>`;
    if (state === 'APPROVED') return html`<span className="badge state state-approved">approved</span>`;
    return null;
  };

  C.ConfBadge = function (props) {
    if (!props.item.confidence) return null;
    return html`<span className=${'badge conf conf-' + props.item.confidence}>${props.item.confidence} confidence</span>`;
  };

  // ---------- comments ----------
  // A comment renders as a conversation row: a tinted, per-author avatar in a
  // left rail, then the author / time meta and the markdown body. Consecutive
  // comments are divided by a hairline (see .comment + .comment in ui.css) so a
  // multi-comment thread reads as a thread, not one undifferentiated block.
  C.Comment = function (props) {
    const c = props.c;
    const author = c.author || 'unknown';
    const initial = (author.replace(/^@/, '').charAt(0) || '?').toUpperCase();
    const rc = 'var(--reviewer-' + PRR.reviewerColor(author) + ')';
    return html`<div className="comment">
      <div className="avatar" aria-hidden="true" style=${{ '--rc': rc }}>${initial}</div>
      <div className="comment-main">
        <div className="meta"><b>${author}</b><${C.StateBadge} snapshot=${props.snapshot} author=${author} /><span className="time">${PRR.relTime(c.createdAt)}</span></div>
        <${C.Md} src=${c.body} />
      </div>
    </div>`;
  };
  C.Comments = function (props) {
    return (props.comments || []).map(function (c, i) {
      return html`<${C.Comment} key=${i} snapshot=${props.snapshot} c=${c} />`;
    });
  };

  // ---------- segmented toggles ----------
  // options: [[value, label], ...]; controlled by `value`, onChange(value).
  C.Seg = function (props) {
    const name = props.name;
    return html`<div className="seg">${props.options.map(function (o) {
      return html`<label key=${o[0]}>
        <input type="radio" name=${name} value=${o[0]} checked=${props.value === o[0]} disabled=${!!props.disabled}
          onChange=${function () { props.onChange(o[0]); }} />
        <span>${o[1]}</span>
      </label>`;
    })}</div>`;
  };

  // group-by control (File / Reviewer) — reviewer is intentionally last so the
  // harness can target `.group-seg label:last-child`.
  C.GroupSeg = function (props) {
    const opts = [['file', 'File'], ['reviewer', 'Reviewer']];
    return html`<${Fragment}>
      <span className="footer-note">group by</span>
      <div className="seg group-seg">${opts.map(function (o) {
        return html`<label key=${o[0]}>
          <input type="radio" name="groupby" value=${o[0]} checked=${props.mode === o[0]} onChange=${function () { props.onChange(o[0]); }} />
          <span>${o[1]}</span>
        </label>`;
      })}</div>
    </${Fragment}>`;
  };

  C.GroupHeader = function (props) {
    const group = props.group;
    const count = html` <span className="n">· ${PRR.plural(group.threads.length, 'thread')}</span>`;
    if (props.mode === 'reviewer') {
      return html`<div className="file-head reviewer-group">
        <span className="reviewer-chip" style=${{ background: 'var(--reviewer-' + PRR.reviewerColor(group.key) + ')' }}></span>
        ${group.key}<${C.StateBadge} snapshot=${props.snapshot} author=${group.key} />${count}
      </div>`;
    }
    return html`<div className="file-head">${group.key}${count}</div>`;
  };

  C.AssigneesDatalist = function (props) {
    return html`<datalist id="prr-assignees">${(props.users || []).map(function (a, i) {
      return html`<option key=${i} value=${a}></option>`;
    })}</datalist>`;
  };

  // ---------- footer stepper ----------
  const STEPS = [['triage', 'Triage'], ['fixing', 'Fix'], ['reply', 'Reply'], ['done', 'Done']];
  C.Stepper = function (props) {
    const phase = props.phase || 'triage';
    const idx = STEPS.findIndex(function (s) { return s[0] === phase; });
    return html`<div className="stepper">
      ${STEPS.map(function (s, i) {
        const cls = phase === 'cancelled' ? '' : (i < idx || phase === 'done') ? 'done' : i === idx ? 'active' : '';
        return html`<${Fragment} key=${s[0]}><span className=${'step ' + cls}>${s[1]}</span>${i < STEPS.length - 1 ? html`<span className="sep">→</span>` : null}</${Fragment}>`;
      })}
      ${phase === 'cancelled' ? html`<span className="step">cancelled</span>` : null}
    </div>`;
  };

  // ---------- banners (top of #app) ----------
  C.Banners = function () {
    const list = PRR.useStore(PRR.stores.banners);
    return list.map(function (b) {
      // Strings render as escaped text by default (React escapes a text child);
      // only an explicit html:true opts into raw HTML, removing the old
      // every-caller-must-escape footgun.
      const body = typeof b.content === 'string'
        ? (b.html ? html`<span dangerouslySetInnerHTML=${{ __html: b.content }} />` : b.content)
        : b.content;
      // Announce banners to assistive tech — warnings/errors assertively.
      const assertive = /warn|err|danger/.test(b.cls || '');
      return html`<div key=${b.id} className=${'banner ' + b.cls} role=${assertive ? 'alert' : 'status'} aria-live=${assertive ? 'assertive' : 'polite'}>
        ${body}
        ${b.actions ? html`<div className="actions">${b.actions.map(function (a, i) {
          return html`<button key=${i} className=${'small' + (a.primary ? ' primary' : '')} onClick=${a.onClick}>${a.label}</button>`;
        })}</div>` : null}
      </div>`;
    });
  };

  // ---------- empty state ----------
  C.EmptyState = function (props) {
    return html`<div className="empty-state">
      <div className="es-title">${props.title}</div>
      ${props.children ? html`<div className="es-detail">${props.children}</div>` : null}
    </div>`;
  };

  // ---------- help overlay (#help) ----------
  PRR.help = {};   // registry: scope name -> [[keys, description], ...]
  C.HelpOverlay = function () {
    const st = PRR.useStore(PRR.stores.help);
    const entries = (st.open && PRR.help[st.scope]) || [];
    return html`<div id="help" className="overlay" hidden=${!st.open} onClick=${function () { PRR.stores.help.toggle(false); }}>
      ${st.open ? html`<div className="help-card"><h3>Keyboard shortcuts</h3><table><tbody>
        ${entries.map(function (e, i) {
          return html`<tr key=${i}><td>${e[0].split(' / ').map(function (k, j) {
            return html`<${Fragment} key=${j}>${j > 0 ? ' / ' : null}<kbd>${k}</kbd></${Fragment}>`;
          })}</td><td>${e[1]}</td></tr>`;
        })}
      </tbody></table></div>` : null}
    </div>`;
  };

  // ---------- insert-template picker (shared popover) ----------
  // openPicker({ scope, ctx, onPick }) — onPick(appliedBody) is called with the
  // template's body after {{var}} substitution; the caller inserts it.
  let pickerState = { open: false, list: [], ctx: {}, onPick: null };
  const pickerSubs = new Set();
  function setPicker(s) { pickerState = s; pickerSubs.forEach(function (f) { f(); }); }
  const pickerStore = { get: function () { return pickerState; }, subscribe: function (f) { pickerSubs.add(f); return function () { pickerSubs.delete(f); }; } };
  function closePicker() { setPicker({ open: false, list: [], ctx: {}, onPick: null }); }

  PRR.openPicker = function (opts) {
    if (pickerState.open) return;
    PRR.templates.load().then(function (all) {
      const scope = opts.scope;
      const list = all.filter(function (t) { const s = t.scope || 'reply'; return !scope || s === scope || s === 'both'; });
      setPicker({ open: true, list: list, ctx: opts.ctx || {}, onPick: opts.onPick });
    }).catch(function () { /* leave closed */ });
  };

  C.PickerOverlay = function () {
    const st = useSyncExternalStore(pickerStore.subscribe, pickerStore.get);
    const firstRow = useRef(null);
    useEffect(function () {
      if (!st.open) return;
      if (firstRow.current) firstRow.current.focus();
      function onKey(ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closePicker(); } }
      document.addEventListener('keydown', onKey, true);
      return function () { document.removeEventListener('keydown', onKey, true); };
    }, [st.open]);
    if (!st.open) return null;
    return html`<div className="overlay" onClick=${function (e) { if (e.target === e.currentTarget) closePicker(); }}>
      <div className="help-card insert-picker"><h3>Insert template</h3>
        <div className="insert-list">
          ${st.list.length ? st.list.map(function (t, i) {
            const applied = PRR.templates.apply(t.body, st.ctx);
            return html`<button key=${i} className="insert-row" ref=${i === 0 ? firstRow : null}
              onClick=${function () { st.onPick(applied); closePicker(); }}>
              <span className="ir-name">${t.name}</span>
              <span className="ir-body">${applied.replace(/\s+/g, ' ').slice(0, 140)}</span>
            </button>`;
          }) : html`<div className="empty" style=${{ padding: '8px 2px' }}>No templates for this field yet — add some under <b>Templates</b>.</div>`}
        </div>
      </div>
    </div>`;
  };

  // ---------- page shell ----------
  // The <main id="app"> + <footer id="footer"> skeleton each view fills. Banners
  // render at the top of #app, exactly where the old PRR.banner inserted them.
  // `appRef` lets a view mark its content inert while a submit is in flight.
  C.Shell = function (props) {
    return html`<${Fragment}>
      <main className="wrap" id="app" ref=${props.appRef || null}>
        <${C.Banners} />
        ${props.children}
      </main>
      <footer id="footer">${props.footer}</footer>
    </${Fragment}>`;
  };

  // ---------- shared summary (done view + history detail) ----------
  C.Summary = function (props) {
    const posted = props.posted || [];
    const errors = props.errors || [];
    const resolved = props.resolved || [];
    const fixes = props.fixes || [];
    const label = props.labelFor || function (k) { return k; };

    let banner;
    if (props.cancelled) {
      banner = html`<div className=${'banner ' + (props.timedOut ? 'warn' : 'ok')}>
        ${props.timedOut ? 'The session window elapsed.' : 'Cancelled — no replies were posted.'}${fixes.length ? ' Fix commits already pushed remain on the branch.' : ''}
      </div>`;
    } else {
      banner = html`<div className=${'banner ' + (errors.length ? 'warn' : 'ok')}>
        ${PRR.plural(posted.length, 'reply')} posted${resolved.length ? ', ' + PRR.plural(resolved.length, 'thread') + ' resolved' : ''}${errors.length ? ', ' + errors.length + ' failed' : ''}.
      </div>`;
    }

    const rows = [];
    fixes.forEach(function (f, i) {
      rows.push(html`<div className="trow" key=${'f' + i}><span className="t-icon ok">✓</span><span className="t-label">${label(f.key)}</span><span className="t-meta"><span className="badge fixed">${f.sha || ''}</span>${f.text || ''}</span></div>`);
    });
    posted.forEach(function (p, i) {
      rows.push(html`<div className="trow" key=${'p' + i}><span className="t-icon ok">✓</span><span className="t-label">${label(p.key)}</span><span className="t-meta">${(p.url && p.url !== '(dry-run)')
        ? html`<a href=${p.url} target="_blank" rel="noopener">view reply</a>`
        : 'dry run'}</span></div>`);
    });
    errors.forEach(function (e, i) {
      rows.push(html`<div className="trow" key=${'e' + i}><span className="t-icon err">✗</span><span className="t-label">${label(e.key)}</span><span className="t-meta">${e.error || ''}</span></div>`);
    });

    return html`<${Fragment}>${banner}${rows.length ? html`<div className="summary-list">${rows}</div>` : null}</${Fragment}>`;
  };
})();
