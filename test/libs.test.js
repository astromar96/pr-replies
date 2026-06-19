'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getFixCommit, parseRemoteUrl, classifyHost, detectRemote, detectBranch } = require('../server/lib/git.js');
const { openUrl } = require('../server/lib/open.js');
const { loadConfig, CONFIG_PATH, DEFAULTS } = require('../server/lib/config.js');

// ---------- helpers ----------
function fakeExec(result, { fail = false } = {}) {
  const calls = [];
  const exec = (file, argv) => {
    calls.push({ file, argv });
    return fail ? Promise.reject(new Error('boom')) : Promise.resolve(result);
  };
  return { exec, calls };
}

const TRUNC_RE = /^…diff truncated \((\d+) more lines\) — view locally with: git show (\S+)$/;

// ---------- git ----------
test('git: happy parse splits sha/subject/diff', async () => {
  const out = 'abc1234\nFix the flaky retry loop\n==\n file.js | 2 +-\ndiff --git a/file.js b/file.js\n+added line\n';
  const { exec, calls } = fakeExec(out);
  const res = await getFixCommit({ repoDir: '/repo', sha: 'abc1234def', exec });
  assert.deepEqual(res, {
    sha: 'abc1234',
    subject: 'Fix the flaky retry loop',
    diff: ' file.js | 2 +-\ndiff --git a/file.js b/file.js\n+added line',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'git');
  assert.deepEqual(calls[0].argv, [
    '-C', '/repo',
    'show', '--no-color', '--stat', '--patch',
    '--format=%h%n%s%n==',
    'abc1234def',
  ]);
});

test('git: caps diff at 1500 lines with truncation marker', async () => {
  const body = Array.from({ length: 1600 }, (_, i) => `+line ${i}`).join('\n');
  const { exec } = fakeExec(`abc1234\nsubject\n==\n${body}\n`);
  const res = await getFixCommit({ repoDir: '/repo', sha: 'abc1234def', exec });
  const lines = res.diff.split('\n');
  assert.equal(lines.length, 1501); // 1500 kept + marker
  assert.equal(lines[1499], '+line 1499');
  const m = lines[1500].match(TRUNC_RE);
  assert.ok(m, `marker line mismatch: ${lines[1500]}`);
  assert.equal(m[1], '100');
  assert.equal(m[2], 'abc1234def');
});

test('git: caps diff at 100 KB before the line cap', async () => {
  const body = Array.from({ length: 5 }, () => 'x'.repeat(40000)).join('\n');
  const { exec } = fakeExec(`abc1234\nsubject\n==\n${body}\n`);
  const res = await getFixCommit({ repoDir: '/repo', sha: 'abc1234def', exec });
  const lines = res.diff.split('\n');
  // 40001 bytes/line: two fit under 100 KB, the third would not.
  assert.equal(lines.length, 3);
  const m = lines[2].match(TRUNC_RE);
  assert.ok(m, `marker line mismatch: ${lines[2]}`);
  assert.equal(m[1], '3');
});

test('git: exec error resolves null', async () => {
  const { exec } = fakeExec('', { fail: true });
  assert.equal(await getFixCommit({ repoDir: '/repo', sha: 'deadbeef', exec }), null);
});

test('git: falsy repoDir/sha resolve null without calling exec', async () => {
  const { exec, calls } = fakeExec('');
  assert.equal(await getFixCommit({ repoDir: '', sha: 'deadbeef', exec }), null);
  assert.equal(await getFixCommit({ repoDir: '/repo', sha: null, exec }), null);
  assert.equal(await getFixCommit({ exec }), null);
  assert.equal(calls.length, 0);
});

// ---------- remote detection ----------
test('parseRemoteUrl: scp, https, ssh, token, and nested-group forms', () => {
  assert.deepEqual(parseRemoteUrl('git@github.com:owner/repo.git'), { host: 'github.com', nameWithOwner: 'owner/repo' });
  assert.deepEqual(parseRemoteUrl('https://github.com/owner/repo.git'), { host: 'github.com', nameWithOwner: 'owner/repo' });
  assert.deepEqual(parseRemoteUrl('ssh://git@gitlab.com:22/group/sub/repo.git'), { host: 'gitlab.com', nameWithOwner: 'group/sub/repo' });
  assert.deepEqual(parseRemoteUrl('https://oauth2:tok@gl.acme.dev/group/repo.git'), { host: 'gl.acme.dev', nameWithOwner: 'group/repo' });
  assert.equal(parseRemoteUrl(''), null);
  assert.equal(parseRemoteUrl('not a url'), null);
});

test('classifyHost: github/gitlab incl. self-managed, ambiguous ⇒ null', () => {
  assert.equal(classifyHost('github.com'), 'github');
  assert.equal(classifyHost('gitlab.com'), 'gitlab');
  assert.equal(classifyHost('gitlab.acme.com'), 'gitlab');
  assert.equal(classifyHost('github.acme.com'), 'github');
  assert.equal(classifyHost('git.example.org'), null);
});

test('detectRemote: parses origin and classifies the provider', async () => {
  const exec = (file, argv) => {
    assert.deepEqual(argv, ['-C', '/repo', 'remote', 'get-url', 'origin']);
    return Promise.resolve('git@gitlab.com:group/proj.git\n');
  };
  assert.deepEqual(await detectRemote({ repoDir: '/repo', exec }), {
    provider: 'gitlab', host: 'gitlab.com', nameWithOwner: 'group/proj', remoteUrl: 'git@gitlab.com:group/proj.git',
  });
});

test('detectRemote: no repoDir or a failing git resolves null', async () => {
  assert.equal(await detectRemote({ repoDir: null }), null);
  const exec = () => Promise.reject(new Error('no remote'));
  assert.equal(await detectRemote({ repoDir: '/repo', exec }), null);
});

test('detectBranch: returns the current branch, null on failure', async () => {
  assert.equal(await detectBranch({ repoDir: '/repo', exec: () => Promise.resolve('feat/cache\n') }), 'feat/cache');
  assert.equal(await detectBranch({ repoDir: '/repo', exec: () => Promise.reject(new Error('detached')) }), null);
  assert.equal(await detectBranch({ repoDir: null }), null);
});

// ---------- open ----------
test('open: darwin uses open', async () => {
  const { exec, calls } = fakeExec('');
  assert.equal(await openUrl('http://x/', { platform: 'darwin', exec }), true);
  assert.deepEqual(calls, [{ file: 'open', argv: ['http://x/'] }]);
});

test('open: win32 uses cmd /c start ""', async () => {
  const { exec, calls } = fakeExec('');
  assert.equal(await openUrl('http://x/', { platform: 'win32', exec }), true);
  assert.deepEqual(calls, [{ file: 'cmd', argv: ['/c', 'start', '', 'http://x/'] }]);
});

test('open: linux (and anything else) uses xdg-open', async () => {
  const { exec, calls } = fakeExec('');
  assert.equal(await openUrl('http://x/', { platform: 'linux', exec }), true);
  assert.equal(await openUrl('http://x/', { platform: 'freebsd', exec }), true);
  assert.deepEqual(calls.map((c) => c.file), ['xdg-open', 'xdg-open']);
});

test('open: launch failure resolves false', async () => {
  const { exec } = fakeExec('', { fail: true });
  assert.equal(await openUrl('http://x/', { platform: 'darwin', exec }), false);
});

// ---------- config ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-replies-test-'));
let n = 0;
function writeConfig(contents) {
  const p = path.join(tmp, `config-${n++}.json`);
  fs.writeFileSync(p, contents);
  return p;
}

test('config: CONFIG_PATH and DEFAULTS shape', () => {
  assert.equal(CONFIG_PATH, path.join(os.homedir(), '.config', 'pr-replies', 'config.json'));
  assert.deepEqual(DEFAULTS, {
    signature: '',
    defaultTriageAction: null,
    autoResolveFixedThreads: true,
    sessionTimeoutMins: 120,
    waitTimeoutSecs: 540,
    historyMax: 200,
    theme: 'system',
  });
});

test('config: missing file yields defaults, no warnings', () => {
  const { config, warnings } = loadConfig({ configPath: path.join(tmp, 'does-not-exist.json') });
  assert.deepEqual(config, DEFAULTS);
  assert.deepEqual(warnings, []);
});

test('config: invalid JSON yields defaults plus one warning', () => {
  const { config, warnings } = loadConfig({ configPath: writeConfig('{not json') });
  assert.deepEqual(config, DEFAULTS);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].startsWith('config: '));
});

