#!/usr/bin/env node
/**
 * pr-replies session server (v2).
 *
 * One background `serve` process hosts the whole session — triage → fixing →
 * reply — in a single browser tab. The skill blocks per phase with `wait`
 * (re-runnable; always under the Bash timeout) and talks to the server over
 * HTTP via `emit` / `advance` / `stop`. `wait` prints exactly one result
 * block to stdout between sentinels:
 *
 *   ===PR_REPLIES_RESULT===
 *   { "phase": "triage", "status": "submitted", ... }
 *   ===END_PR_REPLIES_RESULT===
 *
 * Everything else goes to stderr.
 *
 * Usage:
 *   server.js serve   --session DIR [--repo-dir PATH] [--start-phase triage|reply]
 *                     [--no-post] [--no-open] [--resume] [--session-timeout-mins N] [--linger-secs N]
 *   server.js wait    --session DIR --phase triage|reply [--timeout-secs N]
 *   server.js emit    --session DIR --type T [--item K] [--sha S] [--summary TXT]
 *                     [--reason TXT] [--name TXT] [--status TXT] [--detail TXT] [--text TXT]
 *   server.js advance --session DIR --phase reply
 *   server.js stop    --session DIR [--cleanup]
 *   server.js suggest [--repo OWNER/REPO] [--repo-dir PATH] [--provider github|gitlab]
 *
 * Exit codes:
 *   serve   — 0 clean end, 1 boot/validation error, 2 session timeout.
 *   wait    — 0 result obtained, 1 bad args / no session.json,
 *             2 wait timeout, 3 server dead.
 *   emit    — 0 delivered, 1 rejected or server unreachable (event saved
 *             locally for the next `serve --resume`).
 *   advance — 0 advanced, 1 validation error, 3 server not running.
 *   stop    — 0 always.
 */
'use strict';

// Fail fast with an actionable message below the supported Node floor, instead
// of a cryptic syntax/`node --test` error deeper in. Keep this above the
// requires so it runs before anything else. Mirrors `engines.node` in package.json.
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  process.stderr.write(`pr-replies requires Node 18 or newer (found ${process.version}). Please upgrade Node.\n`);
  process.exit(1);
}

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { sessionPaths, writeAtomic, readJson, readEvents, appendEvent, isPidAlive } = require('./lib/session');
const { createState } = require('./lib/state');
const { createApp } = require('./lib/httpServer');
const { createProvider, isProviderName } = require('./lib/providers');
const { createDataPlane } = require('./lib/dataPlane');
const { buildSuggestions } = require('./lib/suggest');
const { createHistory } = require('./lib/history');
const store = require('./lib/store');
const git = require('./lib/git');
const { openUrl } = require('./lib/open');
const { loadConfig } = require('./lib/config');

const SENTINEL_START = '===PR_REPLIES_RESULT===';
const SENTINEL_END = '===END_PR_REPLIES_RESULT===';
const PHASES = ['triage', 'reply'];

function logErr(msg) {
  process.stderr.write(`pr-replies: ${msg}\n`);
}

function die(msg) {
  logErr(msg);
  process.exit(1);
}

function printSentinel(obj) {
  process.stdout.write(`\n${SENTINEL_START}\n${JSON.stringify(obj, null, 2)}\n${SENTINEL_END}\n`);
}

// ---------- args ----------
const FLAG_SPECS = {
  serve: { session: 's', home: 'b', 'repo-dir': 's', 'start-phase': 's', provider: 's', host: 's', 'no-post': 'b', 'no-open': 'b', resume: 'b', 'session-timeout-mins': 'n', 'linger-secs': 'n' },
  wait: { session: 's', phase: 's', 'timeout-secs': 'n' },
  emit: { session: 's', type: 's', item: 's', sha: 's', summary: 's', reason: 's', name: 's', status: 's', detail: 's', text: 's' },
  advance: { session: 's', phase: 's' },
  stop: { session: 's', cleanup: 'b' },
  suggest: { repo: 's', 'repo-dir': 's', provider: 's' },
};

// Read-only, history-only helper — no live session, so no --session required.
const SESSIONLESS = new Set(['suggest']);

function parseFlags(cmd, argv) {
  const spec = FLAG_SPECS[cmd];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !(name in spec)) die(`unknown argument for ${cmd}: ${argv[i]}`);
    if (spec[name] === 'b') {
      flags[name] = true;
    } else {
      const val = argv[++i];
      if (val == null) die(`--${name} requires a value`);
      flags[name] = spec[name] === 'n' ? Number(val) : val;
      if (spec[name] === 'n' && !Number.isFinite(flags[name])) die(`--${name} must be a number`);
    }
  }
  if (cmd === 'serve' && flags.home) {
    if (flags.session) die('serve: --home and --session are mutually exclusive');
  } else if (!SESSIONLESS.has(cmd) && !flags.session) {
    die(`${cmd} requires --session DIR`);
  }
  return flags;
}

