'use strict';
/* React + htm wiring. The vendored UMD bundles (react, react-dom, htm) run
 * first and attach window.React / window.ReactDOM / window.htm; every app
 * module then reads them off the shared PRR namespace. No build step: htm
 * parses the tagged-template markup at runtime into React.createElement calls. */
var PRR = (typeof PRR !== 'undefined' && PRR) || {};

(function () {
  if (!window.React || !window.ReactDOM || !window.htm) {
    throw new Error('pr-replies: React/ReactDOM/htm vendor bundle failed to load');
  }
  var React = window.React;
  PRR.React = React;
  PRR.ReactDOM = window.ReactDOM;
  // html`<div/>` — the JSX-free template tag used throughout the app.
  PRR.html = window.htm.bind(React.createElement);
  // Hook + helper aliases so view files can destructure them locally.
  PRR.hooks = {
    useState: React.useState,
    useEffect: React.useEffect,
    useLayoutEffect: React.useLayoutEffect,
    useRef: React.useRef,
    useMemo: React.useMemo,
    useCallback: React.useCallback,
    useReducer: React.useReducer,
    useSyncExternalStore: React.useSyncExternalStore,
    Fragment: React.Fragment,
  };
  PRR.views = {};       // phase views: triage / fixing / reply
  PRR.routes = {};      // hub routes: dashboard / history / templates (+ pr)
  PRR.components = {};   // shared presentational components
})();
