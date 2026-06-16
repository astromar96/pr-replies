'use strict';
/* Boot. Fetches GET /state, seeds the snapshot + event stores, connects the SSE
 * stream (session mode only), mounts React, and exposes the imperative window.PRR
 * facade (app.toggleHelp / theme.*) that the Playwright harness and power users
 * rely on. Mirrors the original app.js boot + SSE fan-in. */
(function () {
  const snapshotStore = PRR.stores.snapshot;
  const eventsStore = PRR.stores.events;

  function refetch() {
    return PRR.api.get('state').then(function (fresh) {
      snapshotStore.set(fresh);
      if (fresh.fixing && fresh.fixing.events) eventsStore.seed(fresh.fixing.events);
    }).catch(function () {
      PRR.banner('err', 'Lost connection to the session server. If it was restarted, this page will reconnect automatically.');
    });
  }

  function maybeAutoClose() {
    if (PRR.store.pref('autoclose') === '0') return;
    const snap = snapshotStore.get();
    const errors = (snap && snap.reply && snap.reply.result && snap.reply.result.errors) || [];
    if (snap && snap.phase === 'done' && errors.length === 0) {
      // Browsers only honor window.close() for tabs they opened themselves —
      // exactly how the server launches this page.
      setTimeout(function () { window.close(); }, 1200);
    }
  }

  function onEvent(e) {
    if (e.type === 'hello') {
      const snap = snapshotStore.get();
      if (snap && e.phase !== snap.phase) refetch();
      return;
    }
    if (e.type === 'phase') { refetch(); return; }
    if (e.type === 'session_end') { refetch().then(maybeAutoClose); return; }
    // Per-item live events (fix_*/check/push/drafting/note/post_item/…): append
    // to the event store so the mounted phase view re-derives immediately.
    eventsStore.add(e);
  }

  // ---------- imperative facade (back-compat + harness entry points) ----------
  PRR.app = {
    toggleHelp: function (scope) { PRR.stores.help.toggle(scope); },
    getSnapshot: function () { return snapshotStore.get(); },
  };
  PRR.theme = {
    get: function () { return PRR.stores.theme.get(); },
    set: function (v) { PRR.stores.theme.choose(v); },
    apply: function (v) { PRR.stores.theme.apply(v); },
    cycle: function () { return PRR.stores.theme.cycle(); },
  };
  window.PRR = PRR;

  // ---------- boot ----------
  PRR.api.get('state').then(function (s) {
    snapshotStore.set(s);
    if (s.fixing && s.fixing.events) eventsStore.seed(s.fixing.events);
    PRR.store.init(s.repo ? s.repo.nameWithOwner : 'unknown', s.pr ? s.pr.number : 0);
    // Only a live session has an event stream; the hub (home mode) has none.
    if (s.phase) PRR.connectSse(s.lastSeq, onEvent);
    PRR.ReactDOM.createRoot(document.getElementById('root')).render(PRR.html`<${PRR.App} />`);
  }).catch(function (e) {
    document.getElementById('root').innerHTML =
      '<main class="wrap" id="app"><div class="banner err">Could not load the session: ' +
      PRR.esc(e.message) + ' — is the server still running?</div></main>';
  });
})();