// ---------- ui ----------
// The React UI ships unbundled: vendored React/ReactDOM/htm UMD bundles run
// first (attaching window.React/ReactDOM/htm), then the app modules attach to
// the shared PRR namespace, then main.js boots. Everything is concatenated into
// one inline <script> at serve time — no build step, same as before. Order
// matters: foundation (h/util/stores/keys/components) → views → App → main.
const VENDOR_SCRIPTS = ['react.production.min.js', 'react-dom.production.min.js', 'htm.umd.js']
  .map((f) => path.join('vendor', f));
const APP_SCRIPTS = [
  'h.js', 'util.js', 'stores.js', 'keys.js', 'components.js',
  'views/triage.js', 'views/progress.js', 'views/reply.js', 'views/final.js',
  'views/history.js', 'views/templates.js',
  'App.js', 'main.js',
].map((f) => path.join('app', f));
const UI_SCRIPTS = [...VENDOR_SCRIPTS, ...APP_SCRIPTS];

function buildHtml() {
  const uiDir = path.join(__dirname, 'ui');
  const shell = fs.readFileSync(path.join(uiDir, 'shell.html'), 'utf8');
  const css = fs.readFileSync(path.join(uiDir, 'ui.css'), 'utf8');
  const js = UI_SCRIPTS.map((f) => fs.readFileSync(path.join(uiDir, f), 'utf8')).join('\n;\n');
  // Function replacement: a plain string would expand $&-style patterns.
  return shell
    .replace('<!--STYLES-->', () => `<style>\n${css}\n</style>`)
    .replace('<!--SCRIPTS-->', () => `<script>\n${js}\n</script>`);
}

// ---------- control-plane client ----------
function postJson(sess, sub, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: sess.port,
        path: `/${sess.token}/${sub}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: timeoutMs,
      },
      (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(out); } catch (_) { parsed = { error: out }; }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

// ---------- serve --home (cross-session hub: history / templates) ----------
async function cmdServeHome(flags) {
  const { config, warnings } = loadConfig();
  for (const w of warnings) logErr(w);

  const homeFile = path.join(store.configDir(), 'home.json');
  const existing = readJson(homeFile);
  if (existing && isPidAlive(existing.pid)) {
    die(`hub already running (pid ${existing.pid}): ${existing.url}`);
  }

  // repoDir lets the hub merge repo-local reply templates (.pr-replies/templates.json).
  const repoDir = flags['repo-dir'] ? path.resolve(flags['repo-dir']) : null;
  const data = createDataPlane({ repoDir, config });
  // Sweep abandoned session dirs (dead pid + old) once on hub start.
  try { const { removed } = data.pruneStale(); if (removed) logErr(`pruned ${removed} stale session dir(s)`); } catch (_) { /* non-fatal */ }
  const clientConfig = {
    signature: config.signature || '',
    autoResolveFixedThreads: config.autoResolveFixedThreads !== false,
    defaultTriageAction: config.defaultTriageAction || null,
    theme: config.theme || 'system',
    agentLabel: config.agentLabel || null,
  };
  const html = buildHtml();
  const token = crypto.randomBytes(16).toString('hex');

  function cleanHome() {
    try {
      const h = readJson(homeFile);
      if (h && h.pid === process.pid) fs.rmSync(homeFile, { force: true });
    } catch (_) { /* ignore */ }
  }

  const app = createApp({
    state: null,
    data,
    snapshot: () => ({ mode: 'home', repo: null, pr: null, config: clientConfig }),
    token,
    html: () => html,
    log: logErr,
    onShutdown: () => { cleanHome(); setTimeout(() => process.exit(0), 200); },
  });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const url = `http://127.0.0.1:${port}/${token}/`;
  fs.mkdirSync(store.configDir(), { recursive: true, mode: 0o700 });
  writeAtomic(homeFile, { version: 1, pid: process.pid, port, token, url, startedAt: new Date().toISOString() });
  logErr(`pr-replies hub: ${url}`);

  if (!flags['no-open']) {
    const ok = await openUrl(url);
    if (!ok) logErr('could not open browser; open the URL above manually');
  }

  // The hub is long-lived: no session timeout, no linger auto-exit.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { cleanHome(); process.exit(130); });
  }
}

