'use strict';
/* Keyboard layer. A single global keydown dispatches to the active scope's
 * bindings — ported from the original PRR.keys, which is framework-agnostic.
 * Views call keys.register(scope, bindings) + keys.setScope(scope) from an
 * effect. useFocusRing reimplements the j/k card ring as React state so the
 * "focused" class survives reconciliation (the old version toggled DOM classes
 * imperatively, which React would clobber). */
(function () {
  const useState = PRR.hooks.useState;
  const useRef = PRR.hooks.useRef;
  const useEffect = PRR.hooks.useEffect;
  const useMemo = PRR.hooks.useMemo;

  // ---------- scope-based bindings ----------
  PRR.keys = (function () {
    const scopes = {};
    let active = null;
    function register(name, bindings) { scopes[name] = bindings; }
    function setScope(name) { active = name; }
    document.addEventListener('keydown', function (ev) {
      const tag = ev.target && ev.target.tagName;
      const typing = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT';
      let combo = ev.key === ' ' ? 'space' : ev.key.toLowerCase();
      if (ev.metaKey || ev.ctrlKey) combo = 'mod+' + combo;
      if (typing && combo !== 'mod+enter' && combo !== 'escape') return;
      const bindings = (active && scopes[active]) || {};
      const handler = bindings[combo] || (scopes['*'] || {})[combo];
      if (handler) {
        ev.preventDefault();
        handler(ev);
      }
    });
    return { register: register, setScope: setScope };
  })();

  // The card element for a given item key (used by view-level keyboard handlers
  // that need to do imperative things — focus a textarea, toggle a <details>).
  PRR.cardEl = function (key) {
    const sel = '.card[data-card="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]';
    return document.querySelector(sel);
  };

  // ---------- focus ring (j / k over visible cards) ----------
  // The view calls ring.setVisible(keys) every render with the in-order list of
  // currently-visible item keys; ring.focused is the focused key (or null) and
  // is applied as the `focused` class on the matching card by the view.
  PRR.useFocusRing = function () {
    const [focused, setFocused] = useState(null);
    const visibleRef = useRef([]);
    const focusedRef = useRef(null);
    focusedRef.current = focused;

    const api = useMemo(function () {
      return {
        setVisible: function (keys) {
          visibleRef.current = keys;
          // Drop focus if the focused card filtered out from under us.
          if (focusedRef.current && keys.indexOf(focusedRef.current) === -1) setFocused(null);
        },
        move: function (delta) {
          const list = visibleRef.current;
          if (!list.length) return;
          let idx = list.indexOf(focusedRef.current);
          if (idx === -1) idx = delta > 0 ? -1 : 0;
          idx = Math.max(0, Math.min(list.length - 1, idx + delta));
          setFocused(list[idx]);
        },
        currentKey: function () { return focusedRef.current; },
        reset: function () { setFocused(null); },
      };
    }, []);

    useEffect(function () {
      if (!focused) return;
      const el = PRR.cardEl(focused);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [focused]);

    api.focused = focused;
    return api;
  };
})();
