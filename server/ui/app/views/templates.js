'use strict';
/* Templates route — manage reusable reply snippets. User templates are
 * editable; per-repo templates (.pr-replies/templates.json) are read-only. The
 * shared insert-picker (components.js) reads the same data/templates endpoint
 * and is refreshed via the PRR.templates cache after a save. */
(function () {
  const html = PRR.html;
  const C = PRR.components;
  const Fragment = PRR.hooks.Fragment;
  const useState = PRR.hooks.useState;
  const useEffect = PRR.hooks.useEffect;

  const SCOPES = [['reply', 'Reply'], ['guidance', 'Guidance'], ['both', 'Both']];

  PRR.help.templates = [
    ['g d / g h / g t / g p', 'Dashboard / History / Templates / Active PR'],
    ['?', 'toggle this help'],
  ];

  let idSeq = 0;
  function newId() { return 'template-' + (++idSeq); }

  function UserRow(props) {
    const t = props.t;
    return html`<div className="card tmpl-row" data-id=${t.id} data-source="user">
      <div className="card-head">
        <input className="tmpl-name" placeholder="Template name" value=${t.name} onChange=${function (e) { props.onChange({ name: e.target.value }); }} />
        <select className="tmpl-scope" value=${t.scope || 'reply'} onChange=${function (e) { props.onChange({ scope: e.target.value }); }}>
          ${SCOPES.map(function (s) { return html`<option key=${s[0]} value=${s[0]}>${s[1]}</option>`; })}
        </select>
        <button className="small danger tmpl-del" title="Delete" onClick=${props.onDelete}>Delete</button>
      </div>
      <textarea className="tmpl-body" placeholder="Reply text… use {{author}}, {{sha}}, {{path}}…" value=${t.body} onChange=${function (e) { props.onChange({ body: e.target.value }); }} />
    </div>`;
  }

  function RepoRow(props) {
    const t = props.t;
    return html`<div className="card tmpl-row" data-source="repo">
      <div className="card-head"><b>${t.name}</b><span className="badge">from repo</span><span className="badge">${t.scope || 'reply'}</span></div>
      <div className="tmpl-readonly">${t.body}</div>
    </div>`;
  }

  PRR.routes.templates = function TemplatesView() {
    const [rows, setRows] = useState(null);   // user (editable) rows
    const [repo, setRepo] = useState([]);     // read-only repo rows
    const [error, setError] = useState(null);
    const [note, setNote] = useState('');
    const [saving, setSaving] = useState(false);

    function ingest(list) {
      PRR.templates._cache = list || [];
      const user = (list || []).filter(function (t) { return !t.readonly; }).map(function (t) { return { uid: t.id || newId(), id: t.id || newId(), name: t.name || '', scope: t.scope || 'reply', body: t.body || '' }; });
      setRows(user);
      setRepo((list || []).filter(function (t) { return t.readonly; }));
    }
    useEffect(function () {
      PRR.api.get('data/templates').then(function (d) { ingest(d.templates || []); }).catch(function (e) { setError(e.message); });
    }, []);
    useEffect(function () {
      PRR.keys.register('templates', { '?': function () { PRR.stores.help.toggle('templates'); }, 'escape': function () { PRR.stores.help.toggle(false); } });
      PRR.keys.setScope('templates');
    }, []);

    function addRow() { const id = newId(); setRows(function (r) { return (r || []).concat([{ uid: id, id: id, name: '', scope: 'reply', body: '' }]); }); }
    function updateRow(uid, patch) { setRows(function (r) { return r.map(function (x) { return x.uid === uid ? Object.assign({}, x, patch) : x; }); }); }
    function deleteRow(uid) { setRows(function (r) { return r.filter(function (x) { return x.uid !== uid; }); }); }

    function save() {
      const templates = (rows || []).filter(function (t) { return t.name || t.body.trim(); })
        .map(function (t) { return { id: t.id, name: t.name.trim(), scope: t.scope, body: t.body }; });
      setSaving(true);
      PRR.api.post('data/templates', { templates: templates }).then(function (d) {
        setSaving(false);
        setNote('Saved ' + PRR.plural(templates.length, 'template') + '.');
        ingest(d.templates || []);
      }).catch(function (e) { setSaving(false); PRR.banner('err', 'Could not save templates: ' + PRR.esc(e.message)); });
    }

    let bodyInner;
    if (error) bodyInner = html`<div className="banner err">Could not load templates: ${error}</div>`;
    else if (rows === null) bodyInner = html`<div className="boot">Loading…</div>`;
    else {
      bodyInner = html`<${Fragment}>
        <div className="tmpl-list" id="tmpl-user">
          ${rows.length
            ? rows.map(function (t) { return html`<${UserRow} key=${t.uid} t=${t} onChange=${function (p) { updateRow(t.uid, p); }} onDelete=${function () { deleteRow(t.uid); }} />`; })
            : html`<${C.EmptyState} title="No templates yet">Add one below — it’s saved to <code>~/.config/pr-replies/templates.json</code>.</${C.EmptyState}>`}
        </div>
        ${repo.length ? html`<${Fragment}>
          <h2>From this repo <span className="section-note">(read-only — edit <code>.pr-replies/templates.json</code>)</span></h2>
          <div className="tmpl-list">${repo.map(function (t, i) { return html`<${RepoRow} key=${i} t=${t} />`; })}</div>
        </${Fragment}>` : null}
      </${Fragment}>`;
    }

    const vars = PRR.TEMPLATE_VARS.map(function (v, i) { return html`<${Fragment} key=${v}>${i > 0 ? ' ' : null}<span className="var-pill">{{${v}}}</span></${Fragment}>`; });
    const body = html`<div className="view">
      <header><h1>Templates</h1><div className="sub">Reusable replies you can insert with <kbd>t</kbd> while drafting. These fill in on insert: ${vars}</div></header>
      <div id="tmpl-body">${bodyInner}</div>
    </div>`;

    const footer = html`<${Fragment}>
      <span className="footer-note" id="tmpl-note" style=${{ marginRight: 'auto' }}>${note}</span>
      <button className="small" id="tmpl-new" onClick=${addRow}>New template</button>
      <button className="primary" id="tmpl-save" disabled=${saving} onClick=${save}>Save changes</button>
    </${Fragment}>`;

    return html`<${C.Shell} footer=${footer}>${body}</${C.Shell}>`;
  };
})();