// ---------- serve ----------
async function cmdServe(flags) {
  if (flags.home) return cmdServeHome(flags);
  const sessionDir = path.resolve(flags.session);
  // 0700: the session dir holds the URL auth token and private review content
  // under a predictable /tmp path, so keep other local users out.
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const paths = sessionPaths(sessionDir);

  const { config, warnings } = loadConfig();
  for (const w of warnings) logErr(w);

  const existing = readJson(paths.sessionFile);
  if (existing && isPidAlive(existing.pid)) {
    die(`session already running (pid ${existing.pid}): ${existing.url}`);
  }
  if (flags.resume && !existing) die('nothing to resume — no session.json in that dir');
  if (!flags.resume && fs.existsSync(paths.triageResult)) {
    die('session dir already used — pass --resume or use a fresh dir');
  }

  const startPhase = flags['start-phase'] || 'triage';
  if (!PHASES.includes(startPhase)) die('--start-phase must be triage or reply');

  const stateFlags = { noPost: !!flags['no-post'], repoDir: flags['repo-dir'] ? path.resolve(flags['repo-dir']) : null };
  const providerName = flags.provider || 'github';
  if (flags.provider && !isProviderName(providerName)) die(`--provider must be github or gitlab (got ${flags.provider})`);
  const provider = createProvider(providerName, { noPost: stateFlags.noPost, host: flags.host });
  const history = createHistory({
    id: path.basename(sessionDir),
    startedAt: existing && flags.resume ? existing.startedAt : new Date().toISOString(),
    dryRun: stateFlags.noPost,
    historyMax: config.historyMax,
  });
  const state = createState({ sessionDir, flags: stateFlags, config, provider, git, history, log: logErr });

  try {
    if (flags.resume) await state.resume(existing.phase);
    else await state.init({ startPhase });
  } catch (e) {
    die(`${e.message}${e.errors ? '\n  - ' + e.errors.join('\n  - ') : ''}`);
  }

  const html = buildHtml(); // built once; fails fast if ui/ files are missing
  const token = crypto.randomBytes(16).toString('hex');

  let exitTimer = null;
  function scheduleExit(code, secs) {
    if (exitTimer) clearTimeout(exitTimer);
    // Not unref'd: guarantees the explicit exit code even if the loop drains.
    exitTimer = setTimeout(() => process.exit(code), secs * 1000);
  }

  const lingerSecs = flags['linger-secs'] ?? 45;
  const data = createDataPlane({ repoDir: stateFlags.repoDir, config, mode: 'session' });
  const app = createApp({
    state,
    data,
    token,
    html: () => html,
    log: logErr,
    onShutdown: () => {
      if (state.phase === 'done' || state.phase === 'cancelled') scheduleExit(process.exitCode || 0, 0.2);
      else state.stop('stopped');
    },
  });

  let sessionUrl = null;
  function writeSessionFile() {
    const { repo, pr } = state.repoAndPr();
    writeAtomic(paths.sessionFile, {
      version: 2,
      pid: process.pid,
      port: app.server.address().port,
      token,
      url: sessionUrl,
      phase: state.phase,
      abortRequested: state.abortRequested,
      startedAt: existing && flags.resume ? existing.startedAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      repoDir: stateFlags.repoDir,
      flags: { noPost: stateFlags.noPost, startPhase },
      repo,
      pr,
    });
  }

  state.onTerminal((reason) => {
    process.exitCode = reason === 'timeout' ? 2 : 0;
    scheduleExit(process.exitCode, reason === 'stopped' ? 0.5 : lingerSecs);
  });
  state.onChange(() => { if (sessionUrl) writeSessionFile(); });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  sessionUrl = `http://127.0.0.1:${app.server.address().port}/${token}/`;
  writeSessionFile();
  logErr(`pr-replies UI (${state.phase}): ${sessionUrl}`);

  if (!flags['no-open']) {
    const ok = await openUrl(sessionUrl);
    if (!ok) logErr('could not open browser; open the URL above manually');
  }

  const timeoutMins = Math.min(flags['session-timeout-mins'] ?? config.sessionTimeoutMins, 1440);
  const sessionTimer = setTimeout(() => state.stop('timeout'), timeoutMins * 60 * 1000);
  sessionTimer.unref?.();

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      state.stop('cancelled'); // result files written synchronously
      process.exit(130);
    });
  }
}