test('config: signature over 500 chars falls back with warning', () => {
  const { config, warnings } = loadConfig({
    configPath: writeConfig(JSON.stringify({ signature: 'x'.repeat(501) })),
  });
  assert.equal(config.signature, '');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^config: .*signature/);
});

test('config: non-string signature falls back with warning', () => {
  const { config, warnings } = loadConfig({ configPath: writeConfig(JSON.stringify({ signature: 7 })) });
  assert.equal(config.signature, '');
  assert.equal(warnings.length, 1);
});

test('config: defaultTriageAction must be null/fix/reply/skip', () => {
  for (const good of [null, 'fix', 'reply', 'skip']) {
    const { config, warnings } = loadConfig({
      configPath: writeConfig(JSON.stringify({ defaultTriageAction: good })),
    });
    assert.equal(config.defaultTriageAction, good);
    assert.deepEqual(warnings, []);
  }
  const { config, warnings } = loadConfig({
    configPath: writeConfig(JSON.stringify({ defaultTriageAction: 'yolo' })),
  });
  assert.equal(config.defaultTriageAction, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^config: .*defaultTriageAction/);
});

test('config: autoResolveFixedThreads must be boolean', () => {
  const ok = loadConfig({ configPath: writeConfig(JSON.stringify({ autoResolveFixedThreads: false })) });
  assert.equal(ok.config.autoResolveFixedThreads, false);
  assert.deepEqual(ok.warnings, []);
  const bad = loadConfig({ configPath: writeConfig(JSON.stringify({ autoResolveFixedThreads: 'yes' })) });
  assert.equal(bad.config.autoResolveFixedThreads, true);
  assert.equal(bad.warnings.length, 1);
});

