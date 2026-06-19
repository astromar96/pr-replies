#!/usr/bin/env node
'use strict';
/**
 * Visual UI preview + integration gate.
 *
 * Boots the real session server with the bundled example payloads (no GitHub,
 * no Claude, no real PR — same dry-run path as scripts/demo.sh) and drives the
 * UI through every phase with Playwright, screenshotting each one. Then boots
 * the hub (`serve --home`) against a seeded config dir and screenshots the
 * History / Templates routes. Use --headed to watch it live.
 *
 *   node scripts/ui-preview.js            # headless, writes screenshots
 *   node scripts/ui-preview.js --headed   # visible browser, auto-driven
 *   node scripts/ui-preview.js --keep-open # leave browser+server up at the end
 *   node scripts/ui-preview.js --out DIR   # screenshot output dir
 *   node scripts/ui-preview.js --headed --dwell 6  # pause 6s on each phase
 *
 * Because the whole vanilla-JS bundle is concatenated and served, any
 * ReferenceError / load-order regression in a ui/*.js module makes a route
 * throw — which fails this harness. It is the integration test a node --test
 * unit cannot be.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRV = path.join(ROOT, 'server', 'server.js');
const EXAMPLES = path.join(ROOT, 'examples');

function printUsage() {
  process.stderr.write(
    'usage: node scripts/ui-preview.js [--headed] [--keep-open] [--dwell SECONDS] [--out DIR]\n'
  );
}

function parseArgs(argv) {
  const a = { headed: false, keepOpen: false, dwellSecs: null, out: path.join(ROOT, 'test', 'ui', 'screenshots') };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--headed') a.headed = true;
    else if (f === '--keep-open') a.keepOpen = true;
    else if (f === '--dwell') a.dwellSecs = Number(argv[++i]);
    else if (f === '--out') a.out = path.resolve(argv[++i] || '.');
    else if (f === '--help' || f === '-h') { printUsage(); process.exit(0); }
    else { process.stderr.write(`unknown argument: ${f}\n`); printUsage(); process.exit(1); }
  }
  if (a.dwellSecs != null && !Number.isFinite(a.dwellSecs)) { process.stderr.write('--dwell needs a number of seconds\n'); process.exit(1); }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCli(args, opts = {}) {
  const r = spawnSync('node', [SRV, ...args], {
    stdio: ['ignore', 'ignore', opts.quiet ? 'ignore' : 'inherit'],
    env: opts.env || process.env,
  });
  if (r.status !== 0 && !opts.allowFail) {
    process.stderr.write(`  warning: '${args[0]}' exited with code ${r.status}\n`);
  }
  return r;
}

async function waitForFile(file, pick, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      const got = pick(v);
      if (got) return v;
    } catch (_) { /* not written yet */ }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${file}`);
}

// scripts/demo.sh's scripted fix loop, replayed verbatim.
const EMIT_SEQUENCE = [
  ['--type', 'fix_start', '--item', 'review:PRRT_kwDOExample001'],
  ['--type', 'check', '--name', 'npm test', '--status', 'running'],
  ['--type', 'check', '--name', 'npm test', '--status', 'pass'],
  ['--type', 'fix_done', '--item', 'review:PRRT_kwDOExample001', '--sha', 'abc1234', '--summary', 'early return on cache miss'],
  ['--type', 'fix_start', '--item', 'issue:333222111'],
  ['--type', 'fix_done', '--item', 'issue:333222111', '--sha', 'def5678', '--summary', 'changelog entry'],
  ['--type', 'push', '--status', 'ok'],
  ['--type', 'drafting'],
];

// A triage payload tweaked so reviewer-grouping shows two reviewers and the
// assignee datalist has options.
function seedTriagePayload(dest) {
  const pl = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'payload.triage.json'), 'utf8'));
  pl.pr.assignableUsers = ['alice', 'bob', 'reviewer1', 'reviewer2'];
  if (pl.reviewThreads[1] && pl.reviewThreads[1].comments[0]) pl.reviewThreads[1].comments[0].author = 'reviewer2';
  fs.writeFileSync(dest, JSON.stringify(pl, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (_) {
    process.stderr.write(
      '\nThis harness needs Playwright (a dev dependency). One-time setup:\n' +
      '  npm install\n  npx playwright install chromium\n\n'
    );
    process.exit(1);
  }

  fs.mkdirSync(args.out, { recursive: true });

  // Isolated config dir (templates + the history this run writes) — never the
  // developer's real ~/.config/pr-replies.
  const configDir = path.join(os.tmpdir(), 'pr-replies', `preview-cfg-${process.pid}-${Date.now()}`);
  fs.mkdirSync(configDir, { recursive: true });
  fs.copyFileSync(path.join(EXAMPLES, 'templates.json'), path.join(configDir, 'templates.json'));
  const env = Object.assign({}, process.env, { PR_REPLIES_CONFIG_DIR: configDir });

  const session = path.join(os.tmpdir(), 'pr-replies', `preview-${process.pid}-${Date.now()}`);
  fs.mkdirSync(session, { recursive: true });
  seedTriagePayload(path.join(session, 'triage.payload.json'));

  const lingerSecs = args.keepOpen ? 3600 : 600;
  const server = spawn(
    'node',
    [SRV, 'serve', '--session', session, '--repo-dir', ROOT, '--no-post', '--no-open', '--linger-secs', String(lingerSecs)],
    { stdio: ['ignore', 'ignore', 'inherit'], env }
  );
  server.on('error', (e) => process.stderr.write(`failed to start server: ${e.message}\n`));

  const dwellMs = args.headed ? (args.dwellSecs != null ? args.dwellSecs : 4) * 1000 : 0;

  let browser;
  let homeServer = null;
  const saved = [];

  // On tall pages the fixed bottom action bar paints at the first viewport's
  // bottom — i.e. mid-page in a full-page screenshot, overlapping the content
  // behind it. For those shots (`{ tight: true }`) we briefly un-stick the
  // footer so it flows to the true end of the document, and trim the padding
  // the layout reserves for it. Short pages keep the pinned footer (it reads as
  // the normal app chrome), so they pass no option.
  const TIGHT_CSS = 'footer{position:static!important;box-shadow:none!important}.wrap{padding-bottom:28px!important}';
  async function setTight(page, on) {
    await page.evaluate(({ css, on }) => {
      let el = document.getElementById('__shot_tight');
      if (on) {
        if (!el) { el = document.createElement('style'); el.id = '__shot_tight'; document.head.appendChild(el); }
        el.textContent = css;
      } else if (el) { el.remove(); }
    }, { css: TIGHT_CSS, on });
  }

  async function shot(page, name, opts = {}) {
    if (opts.tight) await setTight(page, true);
    const file = path.join(args.out, name);
    await page.screenshot({ path: file, fullPage: true });
    if (opts.tight) await setTight(page, false);
    saved.push(name);
    process.stderr.write(`  saved ${path.relative(ROOT, file)}\n`);
    if (dwellMs) await sleep(dwellMs);
  }

  try {
    const sess = await waitForFile(path.join(session, 'session.json'), (s) => s.url && s.port);
    const pause = args.headed ? 700 : 150;
    const emitGap = args.headed ? 1200 : 120;

    browser = await chromium.launch({ headless: !args.headed, slowMo: args.headed ? 250 : 0 });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(sess.url, { waitUntil: 'domcontentloaded' });

    // ---- triage ----
    process.stderr.write('phase: triage\n');
    await page.waitForSelector('.view header h1', { timeout: 15000 });
    await page.waitForSelector('#submit');
    await sleep(pause);
    await shot(page, '01-triage.png', { tight: true });

    // keyboard-shortcut help overlay
    await page.evaluate(() => window.PRR.app.toggleHelp('triage'));
    await page.waitForSelector('#help:not([hidden]) .help-card');
    await sleep(pause);
    await shot(page, '01b-triage-help.png', { tight: true });
    await page.evaluate(() => window.PRR.app.toggleHelp(false));
    await page.waitForSelector('#help', { state: 'hidden' });

    // group-by reviewer + an assignee
    await page.click('.group-seg label:last-child');
    await page.waitForSelector('.reviewer-group', { timeout: 10000 });
    await page.fill('.card[data-card] input[data-assignee]', 'alice');
    await sleep(pause);
    await shot(page, '01c-triage-grouped-by-reviewer.png', { tight: true });

    // ---- submit triage -> fixing ----
    await page.click('#submit');
    process.stderr.write('phase: fixing\n');
    await page.waitForSelector('#timeline', { timeout: 15000 });

    for (const e of EMIT_SEQUENCE) {
      runCli(['emit', '--session', session, ...e], { env });
      await sleep(emitGap);
    }
    await page.locator('#timeline').getByText('drafting replies', { exact: false }).first()
      .waitFor({ timeout: 10000 });
    await sleep(pause);
    await shot(page, '02-fixing.png');

    // ---- advance -> reply ----
    fs.copyFileSync(path.join(EXAMPLES, 'payload.reply.json'), path.join(session, 'reply.payload.json'));
    runCli(['advance', '--session', session, '--phase', 'reply'], { env });
    process.stderr.write('phase: reply\n');
    await page.waitForSelector('.card .draft-tools', { timeout: 15000 });
    await sleep(pause);
    await shot(page, '03-reply.png', { tight: true });

    // dual reply drafts — pick the Humanized variant on the first card (loads it
    // into the editable draft). The seeded payload.reply.json carries both drafts.
    await page.waitForSelector('.card[data-card] .variants .variant-card', { timeout: 10000 });
    await page.locator('.card[data-card]').first().locator('.variant-card[data-variant="humanized"]').click();
    await sleep(pause);
    await shot(page, '03d-reply-variants.png', { tight: true });

    // assignee + opt-in @-mention on the first reply
    await page.fill('.card[data-card] input[data-assignee]', 'alice');
    await page.check('.card[data-card] input[data-mention]');
    await sleep(pause);
    await shot(page, '03c-reply-assignee.png', { tight: true });

    // insert-template picker (move focus out of the assignee input first — the
    // keyboard layer ignores shortcuts while a field is focused, by design)
    await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
    await page.keyboard.press('j');
    await page.keyboard.press('t');
    await page.waitForSelector('.insert-picker .insert-row', { timeout: 10000 });
    await sleep(pause);
    await shot(page, '07b-template-insert.png', { tight: true });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.insert-picker', { state: 'detached' });

    // markdown preview on the first draft
    await page.locator('.draft-tools button[data-tab="preview"]').first().click();
    await page.waitForSelector('.preview:not([hidden])');
    await sleep(pause);
    await shot(page, '03b-reply-preview.png', { tight: true });

    // stop the done view from auto-closing before we can screenshot it
    const autoclose = page.locator('#autoclose');
    if (await autoclose.count() && await autoclose.isChecked()) await autoclose.uncheck();

    // ---- send replies -> done ----
    await page.click('#submit');
    process.stderr.write('phase: done\n');
    await page.waitForSelector('#close-tab', { timeout: 15000 });
    await sleep(pause);
    await shot(page, '04-done.png');

    // The session has now written a history record into configDir. Stop it so
    // the hub's history list shows it as a finished session.
    runCli(['stop', '--session', session], { quiet: true, allowFail: true, env });
    await sleep(300);

    // ---- hub (serve --home) ----
    process.stderr.write('hub: history / templates\n');
    homeServer = spawn('node', [SRV, 'serve', '--home', '--no-open', '--repo-dir', ROOT], { stdio: ['ignore', 'ignore', 'inherit'], env });
    const home = await waitForFile(path.join(configDir, 'home.json'), (h) => h.url);

    // The hub lands on History.
    await page.goto(home.url + '#/history', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.history-row, .empty-state', { timeout: 15000 });
    await sleep(pause);
    await shot(page, '06-history.png');

    // dark theme (driven exactly as the harness drives toggleHelp)
    await page.evaluate(() => window.PRR.theme.set('dark'));
    await sleep(pause);
    await shot(page, '00-history-dark.png');
    await page.evaluate(() => window.PRR.theme.set('system'));

    const firstRow = page.locator('.history-row').first();
    if (await firstRow.count()) {
      await firstRow.click();
      await page.waitForSelector('.summary-list, .banner', { timeout: 10000 });
      await sleep(pause);
      await shot(page, '06b-history-detail.png');
    }

    await page.goto(home.url + '#/templates', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tmpl-row, .empty-state', { timeout: 15000 });
    await sleep(pause);
    await shot(page, '07-templates.png');

    if (errors.length) throw new Error('page errors during walkthrough:\n  ' + errors.join('\n  '));

    process.stderr.write(`\nDone. ${saved.length} screenshots in ${path.relative(ROOT, args.out)}/\n`);
    for (const n of saved) process.stderr.write(`  - ${n}\n`);

    if (args.keepOpen) {
      process.stderr.write('\n--keep-open: browser and servers left running. Press Ctrl+C to quit.\n');
      await new Promise((resolve) => process.once('SIGINT', resolve));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    runCli(['stop', '--session', session, '--cleanup'], { quiet: true, allowFail: true, env });
    try { if (server) server.kill('SIGTERM'); } catch (_) { /* already gone */ }
    try { if (homeServer) homeServer.kill('SIGTERM'); } catch (_) { /* already gone */ }
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`\nui-preview failed: ${e.message}\n`);
  process.exit(1);
});