// ---------- wait ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cmdWait(flags) {
  if (!PHASES.includes(flags.phase)) die('wait requires --phase triage|reply');
  const paths = sessionPaths(path.resolve(flags.session));
  const sess = readJson(paths.sessionFile);
  if (!sess) die(`no session at ${flags.session} — was serve started?`);

  const { config } = loadConfig();
  const timeoutSecs = flags['timeout-secs'] ?? config.waitTimeoutSecs;
  const resultFile = flags.phase === 'triage' ? paths.triageResult : paths.replyResult;
  const base = { phase: flags.phase, repo: sess.repo, pr: sess.pr, url: sess.url };
  logErr(`waiting for ${flags.phase} (UI: ${sess.url})`);

  const deadline = Date.now() + timeoutSecs * 1000;
  for (;;) {
    const result = readJson(resultFile);
    if (result) {
      printSentinel({ ...base, ...result });
      process.exit(0);
    }
    if (!isPidAlive(sess.pid)) {
      // The server may have written the result and exited between our checks.
      await sleep(300);
      const late = readJson(resultFile);
      if (late) {
        printSentinel({ ...base, ...late });
        process.exit(0);
      }
      printSentinel({ ...base, status: 'server_exited' });
      process.exit(3);
    }
    if (Date.now() >= deadline) {
      printSentinel({ ...base, status: 'wait_timeout' });
      process.exit(2);
    }
    await sleep(1000);
  }
}

// ---------- emit ----------
async function cmdEmit(flags) {
  if (!flags.type) die('emit requires --type');
  const sessionDir = path.resolve(flags.session);
  const sess = readJson(sessionPaths(sessionDir).sessionFile);
  if (!sess) die(`no session at ${flags.session}`);

  const body = { type: flags.type };
  for (const f of ['item', 'sha', 'summary', 'reason', 'name', 'status', 'detail', 'text']) {
    if (flags[f] != null) body[f] = flags[f];
  }
  try {
    const res = await postJson(sess, 'control/event', body);
    process.stdout.write(JSON.stringify(res.body) + '\n');
    if (res.statusCode !== 200) {
      logErr(`emit rejected (${res.statusCode}): ${res.body.error || ''}`);
      process.exit(1);
    }
  } catch (e) {
    // Server down: log the event to the file so it survives a --resume.
    const events = readEvents(sessionDir, 0);
    const seq = events.length ? events[events.length - 1].seq + 1 : 1;
    appendEvent(sessionDir, { seq, at: new Date().toISOString(), ...body });
    logErr(`server unreachable (${e.message}) — event saved; run 'serve --resume' before advance`);
    process.stdout.write('{"ok":false,"abort":false}\n');
    process.exit(1);
  }
}

// ---------- advance ----------
async function cmdAdvance(flags) {
  if (flags.phase !== 'reply') die('advance requires --phase reply');
  const sess = readJson(sessionPaths(path.resolve(flags.session)).sessionFile);
  if (!sess) die(`no session at ${flags.session}`);
  try {
    const res = await postJson(sess, 'control/advance', { phase: flags.phase }, 30000);
    if (res.statusCode === 200) {
      process.stdout.write('{"ok":true}\n');
      return;
    }
    logErr(`advance failed (${res.statusCode}): ${res.body.error || ''}`);
    for (const err of res.body.errors || []) logErr(`  - ${err}`);
    process.exit(1);
  } catch (e) {
    logErr(`server not running (${e.message}) — run 'serve --resume' first`);
    process.exit(3);
  }
}

// ---------- stop ----------
async function cmdStop(flags) {
  const sessionDir = path.resolve(flags.session);
  const sess = readJson(sessionPaths(sessionDir).sessionFile);
  if (sess) {
    await postJson(sess, 'control/shutdown', {}, 2000).catch(() => {});
    await sleep(700);
    if (isPidAlive(sess.pid)) {
      try { process.kill(sess.pid, 'SIGTERM'); } catch (_) { /* already gone */ }
    }
  }
  if (flags.cleanup) fs.rmSync(sessionDir, { recursive: true, force: true });
}

// ---------- suggest (triage priors from local history + templates) ----------
async function cmdSuggest(flags) {
  const { config } = loadConfig();
  const out = buildSuggestions({
    repo: flags.repo || null,
    repoDir: flags['repo-dir'] ? path.resolve(flags['repo-dir']) : null,
    provider: flags.provider || null,
    historyMax: config.historyMax,
  });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

// ---------- dispatch ----------
const cmd = process.argv[2];
const commands = { serve: cmdServe, wait: cmdWait, emit: cmdEmit, advance: cmdAdvance, stop: cmdStop, suggest: cmdSuggest };
if (!commands[cmd]) {
  die(`usage: server.js <serve|wait|emit|advance|stop|suggest> [--session DIR] [options] (see file header)`);
}
commands[cmd](parseFlags(cmd, process.argv.slice(3))).catch((e) => die(e.stack || e.message));
