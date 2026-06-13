#!/usr/bin/env node
'use strict';
/**
 * Visual UI preview harness.
 *
 * Boots the real session server with the bundled example payloads (no GitHub,
 * no Claude, no real PR — same dry-run path as scripts/demo.sh) and drives the
 * UI through every phase with Playwright, screenshotting each one. Use --headed
 * to watch the whole walkthrough live instead.
 *
 *   node scripts/ui-preview.js            # headless, writes screenshots
 *   node scripts/ui-preview.js --headed   # visible browser, auto-driven
 *   node scripts/ui-preview.js --keep-open # leave browser+server up at the end
 *   node scripts/ui-preview.js --out DIR   # screenshot output dir
 *   node scripts/ui-preview.js --headed --dwell 6  # pause 6s on each phase
 *
 * Phase transitions are driven exactly as the skill drives them: the browser
 * click POSTs triage/reply, and the `emit`/`advance` server CLI stands in for
 * Claude's side (mirroring scripts/demo.sh).
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

// Run a server.js subcommand (emit / advance / stop). stderr is inherited so
// the server's own log lines surface; stdout (JSON acks) is swallowed.
function runCli(args, opts = {}) {
  const r = spawnSync('node', [SRV, ...args], {
    stdio: ['ignore', 'ignore', opts.quiet ? 'ignore' : 'inherit'],
  });
  if (r.status !== 0 && !opts.allowFail) {
    process.stderr.write(`  warning: '${args[0]}' exited with code ${r.status}\n`);
  }
  return r;
}

async function waitForSession(sessionFile, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      if (s && s.url && s.port) return s;
    } catch (_) { /* not written yet */ }
    await sleep(200);
  }
  throw new Error('server never wrote a session.json with a url — did it fail to boot?');
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
  const session = path.join(os.tmpdir(), 'pr-replies', `preview-${process.pid}-${Date.now()}`);
  fs.mkdirSync(session, { recursive: true });
  fs.copyFileSync(path.join(EXAMPLES, 'payload.triage.json'), path.join(session, 'triage.payload.json'));

  const lingerSecs = args.keepOpen ? 3600 : 600;
  const server = spawn(
    'node',
    [SRV, 'serve', '--session', session, '--repo-dir', ROOT, '--no-post', '--no-open', '--linger-secs', String(lingerSecs)],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );
  server.on('error', (e) => process.stderr.write(`failed to start server: ${e.message}\n`));

  // In headed mode, linger on each phase so it's watchable; default 4s, --dwell overrides.
  const dwellMs = args.headed ? (args.dwellSecs != null ? args.dwellSecs : 4) * 1000 : 0;

  let browser;
  const saved = [];
  // Settle, screenshot, then dwell so the eye (and the PNG) catch the phase.
  async function shot(page, name) {
    const file = path.join(args.out, name);
    await page.screenshot({ path: file, fullPage: true });
    saved.push(name);
    process.stderr.write(`  saved ${path.relative(ROOT, file)}\n`);
    if (dwellMs) await sleep(dwellMs);
  }

  try {
    const sess = await waitForSession(path.join(session, 'session.json'));
    const pause = args.headed ? 700 : 150;
    const emitGap = args.headed ? 1200 : 120;

    browser = await chromium.launch({ headless: !args.headed, slowMo: args.headed ? 250 : 0 });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(sess.url, { waitUntil: 'domcontentloaded' });

    // ---- triage ----
    process.stderr.write('phase: triage\n');
    await page.waitForSelector('.view header h1', { timeout: 15000 });
    await page.waitForSelector('#submit');
    await sleep(pause);
    await shot(page, '01-triage.png');

    // keyboard-shortcut help overlay (drive the app fn directly — layout-agnostic)
    await page.evaluate(() => window.PRR.app.toggleHelp('triage'));
    await page.waitForSelector('#help:not([hidden]) .help-card');
    await sleep(pause);
    await shot(page, '01b-triage-help.png');
    await page.evaluate(() => window.PRR.app.toggleHelp(false));
    await page.waitForSelector('#help', { state: 'hidden' });

    // ---- submit triage -> fixing ----
    await page.click('#submit');
    process.stderr.write('phase: fixing\n');
    await page.waitForSelector('#timeline', { timeout: 15000 });

    for (const e of EMIT_SEQUENCE) {
      runCli(['emit', '--session', session, ...e]);
      await sleep(emitGap);
    }
    await page.locator('#timeline').getByText('drafting replies', { exact: false }).first()
      .waitFor({ timeout: 10000 });
    await sleep(pause);
    await shot(page, '02-fixing.png');

    // ---- advance -> reply ----
    fs.copyFileSync(path.join(EXAMPLES, 'payload.reply.json'), path.join(session, 'reply.payload.json'));
    runCli(['advance', '--session', session, '--phase', 'reply']);
    process.stderr.write('phase: reply\n');
    await page.waitForSelector('.card .draft-tools', { timeout: 15000 });
    await sleep(pause);
    await shot(page, '03-reply.png');

    // markdown preview on the first draft
    await page.locator('.draft-tools button[data-tab="preview"]').first().click();
    await page.waitForSelector('.preview:not([hidden])');
    await sleep(pause);
    await shot(page, '03b-reply-preview.png');

    // stop the done view from auto-closing before we can screenshot it
    const autoclose = page.locator('#autoclose');
    if (await autoclose.count() && await autoclose.isChecked()) await autoclose.uncheck();

    // ---- send replies -> done ----
    await page.click('#submit');
    process.stderr.write('phase: done\n');
    await page.waitForSelector('#close-tab', { timeout: 15000 });
    await sleep(pause);
    await shot(page, '04-done.png');

    process.stderr.write(`\nDone. ${saved.length} screenshots in ${path.relative(ROOT, args.out)}/\n`);
    for (const n of saved) process.stderr.write(`  - ${n}\n`);

    if (args.keepOpen) {
      process.stderr.write('\n--keep-open: browser and server left running. Press Ctrl+C to quit.\n');
      await new Promise((resolve) => process.once('SIGINT', resolve));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    runCli(['stop', '--session', session, '--cleanup'], { quiet: true, allowFail: true });
    try { server.kill('SIGTERM'); } catch (_) { /* already gone */ }
  }
}

main().catch((e) => {
  process.stderr.write(`\nui-preview failed: ${e.message}\n`);
  process.exit(1);
});