test('config: sessionTimeoutMins validated and capped at 1440', () => {
  const capped = loadConfig({ configPath: writeConfig(JSON.stringify({ sessionTimeoutMins: 99999 })) });
  assert.equal(capped.config.sessionTimeoutMins, 1440);
  assert.equal(capped.warnings.length, 1);
  assert.match(capped.warnings[0], /^config: sessionTimeoutMins capped at 1440/);
  for (const bad of [-5, 0, 'soon', null, Infinity]) {
    const { config, warnings } = loadConfig({
      configPath: writeConfig(JSON.stringify({ sessionTimeoutMins: bad })),
    });
    assert.equal(config.sessionTimeoutMins, 120, `value: ${bad}`);
    assert.equal(warnings.length, 1, `value: ${bad}`);
  }
});

test('config: waitTimeoutSecs validated and capped at 3540', () => {
  const capped = loadConfig({ configPath: writeConfig(JSON.stringify({ waitTimeoutSecs: 99999 })) });
  assert.equal(capped.config.waitTimeoutSecs, 3540);
  assert.equal(capped.warnings.length, 1);
  assert.match(capped.warnings[0], /^config: waitTimeoutSecs capped at 3540/);
  const bad = loadConfig({ configPath: writeConfig(JSON.stringify({ waitTimeoutSecs: -1 })) });
  assert.equal(bad.config.waitTimeoutSecs, 540);
  assert.equal(bad.warnings.length, 1);
});

test('config: unknown keys warn by name and are ignored', () => {
  const { config, warnings } = loadConfig({
    configPath: writeConfig(JSON.stringify({ sigature: 'typo', signature: 'ok' })),
  });
  assert.equal(config.signature, 'ok');
  assert.equal('sigature' in config, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^config: .*"sigature"/);
});

test('config: valid full file round-trips with no warnings', () => {
  const full = {
    signature: '\n\n— posted via pr-replies',
    defaultTriageAction: 'reply',
    autoResolveFixedThreads: false,
    sessionTimeoutMins: 60,
    waitTimeoutSecs: 300,
    historyMax: 50,
    theme: 'dark',
  };
  const { config, warnings } = loadConfig({ configPath: writeConfig(JSON.stringify(full)) });
  assert.deepEqual(config, full);
  assert.deepEqual(warnings, []);
});

test('config: historyMax validated and capped at 2000; theme validated', () => {
  const capped = loadConfig({ configPath: writeConfig(JSON.stringify({ historyMax: 99999 })) });
  assert.equal(capped.config.historyMax, 2000);
  assert.equal(capped.warnings.length, 1);
  assert.match(capped.warnings[0], /^config: historyMax capped at 2000/);

  const badTheme = loadConfig({ configPath: writeConfig(JSON.stringify({ theme: 'neon' })) });
  assert.equal(badTheme.config.theme, 'system');
  assert.equal(badTheme.warnings.length, 1);
  assert.match(badTheme.warnings[0], /^config: theme/);
});
